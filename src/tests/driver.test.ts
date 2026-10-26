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
  const counts = { pauses: 0, resumes: 0, applies: 0 };
  return {
    latencyMs: 0,
    verminSeeds,
    counts,
    hasBridge: async () => true,
    readState: async () => makeState({ phase: "waveclear", wave: 2 }),
    apply: async () => {
      counts.applies++;
      return { ok: true, shot: false };
    },
    start: async () => true,
    pause: async () => {
      counts.pauses++;
      return true;
    },
    resume: async () => {
      counts.resumes++;
      return true;
    },
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

describe("Harness async strategy mode", () => {
  const flush = () => new Promise<void>((r) => setImmediate(r));

  function deferred<T>() {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((res) => (resolve = res));
    return { promise, resolve };
  }

  it("fires epoch consultations in the background and never pauses the game", async () => {
    const conn = { ...fakeConn(), readState: async () => makeState() };
    const gate = deferred<unknown>();
    let epochCalls = 0;
    let epochStarts = 0;
    const strategy = {
      tracker: { observe: () => {}, noteShot: () => {} },
      startEpoch: () => {
        epochStarts++;
      },
      epochUpdate: async () => {
        epochCalls++;
        await gate.promise;
        return { ...DEFAULT_EXECUTOR_PARAMS, verminSeed: 4242 };
      },
    };
    const harness = new Harness(
      conn as never,
      new HeuristicPolicy(),
      { event: () => {} } as never,
      opts({ strategyMode: "async" }),
      {},
      strategy as never,
    );
    const h = harness as unknown as { tick(): Promise<void>; epochNeedsStart: boolean; nextStrategyAt: number };
    h.epochNeedsStart = false;
    h.nextStrategyAt = Date.now() - 1000; // epoch expired

    await h.tick();

    assert.equal(conn.counts.pauses, 0, "async mode must never pause the game");
    assert.equal(epochCalls, 1, "the expired epoch fires exactly one background consultation");
    assert.equal(epochStarts, 1, "the next epoch starts collecting immediately");
    assert.ok(
      h.nextStrategyAt > Date.now() + 9000,
      `epoch clock must reset (in ${h.nextStrategyAt - Date.now()}ms)`,
    );
    assert.ok(conn.counts.applies >= 1, "the executor keeps playing on the same tick");

    // the params apply on the first tick after the consultation lands
    gate.resolve(null);
    await flush();
    await h.tick();
    assert.deepEqual(conn.verminSeeds, [4242], "background params must reach the game");
    assert.equal(epochCalls, 1, "no second consultation before the next epoch expires");
  });

  it("does not stack consultations while one is still in flight", async () => {
    const conn = { ...fakeConn(), readState: async () => makeState() };
    const gate = deferred<unknown>();
    let epochCalls = 0;
    const strategy = {
      tracker: { observe: () => {}, noteShot: () => {} },
      startEpoch: () => {},
      epochUpdate: async () => {
        epochCalls++;
        await gate.promise;
        return null;
      },
    };
    const harness = new Harness(
      conn as never,
      new HeuristicPolicy(),
      { event: () => {} } as never,
      opts({ strategyMode: "async" }),
      {},
      strategy as never,
    );
    const h = harness as unknown as { tick(): Promise<void>; epochNeedsStart: boolean; nextStrategyAt: number };
    h.epochNeedsStart = false;
    h.nextStrategyAt = Date.now() - 60000; // long expired

    await h.tick();
    h.nextStrategyAt = Date.now() - 1000; // expire again while the consult runs
    await h.tick();
    await h.tick();
    assert.equal(epochCalls, 1, "ticks while busy must not fire new consultations");

    gate.resolve(null);
    await flush();
    h.nextStrategyAt = Date.now() + 10000; // the expired deadline was not consumed
    await h.tick();
    assert.equal(epochCalls, 1, "a reset clock must not immediately re-fire");
  });

  it("fires the wave re-plan in the background without pausing the intermission", async () => {
    const conn = fakeConn();
    const gate = deferred<unknown>();
    let waveCalls = 0;
    const strategy = {
      tracker: { observe: () => {}, noteShot: () => {} },
      wavePlan: async () => {
        waveCalls++;
        await gate.promise;
        return { ...DEFAULT_EXECUTOR_PARAMS, verminSeed: 777 };
      },
    };
    const harness = new Harness(
      conn as never,
      new HeuristicPolicy(),
      { event: () => {} } as never,
      opts({ strategyMode: "async" }),
      {},
      strategy as never,
    );
    const h = harness as unknown as {
      tick(): Promise<void>;
      handleWavePlan(s: unknown): Promise<void>;
      wavePlanPending: boolean;
      nextStrategyAt: number;
    };
    h.wavePlanPending = true;
    h.nextStrategyAt = Date.now() - 5000;

    await h.handleWavePlan(makeState({ phase: "waveclear", wave: 2 }));

    assert.equal(waveCalls, 1);
    assert.equal(conn.counts.pauses, 0, "async mode must not freeze the intermission");
    assert.ok(
      h.nextStrategyAt > Date.now() + 9000,
      "the epoch clock must reset so no double consultation follows",
    );

    gate.resolve(null);
    await flush();
    assert.deepEqual(conn.verminSeeds, [], "params wait for the next playing tick");
    conn.readState = async () => makeState(); // intermission over, playing again
    await h.tick();
    assert.deepEqual(conn.verminSeeds, [777], "wave params must apply once play resumes");
  });

  it("paused mode still freezes the game around the wave consultation", async () => {
    const conn = fakeConn();
    const strategy = {
      tracker: { observe: () => {}, noteShot: () => {} },
      wavePlan: async () => DEFAULT_EXECUTOR_PARAMS,
    };
    const harness = new Harness(
      conn as never,
      new HeuristicPolicy(),
      { event: () => {} } as never,
      opts({ strategyMode: "paused" }),
      {},
      strategy as never,
    );
    const h = harness as unknown as { handleWavePlan(s: unknown): Promise<void>; wavePlanPending: boolean };
    h.wavePlanPending = true;
    await h.handleWavePlan(makeState({ phase: "waveclear", wave: 2 }));
    assert.equal(conn.counts.pauses, 1, "paused mode must freeze the banner");
    assert.equal(conn.counts.resumes, 1, "and resume it afterwards");
  });

  it("drops stale background params when a new game starts, applies post-mortem tuning when it lands", async () => {
    const conn = fakeConn();
    const gate = deferred<unknown>();
    let started = false;
    const strategy = {
      tracker: { observe: () => {}, noteShot: () => {} },
      postMortem: async () => {
        await gate.promise;
        return { ...DEFAULT_EXECUTOR_PARAMS, verminSeed: 777 };
      },
      openingStrategy: async () => null,
    };
    const harness = new Harness(
      conn as never,
      new HeuristicPolicy(),
      { event: () => {} } as never,
      opts({ strategyMode: "async", maxGames: 3 }),
      {},
      strategy as never,
    );
    const h = harness as unknown as {
      tick(): Promise<void>;
      handleRestart(s: unknown): Promise<void>;
      pendingParams: unknown;
      gamesStarted: number;
    };
    const connStub = conn as unknown as { start: () => Promise<boolean> };
    connStub.start = async () => {
      started = true;
      return true;
    };
    conn.readState = async () => makeState(); // playing state for the ticks
    h.gamesStarted = 1;
    h.pendingParams = { ...DEFAULT_EXECUTOR_PARAMS, verminSeed: 999 }; // stale epoch params

    await h.handleRestart(makeState({ phase: "gameover" }));

    assert.ok(started, "the next game must start without waiting for the post-mortem");
    assert.equal(h.pendingParams, null, "stale epoch params must not leak into the next game");

    gate.resolve(null);
    await flush();
    await h.tick();
    assert.deepEqual(conn.verminSeeds, [777], "post-mortem tuning must apply once it lands");
  });

  it("starts game 1 without waiting for the opening consultation", async () => {
    const conn = fakeConn();
    const gate = deferred<unknown>();
    let started = false;
    let openingCalls = 0;
    const strategy = {
      tracker: { observe: () => {}, noteShot: () => {} },
      lastKnownParams: () => null,
      openingStrategy: async () => {
        openingCalls++;
        await gate.promise;
        return { ...DEFAULT_EXECUTOR_PARAMS, verminSeed: 31337 };
      },
    };
    const harness = new Harness(
      conn as never,
      new HeuristicPolicy(),
      { event: () => {} } as never,
      opts({ strategyMode: "async", maxGames: 3 }),
      {},
      strategy as never,
    );
    const h = harness as unknown as {
      tick(): Promise<void>;
      handleRestart(s: unknown): Promise<void>;
    };
    const connStub = conn as unknown as { start: () => Promise<boolean> };
    connStub.start = async () => {
      started = true;
      return true;
    };
    conn.readState = async () => makeState(); // playing state for the ticks

    await h.handleRestart(makeState({ phase: "title" }));

    assert.equal(openingCalls, 1, "the opening consultation is fired");
    assert.ok(started, "game 1 starts while the model is still thinking");

    gate.resolve(null);
    await flush();
    await h.tick();
    assert.deepEqual(conn.verminSeeds, [31337], "opening params apply mid-play when they land");
  });

  it("opens game 1 on the params the model last played with", async () => {
    const conn = fakeConn();
    const strategy = {
      tracker: { observe: () => {}, noteShot: () => {} },
      lastKnownParams: () => ({ ...DEFAULT_EXECUTOR_PARAMS, verminSeed: 2024 }),
      openingStrategy: async () => null,
    };
    const harness = new Harness(
      conn as never,
      new HeuristicPolicy(),
      { event: () => {} } as never,
      opts({ strategyMode: "async", maxGames: 3 }),
      {},
      strategy as never,
    );
    const h = harness as unknown as { handleRestart(s: unknown): Promise<void> };
    await h.handleRestart(makeState({ phase: "title" }));
    assert.deepEqual(
      conn.verminSeeds,
      [2024],
      "the first game must open on the persisted last-known params",
    );
  });

  it("paused mode still waits for the post-mortem before the next game", async () => {
    const conn = fakeConn();
    let started = false;
    const strategy = {
      tracker: { observe: () => {}, noteShot: () => {} },
      postMortem: async () => ({ ...DEFAULT_EXECUTOR_PARAMS, verminSeed: 777 }),
      openingStrategy: async () => null,
    };
    const harness = new Harness(
      conn as never,
      new HeuristicPolicy(),
      { event: () => {} } as never,
      opts({ strategyMode: "paused", maxGames: 3 }),
      {},
      strategy as never,
    );
    const h = harness as unknown as { handleRestart(s: unknown): Promise<void>; gamesStarted: number };
    const connStub = conn as unknown as { start: () => Promise<boolean> };
    connStub.start = async () => {
      started = true;
      return true;
    };
    h.gamesStarted = 1;
    await h.handleRestart(makeState({ phase: "gameover" }));
    assert.ok(started, "the next game starts after the post-mortem");
    assert.deepEqual(conn.verminSeeds, [777], "paused mode applies post-mortem params directly");
    assert.equal(conn.counts.pauses, 1, "paused mode freezes the game-over screen");
    assert.equal(conn.counts.resumes, 1, "and resumes it afterwards");
  });
});
