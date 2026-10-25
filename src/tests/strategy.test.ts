import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  EpochTracker,
  normalizeParams,
  parseStrategyResponse,
} from "../driver/strategy.ts";
import { HeuristicPolicy } from "../policy/heuristic.ts";
import { makeState } from "./make-state.ts";

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

  it("returns null on unparseable text", () => {
    assert.equal(parseStrategyResponse("I refuse to answer."), null);
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
