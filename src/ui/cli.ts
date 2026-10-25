// CLI plumbing for the harness entrypoint: argument parsing,
// .env loading, and integer environment variables.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { c } from "./colors.ts";
import type { Args } from "../types/index.d.ts";

function requireValue(argv: string[], i: number, flag: string): string {
  const v = argv[i];
  if (v === undefined) throw new Error(`${flag} requires a value`);
  return v;
}

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

export function parseArgs(argv: string[]): Args {
  const args: Args = {
    headed: false,
    mode: "realtime",
    pollMs: 80,
    maxGames: 3,
    gamePath: path.resolve(import.meta.dirname, "..", "..", "app", "index.html"),
    logLevel: "normal",
    model: "mistral-large-4",
    epochMs: 10000,
    memoryPath: path.resolve(import.meta.dirname, "..", "..", "memory", "mistral-strategy.json"),
    style: "",
    noLlm: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--headed": args.headed = true; break;
      case "--mode": args.mode = requireValue(argv, ++i, a) as Args["mode"]; break;
      case "--poll": args.pollMs = Number(requireValue(argv, ++i, a)); break;
      case "--games": args.maxGames = Number(requireValue(argv, ++i, a)); break;
      case "--persona": args.personaPath = requireValue(argv, ++i, a); break;
      case "--game": args.gamePath = path.resolve(requireValue(argv, ++i, a)); break;
      case "--log-level": args.logLevel = requireValue(argv, ++i, a) as Args["logLevel"]; break;
      case "--model": args.model = requireValue(argv, ++i, a); break;
      case "--epoch-ms": args.epochMs = Number(requireValue(argv, ++i, a)); break;
      case "--memory": args.memoryPath = path.resolve(requireValue(argv, ++i, a)); break;
      case "--style": args.style = requireValue(argv, ++i, a); break;
      case "--no-llm": args.noLlm = true; break;
      case "--help":
      case "-h":
        console.log("node main.ts [--headed] [--mode realtime|considered] [--poll ms] [--games n] [--persona path] [--game path] [--log-level silent|normal|verbose] [--model name] [--epoch-ms n] [--memory path] [--style 'directive'] [--no-llm]");
        process.exit(0);
        break;
      default:
        throw new Error(`unknown argument: ${a}`);
    }
  }
  return args;
}
