// Driver and harness types.

import type { RunMode } from "./policy.d.ts";

export interface RunOptions {
  mode: RunMode;
  pollMs: number;
  maxGames: number;
  epochMs: number; // strategy-epoch length for the LLM brain (0 = no epochs)
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
