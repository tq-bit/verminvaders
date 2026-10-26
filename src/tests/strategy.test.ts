import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  EpochTracker,
} from "../driver/epoch-tracker.ts";
import {
  extractNotesPrefix,
  normalizeParams,
  parseStrategyResponse,
} from "../driver/strategy-params.ts";
import { systemPrompt } from "../prompts/system-prompt.ts";
import { StrategyController } from "../driver/strategy-controller.ts";
import type { MistralClient } from "../llm/mistral-client.ts";
import { HeuristicPolicy } from "../policy/heuristic.ts";
import { DEFAULT_EXECUTOR_PARAMS } from "../constants/index.ts";
import { makeState } from "./make-state.ts";

// The strict response schema the controller sends to the API.
const responseSchema = JSON.parse(
  readFileSync(fileURLToPath(new URL("../driver/strategy-response.schema.json", import.meta.url)), "utf-8"),
) as {
  properties: { params: { properties: Record<string, unknown>; required: string[] } };
  required: string[];
};

describe("strategy response schema", () => {
  it("requires exactly the executor params, in the right types", () => {
    const props = Object.keys(responseSchema.properties.params.properties).sort();
    assert.deepEqual(props, Object.keys(DEFAULT_EXECUTOR_PARAMS).sort());
    assert.deepEqual([...responseSchema.properties.params.required].sort(), props);
  });

  it("requires the full strategy response shape", () => {
    assert.deepEqual(responseSchema.required, ["params", "notes", "memory", "gameSummary"]);
  });
});

// Fake chat client: returns canned JSON and records the last user payload.
class FakeClient {
  lastPayload = "";
  lastOpts: Record<string, unknown> | null = null;
  answer = JSON.stringify({
    params: {},
    notes: "tuned",
    gameSummary: "avoid the left wall, chew nothing",
    memory: { clean: true },
  });

  async chat(messages: Array<{ role: string; content: string }>, opts: Record<string, unknown> = {}): Promise<string> {
    this.lastPayload = messages[1].content;
    this.lastOpts = opts;
    return this.answer;
  }
}

// Streams the canned answer in text chunks, like the real SSE client.
class StreamingFakeClient extends FakeClient {
  async chat(
    messages: Array<{ role: string; content: string }>,
    opts: Record<string, unknown> = {},
    onDelta?: (kind: "thinking" | "text", text: string) => void,
  ): Promise<string> {
    const answer = await super.chat(messages, opts);
    if (typeof onDelta === "function") {
      const answer2 = answer as string;
      for (const chunk of [answer2.slice(0, 40), answer2.slice(40, 80), answer2.slice(80)]) {
        if (chunk) onDelta("text", chunk);
      }
    }
    return answer;
  }
}

// Each chat() call blocks until release(): mimics a slow, streaming LLM call.
class GatedFakeClient extends FakeClient {
  starts = 0;
  private waiters: Array<() => void> = [];

  release(): void {
    this.waiters.shift()?.();
  }

  override async chat(
    messages: Array<{ role: string; content: string }>,
    opts: Record<string, unknown> = {},
  ): Promise<string> {
    this.starts++;
    await new Promise<void>((r) => this.waiters.push(r));
    return super.chat(messages, opts);
  }
}

describe("normalizeParams", () => {
  it("keeps sane values and clamps out-of-range ones", () => {
    const p = normalizeParams({
      roombaFirst: false,
      lowestRowWeight: 3,
      pointsWeight: 99,
      shieldPenalty: 2000,
      chewShields: false,
      dodgeHorizonS: 0.4,
      acceptHitBelowS: 9,
      corridorMarginPx: 12,
    });
    assert.equal(p.roombaFirst, false);
    assert.equal(p.lowestRowWeight, 3);
    assert.equal(p.pointsWeight, 10); // clamped
    assert.equal(p.shieldPenalty, 2000);
    assert.equal(p.chewShields, false);
    assert.equal(p.dodgeHorizonS, 0.4);
    assert.equal(p.acceptHitBelowS, 0.5); // clamped
    assert.equal(p.corridorMarginPx, 12);
  });

  it("falls back to defaults on garbage input", () => {
    const p = normalizeParams(null);
    assert.equal(p.pointsWeight, 0.5);
    assert.equal(p.shieldPenalty, 1000);
    assert.equal(p.columnSpreadWeight, 0);
    const garbage = normalizeParams({ lowestRowWeight: "many", chewShields: 1 });
    assert.equal(garbage.lowestRowWeight, 1);
    assert.equal(garbage.chewShields, true);
  });
});

