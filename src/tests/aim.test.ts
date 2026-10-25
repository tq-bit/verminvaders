import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  clampCatX,
  corridorBlocked,
  flightTime,
  glideTime,
  marchIntervalFor,
  predictFormationX,
} from "../policy/aim.ts";
import { makeRods, makeState } from "./make-state.ts";

describe("flightTime", () => {
  it("matches the 1.09 s Roomba flight time from the spec", () => {
    assert.ok(Math.abs(flightTime(52) - 1.088) < 0.01);
  });

  it("is zero for targets at or below the muzzle", () => {
    assert.equal(flightTime(520), 0);
    assert.equal(flightTime(600), 0);
  });
});

describe("clampCatX and glideTime", () => {
  it("clamps to the 36..444 movement range", () => {
    assert.equal(clampCatX(0), 36);
    assert.equal(clampCatX(999), 444);
  });

  it("glides at 322 px/s", () => {
    assert.ok(Math.abs(glideTime(100, 422) - 1) < 1e-9);
  });
});

describe("marchIntervalFor", () => {
  it("is 0.5 s for a full wave-1 formation", () => {
    assert.ok(Math.abs(marchIntervalFor(makeState()) - 0.5) < 1e-9);
  });

  it("scales with alive rodents and bottoms out at 0.06 s", () => {
    const s = makeState({ rods: makeRods().slice(0, 10) });
    assert.ok(Math.abs(marchIntervalFor(s) - 0.5 * (10 / 40)) < 1e-9);
    const tiny = makeState({ rods: makeRods().slice(0, 2), wave: 10 });
    // floor applies before the wave factor: 0.06 * 0.55
    assert.ok(marchIntervalFor(tiny) >= 0.06 * 0.55 - 1e-9);
  });
});

describe("predictFormationX", () => {
  it("advances 12 px per march step in the direction of travel", () => {
    const s = makeState();
    // nextMarchIn 0.25 s, interval 0.5 s: exactly one step within 0.5 s
    assert.equal(predictFormationX(s, 0.5), 52 + 12);
    assert.equal(predictFormationX(s, 0.24), 52); // step not due yet
  });

  it("reverses at the right wall without changing x", () => {
    // formation far right: maxX = gx + 7*44 + 36 = gx + 344, wall at 472
    const s = makeState({ formation: { ...makeState().formation, x: 128, dir: 1, nextMarchIn: 0 } });
    assert.equal(predictFormationX(s, 0.1), 128); // wall: drop, no x move
  });

  it("reverses at the left wall without changing x", () => {
    const s = makeState({ formation: { ...makeState().formation, x: 8, dir: -1, nextMarchIn: 0 } });
    assert.equal(predictFormationX(s, 0.1), 8);
  });
});

describe("corridorBlocked", () => {
  it("blocks shots through an intact shield above the target depth", () => {
    const s = makeState({
      shields: [{ x: 100, y: 392, w: 50, h: 30, cellsLeft: 16 }],
    });
    assert.equal(corridorBlocked(s, 125, 100), true);
    assert.equal(corridorBlocked(s, 60, 100), false);
  });

  it("ignores destroyed shields and counts chewed holes as free", () => {
    const s = makeState({
      shields: [{ x: 100, y: 392, w: 50, h: 30, cellsLeft: 0 }],
    });
    assert.equal(corridorBlocked(s, 125, 100), false);
    const intact = makeState({
      shields: [{ x: 100, y: 392, w: 50, h: 30, cellsLeft: 16 }],
    });
    assert.equal(corridorBlocked(intact, 125, 100, [130]), false);
  });

  it("does not block shots at targets below the shield band", () => {
    const s = makeState({
      shields: [{ x: 100, y: 392, w: 50, h: 30, cellsLeft: 16 }],
    });
    assert.equal(corridorBlocked(s, 125, 440), false);
  });
});
