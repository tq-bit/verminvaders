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

  it("fills and clamps the structured lever arrays", () => {
    const p = normalizeParams({
      rowWeights: [3, 99, -4], // padded, clamped to 0..10
      colAvoid: "not an array", // falls back to all zeros
      livesRisk: [10], // padded with the neutral default
      exploration: 99,
      aimJitterPx: -1,
      travelCost: 42,
      rngSeed: "bogus",
    });
    assert.deepEqual(p.rowWeights, [3, 10, 0, 1, 1]);
    assert.deepEqual(p.colAvoid, [0, 0, 0, 0, 0, 0, 0, 0]);
    assert.deepEqual(p.livesRisk, [10, 5, 5]);
    assert.equal(p.exploration, 10);
    assert.equal(p.aimJitterPx, 0);
    assert.equal(p.travelCost, 10);
    assert.equal(p.rngSeed, 0);
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
      assert.equal(fake.lastOpts?.maxTokens, 12000, "empty value must fall back to the default");
    } finally {
      if (prev === undefined) delete process.env.VERMINVADERS_MAX_TOKENS;
      else process.env.VERMINVADERS_MAX_TOKENS = prev;
    }
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
});

describe("systemPrompt style directive", () => {
  it("includes the operator directive when a style is given", () => {
    const p = systemPrompt("reckless: chase points, accept risks");
    assert.ok(p.includes("OPERATOR DIRECTIVE (highest priority): reckless"));
  });

  it("omits the directive section without a style", () => {
    const p = systemPrompt();
    assert.ok(!p.includes("OPERATOR DIRECTIVE"));
  });
});

describe("EpochTracker", () => {
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