describe("parseStrategyResponse", () => {
  it("parses a clean JSON answer", () => {
    const r = parseStrategyResponse(
      '{"params":{"roombaFirst":false},"notes":"careful play","memory":{"lesson":"shields hurt"}}',
    );
    assert.ok(r);
    assert.equal(r.params.roombaFirst, false);
    assert.equal(r.notes, "careful play");
    assert.deepEqual(r.memory, { lesson: "shields hurt" });
  });

  it("recovers JSON wrapped in prose", () => {
    const r = parseStrategyResponse(
      'Sure! Here is my strategy:\n{"params":{},"notes":"ok","memory":{}}\nGood luck!',
    );
    assert.ok(r);
    assert.equal(r.notes, "ok");
  });

  it("reads the gameSummary field from post-mortem answers", () => {
    const r = parseStrategyResponse(
      '{"params":{},"notes":"n","memory":{},"gameSummary":"keep wide margins"}',
    );
    assert.ok(r);
    assert.equal(r.gameSummary, "keep wide margins");
    assert.equal(parseStrategyResponse('{"params":{},"notes":"","memory":{}}')?.gameSummary, "");
  });

  it("returns null on unparseable text", () => {
    assert.equal(parseStrategyResponse("I refuse to answer."), null);
  });

  it("fills and clamps the structured lever arrays", () => {    const p = normalizeParams({
      rowWeights: [3, 99, -4], // padded, clamped to 0..10
      colAvoid: "not an array", // falls back to all zeros
      livesRisk: [10], // padded with the neutral default
      exploration: 99,
      aimJitterPx: -1,
      travelCost: 42,
      rngSeed: "bogus",
      verminSeed: 42.7,
    });
    assert.deepEqual(p.rowWeights, [3, 10, 0, 1, 1]);
    assert.deepEqual(p.colAvoid, [0, 0, 0, 0, 0, 0, 0, 0]);
    assert.deepEqual(p.livesRisk, [10, 5, 5]);
    assert.equal(p.exploration, 10);
    assert.equal(p.aimJitterPx, 0);
    assert.equal(p.travelCost, 10);
    assert.equal(p.rngSeed, 0);
    assert.equal(p.verminSeed, 42, "vermin seed kept and truncated");
    assert.equal(normalizeParams({ verminSeed: "nope" }).verminSeed, -1, "garbage seed = unseeded");
    assert.equal(normalizeParams({ verminSeed: -9 }).verminSeed, -1, "negative seeds clamp to unseeded");
  });
});

describe("extractNotesPrefix", () => {
  it("returns nothing until the notes value has started streaming", () => {
    assert.equal(extractNotesPrefix('{"params":{"pointsWeight":4'), "");
    assert.equal(extractNotesPrefix('{"params":{},"notes":'), "");
    assert.equal(extractNotesPrefix('{"params":{},"notes":"'), "");
  });

  it("returns the notes-so-far from a partially streamed value", () => {
    assert.equal(
      extractNotesPrefix('{"params":{},"notes":"camp the left wall, che'),
      "camp the left wall, che",
    );
  });

  it("decodes escapes and stops at the closing quote", () => {
    assert.equal(
      extractNotesPrefix('{"params":{},"notes":"row one\\nrow two \\"quoted\\" done","memory":{}}'),
      'row one\nrow two "quoted" done',
    );
  });

  it("decodes unicode escapes and keeps a cut-off escape for later", () => {
    assert.equal(extractNotesPrefix('{"notes":"caf\\u00e9"}'), "café");
    assert.equal(extractNotesPrefix('{"notes":"cut \\'), "cut ");
  });
});

