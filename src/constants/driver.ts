// Driver constants: bridge timeout and strategy-brain limits.

import type { StrategyLimits } from "../types/index.d.ts";

// Poll for window.verminvaders at most this long (spec section 8).
export const BRIDGE_TIMEOUT_MS = 10000;

export const DEFAULT_STRATEGY_LIMITS: StrategyLimits = {
  contextGames: 5,
  maxMemoryGames: 10,
};
