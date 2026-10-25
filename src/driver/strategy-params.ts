// Normalization of the model's strategy answers: clamps parameters to their
// legal ranges and parses the JSON response (with a fallback for answers
// wrapped in prose).

import type { ExecutorParams, StrategyResponse } from "../types/index.d.ts";
import { DEFAULT_EXECUTOR_PARAMS } from "../constants/index.ts";

function clamp(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? v : fallback;
  return Math.max(min, Math.min(max, n));
}

// Fixed-length number arrays from untrusted model input: pad missing entries
// with the fallback, clamp the rest, drop extras.
function clampArray(raw: unknown, len: number, min: number, max: number, fallback: number): number[] {
  const arr = Array.isArray(raw) ? (raw as unknown[]) : [];
  return Array.from({ length: len }, (_, i) => clamp(arr[i], min, max, fallback));
}

export function normalizeParams(raw: unknown): ExecutorParams {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    roombaFirst: typeof r.roombaFirst === "boolean" ? r.roombaFirst : DEFAULT_EXECUTOR_PARAMS.roombaFirst,
    lowestRowWeight: clamp(r.lowestRowWeight, 0, 10, DEFAULT_EXECUTOR_PARAMS.lowestRowWeight),
    pointsWeight: clamp(r.pointsWeight, 0, 10, DEFAULT_EXECUTOR_PARAMS.pointsWeight),
    shieldPenalty: clamp(r.shieldPenalty, 0, 5000, DEFAULT_EXECUTOR_PARAMS.shieldPenalty),
    chewShields: typeof r.chewShields === "boolean" ? r.chewShields : DEFAULT_EXECUTOR_PARAMS.chewShields,
    dodgeHorizonS: clamp(r.dodgeHorizonS, 0.3, 1.6, DEFAULT_EXECUTOR_PARAMS.dodgeHorizonS),
    acceptHitBelowS: clamp(r.acceptHitBelowS, 0.05, 0.5, DEFAULT_EXECUTOR_PARAMS.acceptHitBelowS),
    corridorMarginPx: clamp(r.corridorMarginPx, 4, 20, DEFAULT_EXECUTOR_PARAMS.corridorMarginPx),
    columnSpreadWeight: clamp(r.columnSpreadWeight, 0, 10, DEFAULT_EXECUTOR_PARAMS.columnSpreadWeight),
    rowWeights: clampArray(r.rowWeights, 5, 0, 10, 1),
    colAvoid: clampArray(r.colAvoid, 8, 0, 10, 0),
    livesRisk: clampArray(r.livesRisk, 3, 0, 10, 5),
    exploration: clamp(r.exploration, 0, 10, 0),
    aimJitterPx: clamp(r.aimJitterPx, 0, 10, 0),
    rngSeed: typeof r.rngSeed === "number" && Number.isFinite(r.rngSeed) ? r.rngSeed : 0,
  };
}

export function parseStrategyResponse(text: string): StrategyResponse | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // models sometimes wrap JSON in prose; try the outermost braces
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      parsed = JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
  const obj = parsed as Record<string, unknown>;
  if (!obj || typeof obj !== "object") return null;
  return {
    params: (obj.params ?? {}) as Partial<ExecutorParams>,
    notes: typeof obj.notes === "string" ? obj.notes : "",
    memory: obj.memory ?? null,
    gameSummary: typeof obj.gameSummary === "string" ? obj.gameSummary : "",
  };
}
