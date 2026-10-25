// Hot-corridor detection: x ranges a falling crumb will sweep through the
// cat hitbox within the planning horizon. Standing or walking there is unsafe.

import type { ExecutorParams, GameState } from "../types/index.d.ts";
import { CAT_HALF_WIDTH, CAT_HIT_TOP, CAT_Y } from "../constants/index.ts";

export function hotCorridors(s: GameState, p: ExecutorParams): Array<{ lo: number; hi: number }> {
  const out: Array<{ lo: number; hi: number }> = [];
  for (const c of s.crumbs) {
    if (c.y > CAT_Y) continue; // already past the cat band
    const tti = (CAT_HIT_TOP - (c.y + c.h)) / c.vy;
    if (tti > p.dodgeHorizonS) continue;
    out.push({
      lo: c.x - CAT_HALF_WIDTH - p.corridorMarginPx,
      hi: c.x + c.w + CAT_HALF_WIDTH + p.corridorMarginPx,
    });
  }
  return out;
}

export function inHot(x: number, hot: Array<{ lo: number; hi: number }>): boolean {
  return hot.some((r) => x > r.lo - 4 && x < r.hi + 4);
}