describe("StrategyController per-game summaries and limits", () => {
  const tmpFile = path.join(os.tmpdir(), `vv-strategy-test-${process.pid}.json`);

  async function newController(fake: FakeClient, contextGames: number, maxMemoryGames: number) {
    const ctrl = new StrategyController(
      fake as unknown as MistralClient,
      tmpFile,
      {},
      "",
      { contextGames, maxMemoryGames },
    );
    await ctrl.load();
    return ctrl;
  }

  it("stores a per-game summary and trims the games list to maxMemoryGames", async () => {
    await rm(tmpFile, { force: true });
    const fake = new FakeClient();
    const ctrl = await newController(fake, 5, 3);
    for (let i = 1; i <= 5; i++) {
      await ctrl.postMortem(makeState({ score: i * 100 }), i);
    }
    const saved = JSON.parse(await readFile(tmpFile, "utf-8"));
    assert.equal(saved.games.length, 3); // trimmed from 5 to 3
    assert.equal(saved.games[2].score, 500);
    assert.equal(saved.games[2].summary, "avoid the left wall, chew nothing");
    assert.deepEqual(saved.memory, { clean: true }); // cleaned memory persisted
    await rm(tmpFile, { force: true });
  });

  it("post-mortem returns the params tuned for the next game", async () => {
    await rm(tmpFile, { force: true });
    const fake = new FakeClient();
    fake.answer = JSON.stringify({
      params: { verminSeed: 4242, dodgeHorizonS: 1.2 },
      notes: "next game plan",
      memory: {},
    });
    const ctrl = await newController(fake, 5, 3);
    const params = await ctrl.postMortem(makeState({ score: 100 }), 1);
    assert.equal(params?.verminSeed, 4242);
    assert.equal(params?.dodgeHorizonS, 1.2);
    await rm(tmpFile, { force: true });
  });

  it("lastKnownParams warm-starts a new session on the model's last params", async () => {    await rm(tmpFile, { force: true });
    const fake = new FakeClient();
    const ctrl = await newController(fake, 5, 3);
    assert.equal(ctrl.lastKnownParams(), null, "a fresh brain has no last-known params");

    fake.answer = JSON.stringify({
      params: { rngSeed: 1, dodgeHorizonS: 1.0 },
      notes: "first game",
      memory: {},
    });
    await ctrl.postMortem(makeState({ score: 100 }), 1);
    fake.answer = JSON.stringify({
      params: { rngSeed: 2, dodgeHorizonS: 1.5 },
      notes: "second game",
      memory: {},
    });
    await ctrl.postMortem(makeState({ score: 200 }), 2);

    const latest = ctrl.lastKnownParams();
    assert.equal(latest?.rngSeed, 2, "the newest game's params win");
    assert.equal(latest?.dodgeHorizonS, 1.5);

    // the next session must find them after loading the persisted memory
    const nextSession = await newController(new FakeClient(), 5, 3);
    assert.equal(nextSession.lastKnownParams()?.rngSeed, 2, "params persist across sessions");
    assert.equal(nextSession.lastKnownParams()?.dodgeHorizonS, 1.5);
    await rm(tmpFile, { force: true });
  });

  it("limits previous games in prompts to contextGames", async () => {
    await rm(tmpFile, { force: true });
    const fake = new FakeClient();
    const ctrl = await newController(fake, 2, 10);
    for (let i = 1; i <= 4; i++) {
      await ctrl.postMortem(makeState({ score: i }), i);
    }
    // the last call saw the last 2 games (3, 4) plus its own record (4th call)
    assert.ok(fake.lastPayload.includes('"score":4'));
    assert.ok(fake.lastPayload.includes('"score":3'));
    assert.ok(!fake.lastPayload.includes('"score":2'), "older games must be excluded");
    await rm(tmpFile, { force: true });
  });

  it("opening consultation sends memory + past games and returns tuned params", async () => {
    await rm(tmpFile, { force: true });
    const fake = new FakeClient();
    fake.answer = JSON.stringify({
      params: { roombaFirst: false, dodgeHorizonS: 1.2 },
      notes: "opening tuned",
      memory: { lessons: ["chew early"] },
    });
    const ctrl = await newController(fake, 5, 10);
    await ctrl.postMortem(makeState({ score: 700 }), 1);
    fake.lastPayload = "";
    const params = await ctrl.openingStrategy(makeState());
    assert.equal(params?.roombaFirst, false);
    assert.equal(params?.dodgeHorizonS, 1.2);
    assert.ok(fake.lastPayload.includes("A new session is starting."));
    assert.ok(fake.lastPayload.includes('"lessons"'), "persisted memory must be sent");
    assert.ok(fake.lastPayload.includes('"score":700'), "past games must be sent");
    await rm(tmpFile, { force: true });
  });

  it("sends the env-configured max tokens to the client", async () => {
    await rm(tmpFile, { force: true });
    const fake = new FakeClient();
    const ctrl = await newController(fake, 5, 10);
    const prev = process.env.VERMINVADERS_MAX_TOKENS;
    process.env.VERMINVADERS_MAX_TOKENS = "999";
    try {
      await ctrl.openingStrategy(makeState());
      assert.equal(fake.lastOpts?.maxTokens, 999);
      process.env.VERMINVADERS_MAX_TOKENS = "";
      await ctrl.openingStrategy(makeState());
      assert.equal(fake.lastOpts?.maxTokens, 15000, "empty value must fall back to the default");
    } finally {
      if (prev === undefined) delete process.env.VERMINVADERS_MAX_TOKENS;
      else process.env.VERMINVADERS_MAX_TOKENS = prev;
    }
    await rm(tmpFile, { force: true });
  });

  it("streams notes-so-far to onAnswerDelta and passes the post-mortem plan to onStrategy", async () => {
    await rm(tmpFile, { force: true });
    const fake = new StreamingFakeClient();
    fake.answer = JSON.stringify({
      params: {},
      notes: "camp the left wall, chew nothing",
      gameSummary: "keep wide margins",
      memory: {},
    });
    const deltas: string[] = [];
    const plans: Array<{ notes: string; nextGame?: string }> = [];
    const ctrl = new StrategyController(
      fake as unknown as MistralClient,
      tmpFile,
      {
        onAnswerDelta: (text) => deltas.push(text),
        onStrategy: (notes, _params, nextGame) => plans.push({ notes, nextGame }),
      },
      "",
      { contextGames: 1, maxMemoryGames: 2 },
    );
    await ctrl.load();
    await ctrl.epochUpdate(makeState());
    assert.ok(deltas.length >= 1, "notes-so-far must reach onAnswerDelta");
    assert.ok(deltas[deltas.length - 1].startsWith("camp the left wall"));
    assert.equal(plans.length, 1);
    assert.equal(plans[0].notes, "camp the left wall, chew nothing");
    assert.equal(plans[0].nextGame, "keep wide margins");
    await rm(tmpFile, { force: true });
  });

  it("wave re-plan sends the cleared wave and returns tuned params", async () => {
    await rm(tmpFile, { force: true });
    const fake = new FakeClient();
    fake.answer = JSON.stringify({
      params: { dodgeHorizonS: 1.2 },
      notes: "next wave: camp left",
      memory: { plan: "left camp" },
    });
    const ctrl = await newController(fake, 5, 10);
    fake.lastPayload = "";
    const params = await ctrl.wavePlan(makeState({ wave: 3 }));
    assert.equal(params?.dodgeHorizonS, 1.2);
    assert.ok(fake.lastPayload.includes("Wave 3 cleared"), "the cleared wave must be named");
    assert.ok(fake.lastPayload.includes('"wave":3'), "the state must be sent");
    await rm(tmpFile, { force: true });
  });

  it("names the current round in every payload and archives each round's strategy at the post-mortem", async () => {
    await rm(tmpFile, { force: true });
    const fake = new FakeClient();
    // the round-1 strategy the model currently has in memory
    fake.answer = JSON.stringify({
      params: { dodgeHorizonS: 1.0 },
      notes: "round 1 tuning",
      memory: { round1: { baseline: "camp left", history: ["wave 1 died"] } },
    });
    const ctrl = await newController(fake, 5, 10);
    ctrl.beginGame(1);
    ctrl.startEpoch(makeState());
    await ctrl.epochUpdate(makeState());
    assert.ok(fake.lastPayload.includes('"game":1'), "payloads must name the round");

    // post-mortem: the round-1 strategy is archived with the record, the
    // cleaned memory becomes the live one for round 2
    fake.answer = JSON.stringify({
      params: { dodgeHorizonS: 1.5 },
      notes: "cleaned for round 2",
      gameSummary: "died wave 1, widen margins",
      memory: { lessons: ["dodge earlier"] },
    });
    await ctrl.postMortem(makeState({ score: 480, lives: 0 }), 1);

    const saved = JSON.parse(await readFile(tmpFile, "utf-8"));
    assert.equal(saved.memory.lessons.length, 1, "live memory is the cleaned one");
    assert.deepEqual(
      saved.games[0].strategy,
      { round1: { baseline: "camp left", history: ["wave 1 died"] } },
      "the round's strategy must be archived with its record",
    );
    assert.equal(saved.games[0].summary, "died wave 1, widen margins");

    // round 2: payloads name the new round and the archive is sent separately
    ctrl.beginGame(2);
    ctrl.startEpoch(makeState({ wave: 2 }));
    fake.lastPayload = "";
    await ctrl.epochUpdate(makeState({ wave: 2 }));
    assert.ok(fake.lastPayload.includes('"game":2'), "the new round must be named");
    assert.ok(fake.lastPayload.includes('"round1"'), "the archived round-1 strategy rides along");
    assert.ok(fake.lastPayload.includes('"epoch":1'), "the epoch counter restarts per round");
    await rm(tmpFile, { force: true });
  });

  it("dumps the raw response to diagnostic.txt when parsing fails", async () => {
    const dir = path.join(os.tmpdir(), `vv-diag-test-${process.pid}`);
    await rm(dir, { recursive: true, force: true });
    const fake = new FakeClient();
    fake.answer = "I refuse to answer in JSON.";
    const errors: string[] = [];
    const ctrl = new StrategyController(
      fake as unknown as MistralClient,
      path.join(dir, "memory.json"),
      { onLlmError: (m) => errors.push(m) },
    );
    await ctrl.load();
    const params = await ctrl.openingStrategy(makeState());
    assert.equal(params, null); // parse failure keeps the current params
    assert.ok(errors.some((m) => m.includes("unparseable")));
    const diag = await readFile(path.join(dir, "diagnostic.txt"), "utf-8");
    assert.ok(diag.includes("I refuse to answer in JSON."), "the raw response must be dumped");
    assert.ok(diag.includes("unparseable strategy response:"), "entries must be timestamped and labeled");
    await rm(dir, { recursive: true, force: true });
  });

  it("serializes overlapping consultations: the second waits for the first", async () => {
    await rm(tmpFile, { force: true });
    const fake = new GatedFakeClient();
    fake.answer = JSON.stringify({
      params: { dodgeHorizonS: 1.2 },
      notes: "tuned",
      memory: { first: true },
    });
    const ctrl = new StrategyController(
      fake as unknown as MistralClient,
      tmpFile,
      {},
      "",
      { contextGames: 1, maxMemoryGames: 2 },
    );
    await ctrl.load();

    const flush = () => new Promise<void>((r) => setImmediate(r));
    // the controller persists memory between consultations (real fs I/O), so
    // poll the call counter instead of assuming a fixed number of flushes
    const until = async (cond: () => boolean) => {
      for (let i = 0; i < 100 && !cond(); i++) await flush();
    };
    const epochP = ctrl.epochUpdate(makeState()); // in flight, not awaited
    await until(() => fake.starts === 1);
    const waveP = ctrl.wavePlan(makeState({ wave: 2 })); // overlaps
    await flush();
    assert.equal(fake.starts, 1, "the second consultation must wait for the first");

    fake.release(); // first finishes; the queued second starts
    await until(() => fake.starts === 2);
    assert.equal(fake.starts, 2, "the second consultation starts after the first");
    fake.release();
    await Promise.all([epochP, waveP]);

    const saved = JSON.parse(await readFile(tmpFile, "utf-8"));
    assert.deepEqual(saved.memory, { first: true }, "both answers processed in order");
    await rm(tmpFile, { force: true });
  });

  it("tells the model the game keeps playing when strategy mode is async", async () => {
    await rm(tmpFile, { force: true });
    const pausedClient = new FakeClient();
    const pausedCtrl = new StrategyController(
      pausedClient as unknown as MistralClient,
      tmpFile,
      {},
      "",
      { contextGames: 1, maxMemoryGames: 2 },
      false,
    );
    await pausedCtrl.load();
    await pausedCtrl.epochUpdate(makeState());
    assert.ok(!pausedClient.lastPayload.includes("keeps playing"), "paused mode keeps the old instruction");

    const asyncClient = new FakeClient();
    const asyncCtrl = new StrategyController(
      asyncClient as unknown as MistralClient,
      tmpFile,
      {},
      "",
      { contextGames: 1, maxMemoryGames: 2 },
      true,
    );
    await asyncCtrl.load();
    await asyncCtrl.epochUpdate(makeState());
    assert.ok(
      asyncClient.lastPayload.includes("keeps playing while you reason"),
      "async mode must tell the model play continues",
    );
    await asyncCtrl.wavePlan(makeState({ wave: 2 }));
    assert.ok(
      asyncClient.lastPayload.includes("already marching while you reason"),
      "async wave plans must carry the urgency note",
    );
    await rm(tmpFile, { force: true });
  });
});

