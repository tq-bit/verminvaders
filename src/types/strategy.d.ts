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
