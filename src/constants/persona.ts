// Fat-cat persona cooldowns per event category.

import type { CatEventType } from "../types/index.d.ts";

export const COOLDOWNS_MS: { [K in CatEventType]: number } = {
  boot: 0,
  gameStart: 0,
  waveClear: 3000,
  roombaHit: 2000,
  lifeLost: 2000,
  dodge: 12000,
  idle: 30000,
  gameOver: 0,
  sessionEnd: 0,
};
