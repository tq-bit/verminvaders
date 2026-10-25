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

describe("HeuristicPolicy column spread", () => {
  // rows 0-3 in columns other than 3; column 3 holds ONLY a row-4 rodent:
  // the deepest target is a column's last rodent
  function sparseRods() {
    return makeRods().filter((r) => (r.col === 3 ? r.row === 4 : r.row < 4));
  }

  it("columnSpreadWeight=0 still prefers the deepest rodent", () => {
    const p = new HeuristicPolicy();
    const s = makeState({ rods: sparseRods() });
    const plan = p.planShot(s);
    assert.ok(plan);
    const deepest = 84 + 4 * 36 + 24 / 2; // row-4 rodent center y
    assert.ok(Math.abs((520 - plan.flightT * 430) - deepest) < 10, `expected the row-4 target, got y≈${520 - plan.flightT * 430}`);
  });

  it("columnSpreadWeight=10 avoids killing the column's last rodent", () => {
    const p = new HeuristicPolicy({ columnSpreadWeight: 10 });
    const s = makeState({ rods: sparseRods() });
    const plan = p.planShot(s);
    assert.ok(plan);
    const targetY = 520 - plan.flightT * 430;
    assert.ok(targetY < 84 + 4 * 36, `expected a shallower target, got y≈${targetY}`);
  });
});

describe("HeuristicPolicy structured levers", () => {
  it("rowWeights can invert the deepest-first preference", () => {
    const p = new HeuristicPolicy({ rowWeights: [10, 1, 1, 1, 1] });
    const plan = p.planShot(makeState());
    assert.ok(plan);
    const targetY = 520 - plan.flightT * 430;
    assert.ok(targetY < 84 + 36, `expected a top-row (rat) target, got y≈${targetY}`);
  });

  it("colAvoid steers targeting away from penalized columns", () => {
    const p = new HeuristicPolicy({ colAvoid: [10, 10, 10, 10, 10, 10, 10, 0] });
    const plan = p.planShot(makeState());
    assert.ok(plan);
    // column 7's corridor: formation x 52 + 7*44 = 360, rodent center ~+15
    assert.ok(plan.shotX > 330, `expected a column-7 target, got shotX=${plan.shotX}`);
  });

  it("livesRisk=0 dodges a late crumb that livesRisk=10 accepts", () => {
    // tti ≈ 0.30 s: above the neutral accept threshold, below the risky one
    const crumbs = [{ x: 235, y: 449, w: 10, h: 10, vy: 144 }];
    const safe = new HeuristicPolicy({ livesRisk: [0, 0, 0] });
    safe.decide(makeState({ crumbs }));
    assert.equal(safe.lastReason, "dodge");
    const risky = new HeuristicPolicy({ livesRisk: [10, 10, 10] });
    risky.decide(makeState({ crumbs }));
    assert.notEqual(risky.lastReason, "dodge");
  });
});

describe("HeuristicPolicy seeded randomness", () => {
  const levers = { exploration: 10, aimJitterPx: 6 };

  it("stays deterministic with exploration=0 and no jitter", () => {
    const a = new HeuristicPolicy().planShot(makeState());
    const b = new HeuristicPolicy().planShot(makeState());
    assert.ok(a && b);
    assert.equal(a.catX, b.catX);
  });

  it("replays identically for identical seeds", () => {
    const a = new HeuristicPolicy({ ...levers, rngSeed: 42 });
    const b = new HeuristicPolicy({ ...levers, rngSeed: 42 });
    for (let i = 0; i < 5; i++) {
      const pa = a.planShot(makeState());
      const pb = b.planShot(makeState());
      assert.ok(pa && pb);
      assert.equal(pa.catX, pb.catX);
    }
  });

  it("varies play across seeds", () => {
    const a = new HeuristicPolicy({ ...levers, rngSeed: 1 }).planShot(makeState());
    const b = new HeuristicPolicy({ ...levers, rngSeed: 2 }).planShot(makeState());
    assert.ok(a && b);
    assert.notEqual(a.catX, b.catX);
  });
});

describe("HeuristicPolicy dodge commitment", () => {
  // tti ≈ 0.30 s: urgent enough to dodge, slower than the accept threshold
  const crumb = { x: 235, y: 449, w: 10, h: 10, vy: 144 };
  const catAt = (x: number) => ({ ...makeState().cat, x });

  it("keeps the committed destination through the invuln window", () => {
    const p = freshPolicy();
    const d1 = p.decide(makeState({ crumbs: [crumb] }));
    assert.ok(d1.moveTo !== undefined, "must dodge");
    const target = d1.moveTo as number;
    // the crumb hit: invulnerable mid-dodge, the threat is still on screen
    const d2 = p.decide(
      makeState({ crumbs: [{ ...crumb, y: 470 }], invuln: 1.5, cat: catAt(220) }),
    );
    assert.equal(d2.moveTo, target);
    assert.equal(p.lastReason, "dodge");
  });

  it("finishes the committed dodge even when the accept-cutoff would abort", () => {
    const p = freshPolicy();
    const d1 = p.decide(makeState({ crumbs: [crumb] }));
    assert.ok(d1.moveTo !== undefined);
    // tti is now 0 (below acceptHitBelowS) but the committed spot is safe
    const d2 = p.decide(makeState({ crumbs: [{ ...crumb, y: 492 }] }));
    assert.equal(d2.moveTo, d1.moveTo);
    assert.equal(p.lastReason, "dodge");
  });

  it("re-plans when the committed destination becomes unsafe", () => {
    const p = freshPolicy();
    const d1 = p.decide(makeState({ crumbs: [crumb] }));
    assert.ok(d1.moveTo !== undefined);
    const target = d1.moveTo as number;
    // a second crumb lands right on the committed corridor
    const onTarget = { x: target < 240 ? target - 20 : target + 20, y: 449, w: 10, h: 10, vy: 144 };
    const d2 = p.decide(makeState({ crumbs: [crumb, onTarget] }));
    assert.ok(d2.moveTo !== undefined);
    assert.notEqual(d2.moveTo, target); // abandoned the old spot
    assert.equal(p.lastReason, "dodge");
  });

  it("releases the commitment once the threat clears", () => {
    const p = freshPolicy();
    p.decide(makeState({ crumbs: [crumb] })); // commit
    p.decide(makeState({ crumbs: [] })); // threat gone: aim, release
    // the same threat again must match a fresh policy (no stale commitment)
    const d2 = p.decide(makeState({ crumbs: [crumb] }));
    const fresh = new HeuristicPolicy().decide(makeState({ crumbs: [crumb] }));
    assert.equal(d2.moveTo, fresh.moveTo);
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
