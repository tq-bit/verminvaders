import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Harness } from "../driver/driver.ts";
import { HeuristicPolicy } from "../policy/heuristic.ts";
import { DEFAULT_EXECUTOR_PARAMS } from "../constants/index.ts";
import type { RunOptions } from "../types/index.d.ts";
import { makeState } from "./make-state.ts";

// Fake connection: a stand-in for the Playwright-backed Connection.
function fakeConn() {
  const verminSeeds: number[] = [];
  return {
    latencyMs: 0,
    verminSeeds,
    hasBridge: async () => true,
    readState: async () => makeState({ phase: "waveclear", wave: 2 }),
    apply: async () => ({ ok: true, shot: false }),
    start: async () => true,
    pause: async () => true,
    resume: async () => true,
    stopInputs: async () => {},
    setVerminSeed: async (n: number) => {
      verminSeeds.push(n);
    },
  };
}

function opts(over: Partial<RunOptions> = {}): RunOptions {
  return { mode: "realtime", pollMs: 80, maxGames: 1, epochMs: 10000, logLevel: "silent", ...over };
}

describe("Harness wave planning", () => {
  it("consults the strategist once per wave and resets the epoch clock", async () => {
    const conn = fakeConn();
    let waveCalls = 0;
    const strategy = {
      tracker: { observe: () => {}, noteShot: () => {} },
      wavePlan: async () => {
        waveCalls++;
        return DEFAULT_EXECUTOR_PARAMS;
      },
    };
    const harness = new Harness(
      conn as never,
      new HeuristicPolicy(),
      { event: () => {} } as never,
      opts(),
      {},
      strategy as never,
    );

    const h = harness as unknown as { wavePlanPending: boolean; nextStrategyAt: number };
    h.wavePlanPending = true;
    h.nextStrategyAt = Date.now() - 5000; // epoch expired during the intermission

    await (harness as unknown as { handleWavePlan(s: unknown): Promise<void> }).handleWavePlan(
      makeState({ phase: "waveclear", wave: 2 }),
    );

    assert.equal(waveCalls, 1, "exactly one consultation during the intermission");
    assert.equal(h.wavePlanPending, false);
    // the epoch clock must be pushed back past the deadline that expired,
    // so no second consultation fires on the first playing tick
    assert.ok(
      h.nextStrategyAt > Date.now() + 9000,
      `epoch clock not reset (nextStrategyAt in ${h.nextStrategyAt - Date.now()}ms)`,
    );

    // a second tick during the same intermission must not consult again
    await (harness as unknown as { handleWavePlan(s: unknown): Promise<void> }).handleWavePlan(
      makeState({ phase: "waveclear", wave: 2 }),
    );
    assert.equal(waveCalls, 1, "the pending flag gates repeat consultations");
  });

  it("skips epoch updates entirely when no epoch length is configured", async () => {
    const conn = { ...fakeConn(), readState: async () => makeState() };
    let epochCalls = 0;
    const strategy = {
      tracker: { observe: () => {}, noteShot: () => {} },
      startEpoch: () => {
        throw new Error("must not start an epoch");
      },
      epochUpdate: async () => {
        epochCalls++;
        return null;
      },
    };
    const harness = new Harness(
      conn as never,
      new HeuristicPolicy(),
      { event: () => {} } as never,
      opts({ epochMs: undefined }),
      {},
      strategy as never,
    );
    for (let i = 0; i < 3; i++) {
      await (harness as unknown as { tick(): Promise<void> }).tick();
    }
    assert.equal(epochCalls, 0, "per-wave mode must not consult mid-wave");
  });

  it("keeps the epoch clock untouched when there is no strategist", async () => {
    const conn = fakeConn();
    const harness = new Harness(conn as never, new HeuristicPolicy(), { event: () => {} } as never, opts(), {}, null);
    const h = harness as unknown as { wavePlanPending: boolean; nextStrategyAt: number };
    h.wavePlanPending = true;
    h.nextStrategyAt = Date.now() - 5000;
    await (harness as unknown as { handleWavePlan(s: unknown): Promise<void> }).handleWavePlan(
      makeState({ phase: "waveclear", wave: 2 }),
    );
    assert.ok(h.nextStrategyAt < Date.now(), "no strategist: clock is untouched");
  });

  it("forwards the tuned vermin seed to the game with the params", async () => {
    const conn = fakeConn();
    const strategy = {
      tracker: { observe: () => {}, noteShot: () => {} },
      wavePlan: async () => ({ ...DEFAULT_EXECUTOR_PARAMS, verminSeed: 4242 }),
    };
    const harness = new Harness(
      conn as never,
      new HeuristicPolicy(),
      { event: () => {} } as never,
      opts(),
      {},
      strategy as never,
    );
    const h = harness as unknown as { wavePlanPending: boolean };
    h.wavePlanPending = true;
    await (harness as unknown as { handleWavePlan(s: unknown): Promise<void> }).handleWavePlan(
      makeState({ phase: "waveclear", wave: 2 }),
    );
    assert.deepEqual(conn.verminSeeds, [4242], "the vermin seed must reach the game");
  });

  it("applies the post-mortem params to the next game", async () => {
    const conn = fakeConn();
    const strategy = {
      tracker: { observe: () => {}, noteShot: () => {} },
      postMortem: async () => ({ ...DEFAULT_EXECUTOR_PARAMS, verminSeed: 777 }),
      openingStrategy: async () => null,
    };
    const harness = new Harness(
      conn as never,
      new HeuristicPolicy(),
      { event: () => {} } as never,
      opts({ maxGames: 3 }),
      {},
      strategy as never,
    );
    const h = harness as unknown as { gamesStarted: number };
    h.gamesStarted = 1; // one game played, one game over
    await (harness as unknown as { handleRestart(s: unknown): Promise<void> }).handleRestart(
      makeState({ phase: "gameover" }),
    );
    assert.deepEqual(conn.verminSeeds, [777], "post-mortem seed must reach the game");
  });
});
