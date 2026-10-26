// CLI argument types (ui/cli.ts).

export interface Args {
  headed: boolean;
  mode: "realtime" | "considered";
  pollMs: number;
  maxGames: number;
  personaPath?: string;
  gamePath: string;
  logLevel: "silent" | "normal" | "verbose";
  model: string;
  /** strategy-epoch length in ms; undefined = no epoch updates (per-wave) */
  epochMs?: number;
  /** async = play on while Mistral strategizes; paused = freeze during consultations */
  strategyMode: "async" | "paused";
  memoryPath: string;
  style: string;
  noLlm: boolean;
  /** stream the model's reasoning text (false: show a Strategizing indicator) */
  thinking: boolean;
  /** run the interactive setup wizard when stdin is a TTY */
  prompt: boolean;
  /** record the browser viewport into this directory when set */
  videoDir?: string;
}
