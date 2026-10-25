// Crumb threat detection and safe-corridor search (spec section 6, Dodging).

import type { Crumb, DodgeParams, GameState, Threat } from "../types/index.d.ts";
import {
  CAT_GLIDE_SPEED,
  CAT_HALF_WIDTH,
  CAT_HIT_TOP,
  CAT_MAX_X,
  CAT_MIN_X,
  CAT_Y,
  DEFAULT_DODGE_PARAMS,
  SHIELD_Y,
} from "../constants/index.ts";
import { clampCatX } from "./aim.ts";

// A crumb threatens the cat if its x-range overlaps cat.x +/- 30 while invuln
// is 0 and the crumb will actually reach the cat (not absorbed by a shield).
export function threateningCrumbs(s: GameState, horizonS = DEFAULT_DODGE_PARAMS.horizonS): Threat[] {
  if (s.invuln > 0) return [];
  const threats: Threat[] = [];
  for (const c of s.crumbs) {
    if (c.y > CAT_Y) continue; // already past
    const tti = (CAT_HIT_TOP - (c.y + c.h)) / c.vy;
    if (tti < -0.1 || tti > horizonS) continue; // far away, or already below the band
    if (c.x + c.w <= s.cat.x - CAT_HALF_WIDTH || c.x >= s.cat.x + CAT_HALF_WIDTH) continue;
    threats.push({ crumb: c, tti });
  }
  return threats;
}

// Crumbs likely to be absorbed by an intact shield on their way down are not
// threats: a shield with cells in the crumb's column will chew it at y 392.
function absorbedByShield(s: GameState, c: Crumb): boolean {
  if (c.y > SHIELD_Y + 20) return false;
  for (const sh of s.shields) {
    if (sh.cellsLeft < 4) continue; // too eroded to trust
    if (c.x + c.w > sh.x && c.x < sh.x + sh.w && c.y < SHIELD_Y) return true;
  }
  return false;
}

// Every crumb still above the cat band that is not absorbed by a shield —
// the hazard set for destination validation. Unlike threateningCrumbs this
// ignores where the cat stands: a destination corridor is unsafe no matter
// how far away its crumb spawned.
export function fallingCrumbs(s: GameState): Crumb[] {
  return s.crumbs.filter((c) => c.y < CAT_Y && !absorbedByShield(s, c));
}

// x-corridor overlap between a crumb and a candidate standing position;
// shared by the candidate search and the commitment re-validation so both
// use the exact same criterion.
function corridorOverlap(c: Crumb, x: number): boolean {
  return c.x + c.w > x - CAT_HALF_WIDTH - 4 && c.x < x + CAT_HALF_WIDTH + 4;
}

// Re-validation of a committed dodge destination (hysteresis): the spot stays
// valid while no falling crumb will sweep the cat band over it after the cat
// arrives. Same overlap margins as findSafeX, so a spot chosen as safe never
// flips unsafe merely because the cat moved along its path.
export function isSafeSpot(s: GameState, x: number, crumbs: Crumb[]): boolean {
  const arrive = Math.abs(x - s.cat.x) / CAT_GLIDE_SPEED;
  for (const c of crumbs) {
    if (corridorOverlap(c, x) && c.y + c.vy * arrive < CAT_Y) return false;
  }
  return true;
}

// Is x inside any falling crumb's corridor, regardless of timing? Unlike
// isSafeSpot this has no arrival-time allowance: the corridor stays
// hazardous until the crumb has actually swept past it, so a cat walking
// back in early cannot be clipped on the way.
export function corridorThreatened(x: number, crumbs: Crumb[]): boolean {
  return crumbs.some((c) => corridorOverlap(c, x));
}

// Nearest x the cat can glide to that no falling crumb will reach.
// Checks each crumb's position at the cat's arrival time.
export function findSafeX(s: GameState, crumbs: Crumb[]): number | null {
  if (!crumbs.length) return null;
  const candidates: Array<{ x: number; dist: number }> = [];
  for (let x = CAT_MIN_X; x <= CAT_MAX_X; x += 8) {
    const arrive = Math.abs(x - s.cat.x) / CAT_GLIDE_SPEED;
    let safe = true;
    for (const c of crumbs) {
      const cy = c.y + c.vy * arrive;
      // the cat parks at x: any crumb that has not yet fallen past the hit
      // band (cy < CAT_Y) and overlaps the candidate corridor will hit later
      if (cy < CAT_Y && corridorOverlap(c, x)) {
        safe = false;
        break;
      }
    }
    if (safe) candidates.push({ x, dist: Math.abs(x - s.cat.x) });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => a.dist - b.dist);
  return clampCatX(candidates[0].x);
}

// Dodge plan: glide to the nearest safe corridor when there is time; below
// the accept-threshold take the hit (spec section 6). The destination is
// validated against ALL falling crumbs, not only those threatening the cat
// right now — dodging one crumb into another's corridor must not happen.
export function planDodge(s: GameState, p: DodgeParams = DEFAULT_DODGE_PARAMS): number | null {
  const threats = threateningCrumbs(s, p.horizonS);
  if (!threats.length) return null;
  const urgent = threats
    .filter((t) => !absorbedByShield(s, t.crumb))
    .sort((a, b) => a.tti - b.tti)[0];
  if (!urgent) return null;
  if (urgent.tti <= p.acceptBelowS) return null; // too late, accept the hit
  return findSafeX(s, fallingCrumbs(s));
}
