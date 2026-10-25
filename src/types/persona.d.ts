// Fat-cat persona types.

export type CatEventType =
  | "boot"
  | "gameStart"
  | "waveClear"
  | "roombaHit"
  | "lifeLost"
  | "dodge"
  | "idle"
  | "gameOver"
  | "sessionEnd";

export interface CatLines {
  faces: string[];
  lines: { [K in CatEventType]: string[] };
}
