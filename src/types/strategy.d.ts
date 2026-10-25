// Strategy-brain types: epoch reports, model responses, memory records.

import type { ExecutorParams } from "./policy.d.ts";

export interface EpochReport {
  epoch: number;
  durationS: number;
  scoreStart: number;
  scoreEnd: number;
  shotsFired: number;
  hits: number;
  roombaHits: number;
  livesStart: number;
  livesEnd: number;
  wave: number;
  rodentsAlive: number;
  waveCleared: boolean;
  crumbsFired: number;
  crumbSpawnCols: number[];
  nearMisses: number;
  events: string[];
  // movement telemetry: how the cat actually moved this epoch
  /** total horizontal distance glided, in px */
  catDistancePx: number;
  /** reversals of glide direction (left↔right) beyond CAT_DIR_EPS_PX */
  catDirectionChanges: number;
  /** tick census per executor decision reason (dodge, reposition, ...) */
  decisionReasons: Record<string, number>;
}

export interface StrategyResponse {
  params: Partial<ExecutorParams>;
  notes: string;
  memory: unknown;
  gameSummary: string; // only produced on post-mortem calls
}

export interface GameRecord {
  game: number;
  score: number;
  wave: number;
  lives: number;
  outcome: string;
  summary?: string;
  finalParams?: ExecutorParams;
}

export interface MemoryFile {
  memory: unknown;
  notes: string;
  games: GameRecord[];
}

export interface StrategyEvents {
  onStrategy?: (notes: string, params: ExecutorParams) => void;
  onThinkingDelta?: (delta: string) => void;
  onThinkingEnd?: () => void;
  onLlmError?: (message: string) => void;
}

export interface StrategyLimits {
  /** how many previous games (summaries + stats) are included in prompts */
  contextGames: number;
  /** maximum game records persisted in the memory file */
  maxMemoryGames: number;
}
