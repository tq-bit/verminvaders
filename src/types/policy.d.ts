// Policy and executor types.

import type { Crumb, GameState } from "./game.d.ts";

// One decide() result, applied once per tick (spec section 5.1).
export interface Decision {
  moveTo?: number;
  left?: boolean;
  right?: boolean;
  shoot?: boolean;
  stop?: boolean;
}

export interface Policy {
  decide(state: GameState): Decision;
  reset(): void;
}

// High-level knobs the strategic brain (Mistral) may retune each epoch.
export interface ExecutorParams {
  roombaFirst: boolean;
  lowestRowWeight: number;
  pointsWeight: number;
  shieldPenalty: number;
  chewShields: boolean;
  dodgeHorizonS: number;
  acceptHitBelowS: number;
  corridorMarginPx: number;
  columnSpreadWeight: number;
  // structured levers (neutral defaults keep legacy behavior)
  /** per-row urgency multipliers, index = row (0 = top/rats), length 5 */
  rowWeights: number[];
  /** per-column targeting penalty 0..10, index = column, length 8 */
  colAvoid: number[];
  /** risk appetite at 3/2/1 lives, 0..10, 5 = neutral */
  livesRisk: number[];
  /** 0 = always the best target; up to 10 = increasingly sample 2nd/3rd-best */
  exploration: number;
  /** random aim error in px; 0 = perfectly deterministic aiming */
  aimJitterPx: number;
  /** laziness of the executor: each point penalizes target scores by 1 per
   *  10 px of glide distance to the aim point; 0 = distance is ignored */
  travelCost: number;
  /** seed for the executor RNG; identical seeds replay identical executor
   *  decisions — the enemy fire follows its own RNG (see verminSeed) */
  rngSeed: number;
  /** seed for the vermin (rodent) firing RNG: -1 = unseeded (Math.random),
   *  any other value replays the same crumb schedule and shooter picks
   *  every game; applied to the game, not the executor */
  verminSeed: number;
}

export interface ShotPlan {
  kind: "roomba" | "rodent";
  catX: number;
  shotX: number;
  flightT: number;
  blocked: boolean;
  hot: boolean;
}

export interface Threat {
  crumb: Crumb;
  tti: number;
}

export interface DodgeParams {
  horizonS: number;
  acceptBelowS: number;
}
