// Bridge snapshot types (spec section 3.1) — the world as verminvaders.state() reports it.

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
