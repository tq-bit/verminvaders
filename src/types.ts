// Shared bridge snapshot and harness types (mirrors spec section 3.1).

export interface CatState {
  x: number;
  y: number;
  minX: number;
  maxX: number;
  speed: number;
}

export interface Shot {
  x: number;
  y: number;
  vy: number;
}

export interface Crumb {
  x: number;
  y: number;
  w: number;
  h: number;
  vy: number;
}

export interface Rodent {
  x: number;
  y: number;
  w: number;
  h: number;
  row: number;
  col: number;
  rat: boolean;
  points: number;
}

export interface Formation {
  x: number;
  y: number;
  dir: number;
  cols: number;
  rows: number;
  stepX: number;
  stepY: number;
  nextMarchIn: number;
}

export interface Roomba {
  x: number;
  y: number;
  vx: number;
  points: number;
}

export interface Shield {
  x: number;
  y: number;
  w: number;
  h: number;
  cellsLeft: number;
}

export type Phase = "title" | "playing" | "waveclear" | "gameover";

export interface GameState {
  phase: Phase;
  paused: boolean;
  score: number;
  hi: number;
  wave: number;
  lives: number;
  invuln: number;
  time: number;
  cat: CatState;
  furball: Shot | null;
  crumbs: Crumb[];
  rods: Rodent[];
  formation: Formation;
  roomba: Roomba | null;
  shields: Shield[];
}

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

export type RunMode = "realtime" | "considered";

export interface RunOptions {
  mode: RunMode;
  pollMs: number;
  maxGames: number;
  epochMs: number; // strategy-epoch length for the LLM brain (0 = no epochs)
  logLevel: "silent" | "normal" | "verbose";
}
