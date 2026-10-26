// Driver and harness types.

import type { RunMode } from "./policy.d.ts";

export interface RunOptions {
  mode: RunMode;
  pollMs: number;
  maxGames: number;
  /** strategy-epoch length in ms; undefined = no epoch updates (per-wave strategy) */
  epochMs?: number;
  /** async = strategize in the background, never pause play; paused = freeze during consultations */
  strategyMode?: "async" | "paused";
  /** presentation hold in ms on the wave-clear banner and the game-over screen; 0 = off */
  intermissionMs?: number;
  logLevel: "silent" | "normal" | "verbose";
}

export interface HarnessCallbacks {
  onWaveSummary?: (wave: number, score: number, lives: number, durationS: number) => void;
  onSessionSummary?: (summary: string) => void;
  onGameOver?: (score: number) => void;
}

export interface ApplyResult {
  ok: boolean;
  shot: boolean;
}

export interface WaveSummary {
  wave: number;
  score: number;
  lives: number;
  durationS: number;
}
