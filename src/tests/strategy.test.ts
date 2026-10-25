import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  EpochTracker,
} from "../driver/epoch-tracker.ts";
import {
  normalizeParams,
  parseStrategyResponse,
} from "../driver/strategy-params.ts";
import { systemPrompt } from "../driver/strategy-prompt.ts";
import { StrategyController } from "../driver/strategy-controller.ts";
import type { MistralClient } from "../llm/mistral-client.ts";
import { HeuristicPolicy } from "../policy/heuristic.ts";
import { makeState } from "./make-state.ts";

// Fake chat client: returns canned JSON and records the last user payload.
class FakeClient {
  lastPayload = "";
  answer = JSON.stringify({
    params: {},
    notes: "tuned",
    gameSummary: "avoid the left wall, chew nothing",
    memory: { clean: true },
  });

  async chat(messages: Array<{ role: string; content: string }>): Promise<string> {
    this.lastPayload = messages[1].content;
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
