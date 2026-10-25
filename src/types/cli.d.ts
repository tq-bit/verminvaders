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
}
