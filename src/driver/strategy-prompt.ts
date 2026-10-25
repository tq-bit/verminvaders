// Prompt payload construction for the strategic brain: the compacted game
// state sent alongside the reports. The system prompt itself lives in
// prompts/system-prompt.ts.

import type { GameState } from "../types/index.d.ts";

// Compact state for the prompt: same fields, rounded for fewer tokens.
export function compactState(s: GameState): Record<string, unknown> {
  return {
    ...s,
    cat: { x: Math.round(s.cat.x), y: s.cat.y },
    crumbs: s.crumbs.map((c) => ({ x: Math.round(c.x), y: Math.round(c.y), vy: c.vy })),
    rods: s.rods.map((r) => ({ x: Math.round(r.x), y: Math.round(r.y), row: r.row, col: r.col, rat: r.rat, points: r.points })),
    furball: s.furball ? { x: Math.round(s.furball.x), y: Math.round(s.furball.y) } : null,
    roomba: s.roomba ? { x: Math.round(s.roomba.x), vx: s.roomba.vx } : null,
    shields: s.shields.map((sh) => ({ x: sh.x, w: sh.w, cellsLeft: sh.cellsLeft })),
  };
}
