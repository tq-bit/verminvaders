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
  epochMs: number;
  memoryPath: string;
  style: string;
  noLlm: boolean;
  /** stream the model's reasoning text (false: show a Strategizing indicator) */
  thinking: boolean;
  /** run the interactive setup wizard when stdin is a TTY */
  prompt: boolean;
}
