// Verminvaders terminal harness (spec section 7, mode B).
// Serves the game page on localhost, drives it headless (or headed) through
// the window.verminvaders bridge, and narrates as a fat cat.
//
// Usage:
//   node main.ts [--headed] [--mode realtime|considered] [--poll <ms>]
//                [--games <n>] [--persona <path>] [--game <path>]
//                [--log-level silent|normal|verbose]

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { HeuristicPolicy } from "./policy/heuristic.ts";
import { Connection } from "./driver/connection.ts";
import { Harness } from "./driver/driver.ts";
import { StrategyController } from "./driver/strategy.ts";
import { MistralClient } from "./llm/mistral.ts";
import { loadCatLines, Persona } from "./persona/persona.ts";
import type { RunOptions } from "./types.ts";

// page.evaluate callbacks run in the browser, not in Node
declare const window: any;

// Minimal .env loader (KEY=VALUE lines); does not override existing env vars.
async function loadEnvFile(file: string): Promise<void> {
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

interface Args {
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
  noLlm: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    headed: false,
    mode: "realtime",
    pollMs: 80,
    maxGames: 3,
    gamePath: path.resolve(import.meta.dirname, "..", "app", "verminvaders-demo.html"),
    logLevel: "normal",
    model: "mistral-large-4",
    epochMs: 10000,
    memoryPath: path.resolve(import.meta.dirname, "..", "memory", "mistral-strategy.json"),
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
      case "--no-llm": args.noLlm = true; break;
      case "--help":
      case "-h":
        console.log("node main.ts [--headed] [--mode realtime|considered] [--poll ms] [--games n] [--persona path] [--game path] [--log-level silent|normal|verbose] [--model name] [--epoch-ms n] [--memory path] [--no-llm]");
        process.exit(0);
        break;
      default:
        throw new Error(`unknown argument: ${a}`);
    }
  }
  return args;
}

function requireValue(argv: string[], i: number, flag: string): string {
  const v = argv[i];
  if (v === undefined) throw new Error(`${flag} requires a value`);
  return v;
}

// Tiny static server: some browsers restrict localStorage on file:// URLs.
function serveOnce(html: string): Promise<{ server: ReturnType<typeof createServer>; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("no server address");
      resolve({ server, url: `http://127.0.0.1:${addr.port}/` });
    });
  });
}

async function main(): Promise<void> {
  await loadEnvFile(path.resolve(import.meta.dirname, ".env"));
  const args = parseArgs(process.argv);
  const html = await readFile(args.gamePath, "utf-8");
  const { server, url } = await serveOnce(html);

  const lines = await loadCatLines(args.personaPath);
  const persona = new Persona(lines, args.logLevel === "silent");

  let browser: Browser | null = null;
  let page: Page | null = null;
  let harness: Harness | null = null;

  const shutdown = async (sig: string) => {
    console.error(`\n[harness] ${sig} received, shutting down`);
    try {
      harness?.stop();
      await page?.evaluate(() => window.verminvaders?.resume()).catch(() => {});
    } catch { /* already closed */ }
    await browser?.close().catch(() => {});
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  try {
    browser = await chromium.launch({ headless: !args.headed });
    page = await browser.newPage();
    await page.goto(url);
  } catch (e) {
    console.error(`[harness] failed to launch browser: ${(e as Error).message}`);
    server.close();
    process.exitCode = 1;
    return;
  }

  const conn = new Connection(page);
  const policy = new HeuristicPolicy();
  const opts: RunOptions = {
    mode: args.mode,
    pollMs: args.pollMs,
    maxGames: args.maxGames,
    epochMs: args.noLlm ? 0 : args.epochMs,
    logLevel: args.logLevel,
  };

  // the strategic brain: mistral-large-4 retunes the executor each epoch
  let strategy: StrategyController | null = null;
  if (!args.noLlm) {
    const apiKey = process.env.MISTRAL_API_KEY;
    if (!apiKey) {
      console.error("[harness] fatal: MISTRAL_API_KEY missing (set it in src/.env or pass --no-llm)");
      await browser.close().catch(() => {});
      server.close();
      process.exitCode = 1;
      return;
    }
    const client = new MistralClient(apiKey, args.model);
    strategy = new StrategyController(client, args.memoryPath, {
      onStrategy: (notes, params) => {
        console.log(`[${args.model}] ${notes}`);
        console.log(
          `[${args.model}] params: roombaFirst=${params.roombaFirst} rowW=${params.lowestRowWeight} ptsW=${params.pointsWeight} shieldPen=${params.shieldPenalty} chew=${params.chewShields} dodgeH=${params.dodgeHorizonS}s accept=${params.acceptHitBelowS}s margin=${params.corridorMarginPx}px`,
        );
      },
      onLlmError: (msg) => console.error(`[${args.model}] ${msg}`),
    });
    await strategy.load();
  }

  harness = new Harness(conn, policy, persona, opts, {
    onWaveSummary: (wave, score, lives, durS) =>
      console.log(`[wave ${wave} cleared] score=${score} lives=${lives} duration=${durS}s`),
    onSessionSummary: (summary) => console.log(`[session] ${summary}`),
    onGameOver: (score) => console.log(`[game over] score=${score}`),
  }, strategy);

  try {
    await harness.connect();
    console.log(`[harness] playing ${path.basename(args.gamePath)} at ${url}`);
    console.log(`[harness] mode=${opts.mode} poll=${opts.pollMs}ms games=${opts.maxGames} brain=${args.noLlm ? "local-executor" : `${args.model} @ ${opts.epochMs}ms epochs`}`);
    await harness.run();
  } finally {
    await browser.close().catch(() => {});
    server.close();
  }
}

main().catch((e) => {
  console.error(`[harness] fatal: ${(e as Error).message}`);
  process.exitCode = 1;
});
