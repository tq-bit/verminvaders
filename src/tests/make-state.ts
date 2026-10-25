// Fixture builder for policy tests: a wave-1 state snapshot.

import type { GameState, Rodent, Shield } from "../types/index.d.ts";

export function makeRods(formationX = 52, formationY = 84, cols = 8, rows = 5): Rodent[] {
  const rods: Rodent[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const rat = row < 2;
      rods.push({
        x: formationX + col * 44,
        y: formationY + row * 36,
        w: rat ? 36 : 30,
        h: rat ? 30 : 24,
        row,
        col,
        rat,
        points: rat ? 30 : row === 2 ? 20 : 10,
      });
    }
  }
  return rods;
}

export function makeShields(): Shield[] {
  // 4 pieces at y = 392 like buildShields(), evenly spread with gaps
  return [60, 180, 300, 420].map((x) => ({
    x,
    y: 392,
    w: 50,
    h: 30,
    cellsLeft: 16,
  }));
}

export function makeState(overrides: Partial<GameState> = {}): GameState {
  const rods = overrides.rods ?? makeRods();
  return {
    phase: "playing",
    paused: false,
    score: 0,
    hi: 0,
    wave: 1,
    lives: 3,
    invuln: 0,
    time: 0,
    cat: { x: 240, y: 536, minX: 36, maxX: 444, speed: 230 },
    furball: null,
    crumbs: [],
    rods,
    formation: {
      x: 52,
      y: 84,
      dir: 1,
      cols: 8,
      rows: 5,
      stepX: 44,
      stepY: 36,
      nextMarchIn: 0.25,
    },
    roomba: null,
    shields: overrides.shields ?? [],
    ...overrides,
  };
}
