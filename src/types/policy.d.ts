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
