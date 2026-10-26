// Executor (policy) constants: internal tuning knobs and defaults.

import type { DodgeParams, ExecutorParams } from "../types/index.d.ts";

// px: cat counts as arrived for shooting
export const ARRIVAL_EPS = 8;
// glide must finish in < 90% of flight time
export const MIN_LEAD_MARGIN = 0.9;

export const DEFAULT_EXECUTOR_PARAMS: ExecutorParams = {
  roombaFirst: true,
  lowestRowWeight: 1,
  pointsWeight: 0.5,
  shieldPenalty: 1000,
  chewShields: true,
  dodgeHorizonS: 1.6,
  acceptHitBelowS: 0.25,
  corridorMarginPx: 8,
  columnSpreadWeight: 0,
  rowWeights: [1, 1, 1, 1, 1],
  colAvoid: [0, 0, 0, 0, 0, 0, 0, 0],
  livesRisk: [5, 5, 5],
  exploration: 0,
  aimJitterPx: 0,
  travelCost: 0,
  rngSeed: 0,
  verminSeed: -1,
};

export const DEFAULT_DODGE_PARAMS: DodgeParams = { horizonS: 1.6, acceptBelowS: 0.25 };
