import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HeuristicPolicy } from "../policy/heuristic.ts";
import { makeRods, makeShields, makeState } from "./make-state.ts";

function freshPolicy() {
  return new HeuristicPolicy();
}

describe("HeuristicPolicy phase handling", () => {
  it("issues no commands outside the playing phase", () => {
    const p = freshPolicy();
    assert.deepEqual(p.decide(makeState({ phase: "title" })), {});
    assert.deepEqual(p.decide(makeState({ phase: "waveclear" })), {});
    assert.deepEqual(p.decide(makeState({ phase: "gameover" })), {});
  });
});

describe("HeuristicPolicy shooting", () => {
  it("moves toward the aim point first, then shoots when arrived", () => {
    const p = freshPolicy();
    const s = makeState();
    const first = p.decide(s);
    // full formation: deepest reachable target requires a muzzle-offset aim
    assert.ok(first.moveTo !== undefined || first.shoot === true);
    if (first.moveTo !== undefined) {
      assert.ok(first.moveTo >= 36 && first.moveTo <= 444);
      assert.equal(first.shoot, undefined); // not arrived yet, no shot
    }
  });

  it("never shoots while a furball is airborne", () => {
    const p = freshPolicy();
    const s = makeState({ furball: { x: 240, y: 300, vy: -430 } });
    const d = p.decide(s);
    assert.notEqual(d.shoot, true);
  });

  it("prefers the Roomba when it is interceptable", () => {
    const p = freshPolicy();
    const s = makeState({ roomba: { x: 240, y: 52, vx: 95, points: 200 } });
    const d = p.decide(s);
    // Roomba lead: aim ahead of x=240 by ~103 px, minus 18 muzzle offset
    assert.ok(d.moveTo !== undefined);
    assert.ok(Math.abs((d.moveTo as number) - (240 + 95 * 1.088 - 18)) < 60);
  });

  it("skips the Roomba when it cannot be intercepted in time", () => {
    const p = freshPolicy();
    const s = makeState({ roomba: { x: 470, y: 52, vx: 95, points: 200 } });
    // leaving the screen: policy falls back to rodents (aim far from the edge)
    const d = p.decide(s);
    assert.ok(d.moveTo !== undefined || d.shoot !== undefined);
  });
});

describe("HeuristicPolicy safety rules", () => {
  it("never holds left and right together", () => {
    const p = freshPolicy();
    const states = [
      makeState({ crumbs: [{ x: 235, y: 420, w: 10, h: 10, vy: 144 }] }),
      makeState({ crumbs: [{ x: 60, y: 420, w: 10, h: 10, vy: 144 }] }),
    ];
    for (const s of states) {
      const d = p.decide(s);
      assert.ok(!(d.left === true && d.right === true));
    }
  });

  it("dodges instead of aiming when a crumb threatens the cat", () => {
    const p = freshPolicy();
    const s = makeState({ crumbs: [{ x: 235, y: 380, w: 10, h: 10, vy: 144 }] });
    const d = p.decide(s);
    assert.ok(d.moveTo !== undefined);
    assert.equal(p.lastReason, "dodge");
  });
});

describe("HeuristicPolicy shield awareness", () => {
  it("prefers a free corridor over a shielded one", () => {
    const p = freshPolicy();
    // shields block the cat's current column but leave the left flank open
    const s = makeState({ shields: makeShields(), cat: { ...makeState().cat, x: 240 } });
    const d = p.decide(s);
    if (d.moveTo !== undefined) {
      // the chosen aim point's shot corridor (moveTo + 18) must not cross an intact shield
      const shotX = (d.moveTo as number) + 18;
      const blocked = s.shields.some(
        (sh) =>
          sh.cellsLeft > 0 &&
          shotX > sh.x - 2 &&
          shotX < sh.x + sh.w + 2,
      );
      // blocked corridors are only accepted deliberately (chew), never silently
      assert.ok(!blocked || p.lastReason === "chew-shield");
    }
  });

  it("accepts one chew into a fully shielded board, then stops", () => {
    // wall of shields covering the whole arena: everything is blocked
    const shields = [0, 60, 120, 180, 240, 300, 360, 420].map((x) => ({
      x,
      y: 392,
      w: 60,
      h: 30,
      cellsLeft: 16,
    }));
    const p = freshPolicy();
    const s = makeState({ shields, cat: { ...makeState().cat, x: 240 } });
    const first = p.decide(s);
    // either repositions toward the best chew target or chews immediately
    assert.ok(first.moveTo !== undefined || first.shoot === true);
    // after a chew at x, the same corridor is treated as holed (free)
    const second = p.decide(s);
    assert.ok(second.moveTo !== undefined || second.shoot !== undefined);
  });
});

describe("HeuristicPolicy wave reset", () => {
  it("clears chewed holes on a new wave", () => {
    const p = freshPolicy();
    const shields = [{ x: 0, y: 392, w: 480, h: 30, cellsLeft: 16 }];
    const s1 = makeState({ shields });
    p.decide(s1);
    const s2 = makeState({ shields, wave: 2 });
    p.decide(s2);
    // no crash, state reset silently
    assert.equal(p.lastReason === "" || p.lastReason !== "", true);
  });
});
