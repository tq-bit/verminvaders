// Crumb threat detection and safe-corridor search (spec section 6, Dodging).

import type { Crumb, GameState } from "../types.ts";
import {
  CAT_GLIDE_SPEED,
  CAT_HALF_WIDTH,
  CAT_HIT_TOP,
  CAT_MAX_X,
  CAT_MIN_X,
  CAT_Y,
  clampCatX,
} from "./aim.ts";

export interface Threat {
  crumb: Crumb;
  tti: number; // seconds until the crumb reaches the cat hitbox band
}

const SHIELD_Y = 392;

export interface DodgeParams {
  horizonS: number;
  acceptBelowS: number;
}

const DEFAULT_DODGE: DodgeParams = { horizonS: 1.6, acceptBelowS: 0.25 };

// A crumb threatens the cat if its x-range overlaps cat.x +/- 30 while invuln
// is 0 and the crumb will actually reach the cat (not absorbed by a shield).
export function threateningCrumbs(s: GameState, horizonS = DEFAULT_DODGE.horizonS): Threat[] {
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

// Nearest x the cat can glide to that no threatening crumb will reach.
// Checks each crumb's position at the cat's arrival time.
export function findSafeX(s: GameState, threats: Threat[]): number | null {
  const real = threats.filter((t) => !absorbedByShield(s, t.crumb));
  if (!real.length) return null;
  const candidates: Array<{ x: number; dist: number }> = [];
  for (let x = CAT_MIN_X; x <= CAT_MAX_X; x += 8) {
    const arrive = Math.abs(x - s.cat.x) / CAT_GLIDE_SPEED;
    let safe = true;
    for (const t of real) {
      const cy = t.crumb.y + t.crumb.vy * arrive;
      // the cat parks at x: any crumb that has not yet fallen past the hit
      // band (cy < CAT_Y) and overlaps the candidate corridor will hit later
      const notYetPast = cy < CAT_Y;
      const overlap =
        t.crumb.x + t.crumb.w > x - CAT_HALF_WIDTH - 4 &&
        t.crumb.x < x + CAT_HALF_WIDTH + 4;
      if (notYetPast && overlap) {
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
// the accept-threshold take the hit (spec section 6).
export function planDodge(s: GameState, p: DodgeParams = DEFAULT_DODGE): number | null {
  const threats = threateningCrumbs(s, p.horizonS);
  if (!threats.length) return null;
  const urgent = threats
    .filter((t) => !absorbedByShield(s, t.crumb))
    .sort((a, b) => a.tti - b.tti)[0];
  if (!urgent) return null;
  if (urgent.tti <= p.acceptBelowS) return null; // too late, accept the hit
  return findSafeX(s, threats);
}
