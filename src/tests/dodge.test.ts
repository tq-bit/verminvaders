import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { planDodge, threateningCrumbs } from "../policy/dodge.ts";
import { makeState } from "./make-state.ts";

function crumbAt(x: number, y: number, vy = 144) {
  return { x, y, w: 10, h: 10, vy };
}

describe("threateningCrumbs", () => {
  it("flags a crumb that overlaps the cat hitbox corridor", () => {
    const s = makeState({ crumbs: [crumbAt(235, 400)] }); // cat at 240, +/- 30
    const t = threateningCrumbs(s);
    assert.equal(t.length, 1);
    assert.ok(t[0].tti > 0.5 && t[0].tti < 1);
  });

  it("ignores crumbs outside the x corridor", () => {
    const s = makeState({ crumbs: [crumbAt(120, 400)] });
    assert.equal(threateningCrumbs(s).length, 0);
  });

  it("ignores threats while invulnerable", () => {
    const s = makeState({ crumbs: [crumbAt(235, 400)], invuln: 1.5 });
    assert.equal(threateningCrumbs(s).length, 0);
  });

  it("ignores crumbs that an intact shield will absorb", () => {
    const s = makeState({
      crumbs: [crumbAt(235, 380)],
      shields: [{ x: 200, y: 392, w: 60, h: 30, cellsLeft: 12 }],
    });
    // threatening by position, but absorbed in planDodge
    assert.equal(planDodge(s), null);
  });
});

describe("planDodge", () => {
  it("dodges a falling crumb when there is time and space", () => {
    const s = makeState({ crumbs: [crumbAt(235, 380)] });
    const dodge = planDodge(s);
    assert.notEqual(dodge, null);
    assert.notEqual(dodge, undefined);
    // destination must clear the crumb's corridor: cat at dodge, hitbox +/-30,
    // crumb spans 235..245 -> unsafe for dodge in (205, 275)
    const d = dodge as number;
    assert.ok(d <= 205 || d >= 275, `expected corridor exit, got ${d}`);
  });

  it("accepts the hit when the crumb is closer than 0.25 s", () => {
    const s = makeState({ crumbs: [crumbAt(235, 490)] }); // ~0.09 s to impact
    assert.equal(planDodge(s), null);
  });

  it("picks the nearest safe corridor, not a random one", () => {
    const s = makeState({ crumbs: [crumbAt(235, 380), crumbAt(150, 360)] });
    const dodge = planDodge(s);
    assert.notEqual(dodge, null);
    assert.ok((dodge as number) > 240 || Math.abs((dodge as number) - 240) < Math.abs(150 - 240));
  });

  it("returns null when no crumbs threaten", () => {
    assert.equal(planDodge(makeState()), null);
  });
});
