import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Harness } from "../driver/driver.ts";
import { HeuristicPolicy } from "../policy/heuristic.ts";
import { DEFAULT_EXECUTOR_PARAMS } from "../constants/index.ts";
import type { RunOptions } from "../types/index.d.ts";
import { makeState } from "./make-state.ts";

// Fake connection: a stand-in for the Playwright-backed Connection.
function fakeConn() {
  return {
    latencyMs: 0,
    hasBridge: async () => true,
    readState: async () => makeState({ phase: "waveclear", wave: 2 }),
    apply: async () => ({ ok: true, shot: false }),
    start: async () => true,
    pause: async () => true,
    resume: async () => true,
    stopInputs: async () => {},
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
});