describe("systemPrompt style directive", () => {
  it("always carries the static survival-and-score goal", () => {
    const p = systemPrompt();
    assert.ok(p.includes("GOAL (static, non-negotiable"), "the static goal must always be present");
    assert.ok(p.includes("WITHOUT losing the game"));
    assert.ok(p.includes("never lose' first, then toward 'score more'"));
  });

  it("includes the operator directive when a style is given, below the GOAL", () => {
    const p = systemPrompt("reckless: chase points, accept risks");
    assert.ok(p.includes("OPERATOR DIRECTIVE (high priority; the static GOAL still outranks it): reckless"));
    assert.ok(p.indexOf("GOAL (static") < p.indexOf("OPERATOR DIRECTIVE"), "the GOAL comes first");
  });

  it("omits the directive section without a style", () => {
    const p = systemPrompt();
    assert.ok(!p.includes("OPERATOR DIRECTIVE"));
  });
});

describe("EpochTracker", () => {
  it("resets the epoch counter per game", () => {
    const t = new EpochTracker();
    t.reset(makeState(), Date.now()); // epoch 1
    t.reset(makeState(), Date.now()); // epoch 2
    t.beginGame(); // new game
    t.reset(makeState(), Date.now()); // epoch 1 of the new game
    const report = t.report(makeState(), Date.now());
    assert.equal(report.epoch, 1, "a new game's first epoch must report as epoch 1");
  });

  it("reports epoch deltas and events", () => {
    const t = new EpochTracker();
    const s0 = makeState();
    t.reset(s0, Date.now() - 10000);
    t.noteShot();
    t.noteShot();
    const s1 = makeState({ score: 30, lives: 2 });
    t.observe(s0, s1);
    const report = t.report(s1, Date.now());
    assert.equal(report.epoch, 1);
    assert.equal(report.shotsFired, 2);
    assert.equal(report.hits, 1);
    assert.equal(report.livesEnd, 2);
    assert.ok(report.events.some((e) => e.includes("life lost")));
  });

  it("tracks glide distance, direction reversals and decision reasons", () => {
    const t = new EpochTracker();
    const base = makeState();
    t.reset(base, Date.now());
    const at = (x: number) => makeState({ cat: { ...base.cat, x } });
    const x0 = base.cat.x; // 240
    // right 20, right 20 (no reversal), left 30 (reversal), +2 wiggle (ignored)
    t.observe(base, at(x0 + 20), "reposition");
    t.observe(at(x0 + 20), at(x0 + 40), "shoot-rodent");
    t.observe(at(x0 + 40), at(x0 + 10), "dodge");
    t.observe(at(x0 + 10), at(x0 + 12), "dodge");
    const report = t.report(at(x0 + 12), Date.now());
    assert.equal(report.catDistancePx, 72);
    assert.equal(report.catDirectionChanges, 1);
    assert.deepEqual(report.decisionReasons, { reposition: 1, "shoot-rodent": 1, dodge: 2 });
  });

  it("flags an unintercepted roomba", () => {
    const t = new EpochTracker();
    const s0 = makeState({ roomba: { x: 100, y: 52, vx: 95, points: 200 } });
    t.reset(s0, Date.now());
    const s1 = makeState({ roomba: null });
    t.observe(s0, s1);
    const report = t.report(s1, Date.now());
    assert.ok(report.events.some((e) => e.includes("roomba crossed")));
  });

  it("counts fired crumbs and maps them to spawn columns", () => {
    const t = new EpochTracker();
    const s0 = makeState();
    t.reset(s0, Date.now());
    // spawn x for column 3, mouse (w=30): gx + 3*44 + 15 - 5 = 194
    const s1 = makeState({ crumbs: [{ x: 194, y: 150, w: 10, h: 10, vy: 144 }] });
    t.observe(s0, s1);
    const s2 = makeState({
      crumbs: [{ x: 194, y: 165, w: 10, h: 10, vy: 144 }], // same crumb, fell
    });
    t.observe(s1, s2);
    const report = t.report(s2, Date.now());
    assert.equal(report.crumbsFired, 1); // not double counted
    assert.equal(report.crumbSpawnCols[3], 1);
    assert.ok(report.events.some((e) => e.includes("crumb fired from column 3")));
  });

  it("counts near misses just outside the hitbox", () => {
    const t = new EpochTracker();
    const s0 = makeState(); // cat at 240
    t.reset(s0, Date.now());
    // crumb center 45px from the cat center: 15px outside the +/-30 hitbox
    const s1 = makeState({ crumbs: [{ x: 280, y: 505, w: 10, h: 10, vy: 144 }] });
    t.observe(s0, s1);
    const report = t.report(s1, Date.now());
    assert.equal(report.nearMisses, 1);
    assert.ok(report.events.some((e) => e.includes("near miss")));
  });
});

describe("HeuristicPolicy with executor params", () => {
  it("setParams changes targeting behavior", () => {
    const withRoomba = new HeuristicPolicy();
    const s = makeState({ roomba: { x: 240, y: 52, vx: 95, points: 200 } });
    assert.ok(withRoomba.decide(s).moveTo !== undefined);

    const noRoomba = new HeuristicPolicy({ roombaFirst: false });
    const d = noRoomba.decide(s);
    // falls back to rodents: aim point differs from the roomba lead
    assert.notEqual(noRoomba.lastReason, "shoot-roomba");
    assert.ok(d.moveTo !== undefined || d.shoot !== undefined);
  });

  it("chewShields=false holds fire instead of chewing", () => {
    // wall of shields: every corridor blocked
    const shields = [0, 60, 120, 180, 240, 300, 360, 420].map((x) => ({
      x,
      y: 392,
      w: 60,
      h: 30,
      cellsLeft: 16,
    }));
    const p = new HeuristicPolicy({ chewShields: false });
    const s = makeState({ shields, cat: { ...makeState().cat, x: 240 } });
    p.decide(s); // may reposition
    const d = p.decide(s);
    assert.ok(d.shoot === undefined || p.lastReason !== "chew-shield");
  });
});
