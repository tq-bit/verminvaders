// Pure aiming math (spec sections 4 and 6). No I/O, fully unit-testable.

import type { GameState } from "../types.ts";

export const MUZZLE_OFFSET = 18; // furball spawns at cat.x + 18 (spec section 4)
export const CAT_Y = 536;
export const MUZZLE_Y = CAT_Y - 16; // 520
export const FURBALL_SPEED = 430;
export const CAT_GLIDE_SPEED = 322; // moveTo speed, 1.4 x keyboard
export const CAT_MIN_X = 36;
export const CAT_MAX_X = 444;
export const ARENA_W = 480;
export const CAT_HALF_WIDTH = 30; // cat hitbox is cat.x +/- 30
export const CAT_HIT_TOP = 502; // hitbox band 502..536

export function clampCatX(x: number): number {
  return Math.max(CAT_MIN_X, Math.min(CAT_MAX_X, x));
}

export function flightTime(targetY: number): number {
  return Math.max(0, (MUZZLE_Y - targetY) / FURBALL_SPEED);
}

export function glideTime(fromX: number, toX: number): number {
  return Math.abs(clampCatX(toX) - fromX) / CAT_GLIDE_SPEED;
}

// March interval as the game computes it (spec section 4).
export function marchIntervalFor(s: GameState): number {
  const total = s.formation.cols * s.formation.rows;
  const alive = s.rods.length;
  const waveFactor = Math.max(0.55, 1 - 0.06 * (s.wave - 1));
  return Math.max(0.06, 0.5 * (alive / total)) * waveFactor;
}

// Simulate the formation's march steps forward by dt seconds and return the
// predicted formation x. Wall contact reverses direction and drops (no x move).
export function predictFormationX(s: GameState, dt: number): number {
  let gx = s.formation.x;
  let dir = s.formation.dir;
  const rods = s.rods;
  if (!rods.length) return gx;
  let minX = Infinity;
  let maxX = -Infinity;
  for (const r of rods) {
    const rx = gx + r.col * s.formation.stepX;
    minX = Math.min(minX, rx);
    maxX = Math.max(maxX, rx + r.w);
  }
  const interval = marchIntervalFor(s);
  let t = Math.max(0, s.formation.nextMarchIn);
  let guard = 0;
  while (t <= dt && guard < 200) {
    if (dir > 0 && maxX + 10 >= ARENA_W - 8) {
      dir = -1; // wall: reverse and drop, x unchanged
    } else if (dir < 0 && minX - 10 <= 8) {
      dir = 1;
    } else {
      gx += 12 * dir;
      if (dir > 0) maxX += 12;
      else minX -= 12;
    }
    t += Math.max(0.01, interval);
    guard++;
  }
  return gx;
}

// Is the vertical shot path at shotX (from the muzzle up to targetY) crossing
// an intact shield? Holes the policy chewed earlier count as free passage.
export function corridorBlocked(
  s: GameState,
  shotX: number,
  targetY: number,
  holes: number[] = [],
): boolean {
  for (const sh of s.shields) {
    if (sh.cellsLeft <= 0) continue;
    // furball passes the shield band only if the target sits above it
    if (targetY > sh.y + sh.h) continue;
    if (shotX < sh.x - 2 || shotX > sh.x + sh.w + 2) continue;
    const holed = holes.some((hx) => Math.abs(hx - shotX) <= 10);
    if (!holed) return true;
  }
  return false;
}
