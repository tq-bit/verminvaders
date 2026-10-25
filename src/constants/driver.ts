// Driver constants: bridge timeout and strategy-brain limits.

import type { StrategyLimits } from "../types/index.d.ts";

// Poll for window.verminvaders at most this long (spec section 8).
export const BRIDGE_TIMEOUT_MS = 10000;

// Cat movement below this px-per-tick delta counts as standing still for
// direction-change counting (avoids rounding noise flipping the direction).
export const CAT_DIR_EPS_PX = 4;

export const DEFAULT_STRATEGY_LIMITS: StrategyLimits = {
  contextGames: 5,
  maxMemoryGames: 10,
};
