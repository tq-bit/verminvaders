// CLI plumbing for the harness entrypoint: argument parsing (commander),
// .env loading, and integer environment variables.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Command, CommanderError } from "commander";
import { c } from "./colors.ts";
import type { Args } from "../types/index.d.ts";

// Minimal .env loader (KEY=VALUE lines); does not override existing env vars.
export async function loadEnvFile(file: string): Promise<void> {
  try {
    const raw = await readFile(file, "utf-8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const value = m[2].replace(/^["']|["']$/g, "");
      if (process.env[m[1]] === undefined) process.env[m[1]] = value;
    }
  } catch {
    // no .env file; rely on the real environment
  }
}

// Non-negative integer env variable with a fallback and a warning on garbage.
export function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    console.error(c.yellow(`[harness] ignoring invalid ${name}="${raw}", using ${fallback}`));
    return fallback;
  }
  return n;
}

const DEFAULT_GAME = () => path.resolve(import.meta.dirname, "..", "..", "app", "index.html");
const DEFAULT_MEMORY = () =>
  path.resolve(import.meta.dirname, "..", "..", "memory", "mistral-strategy.json");

export function parseArgs(argv: string[]): Args {
  const program = new Command()
    .name("verminvaders")
    .description("Verminvaders harness: a fat cat vs. the rodent armada, tuned by Mistral.")
    .option("--headed", "show the browser window")
    .option("--mode <mode>", "realtime or considered", "realtime")
    .option("--poll <ms>", "executor tick interval in ms", Number, 80)
    .option("--games <n>", "games per session", Number, 3)
    .option("--persona <path>", "custom fat-cat lines file")
    .option("--game <path>", "path to the game page")
    .option("--log-level <level>", "silent | normal | verbose", "normal")
    .option("--model <name>", "which Mistral model is the strategic brain", "mistral-large-4")
    .option("--epoch-ms <n>", "length of one playing epoch in ms", Number, 10000)
    .option("--memory <path>", "where the model's persistent memory lives")
    .option("--style <directive>", "operator directive injected into the model's prompt", "")
    .option("--no-llm", "skip all API calls; the executor plays with default parameters")
    .option("--no-thinking", "hide the model's reasoning; show a Strategizing indicator instead")
    .option("--no-prompt", "skip the interactive setup wizard")
    .exitOverride((err) => {
      // --help / -h print and exit cleanly; everything else is a thrown error
      if (err.code === "commander.helpDisplayed" || err.code === "commander.version") process.exit(0);
      throw err;
    });
  try {
    program.parse(argv.slice(2), { from: "user" });
  } catch (e) {
    if (e instanceof CommanderError) {
      throw new Error(String(e.message).replace(/^error:\s*/i, ""));
    }
    throw e;
  }
  const o = program.opts<Record<string, unknown>>();
  return {
    headed: !!o.headed,
    mode: o.mode as Args["mode"],
    pollMs: o.poll as number,
    maxGames: o.games as number,
    personaPath: o.persona as string | undefined,
    gamePath: o.game ? path.resolve(String(o.game)) : DEFAULT_GAME(),
    logLevel: o.logLevel as Args["logLevel"],
    model: o.model as string,
    epochMs: o.epochMs as number,
    memoryPath: o.memory ? path.resolve(String(o.memory)) : DEFAULT_MEMORY(),
    style: o.style as string,
    noLlm: o.llm === false,
    thinking: o.thinking !== false,
    prompt: o.prompt !== false,
  };
}
