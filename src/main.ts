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
import { StrategyController } from "./driver/strategy-controller.ts";
import { MistralClient } from "./llm/mistral-client.ts";
import { c } from "./ui/colors.ts";
import { ThinkingRenderer } from "./ui/thinking-renderer.ts";
import { loadCatLines } from "./persona/lines.ts";
import { Persona } from "./persona/persona.ts";
import type { Args, RunOptions } from "./types/index.d.ts";

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

// Non-negative integer env variable with a fallback and a warning on garbage.
function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    console.error(c.yellow(`[harness] ignoring invalid ${name}="${raw}", using ${fallback}`));
    return fallback;
  }
  return n;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    headed: false,
    mode: "realtime",
    pollMs: 80,
    maxGames: 3,
    gamePath: path.resolve(import.meta.dirname, "..", "app", "index.html"),
    logLevel: "normal",
    model: "mistral-large-4",
    epochMs: 10000,
    memoryPath: path.resolve(import.meta.dirname, "..", "memory", "mistral-strategy.json"),
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

function requireValue(argv: string[], i: number, flag: string): string {
  const v = argv[i];
  if (v === undefined) throw new Error(`${flag} requires a value`);
  return v;
}

// Tiny static server for the game directory: some browsers restrict
// localStorage on file:// URLs, and the page loads its CSS/JS via relative URLs.
function serveDir(dir: string): Promise<{ server: ReturnType<typeof createServer>; url: string }> {
  const types: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
  };
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      try {
        const rel = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
        const safe = path.normalize(rel).replace(/^([.][.][/\\])+/, "");
        let file = path.resolve(dir, "." + safe);
        if (!file.startsWith(path.resolve(dir))) file = path.resolve(dir, "index.html");
        if (safe.endsWith("/") || path.extname(file) === "") file = path.join(file, "index.html");
        const type = types[path.extname(file)] ?? "application/octet-stream";
        const body = await readFile(file);
        res.writeHead(200, { "content-type": type });
        res.end(body);
      } catch {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
      }
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
  const { server, url } = await serveDir(path.dirname(args.gamePath));

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
    const thinking = new ThinkingRenderer(args.model);
    const limits = {
      contextGames: intEnv("VERMINVADERS_CONTEXT_GAMES", 5),
      maxMemoryGames: intEnv("VERMINVADERS_MEMORY_MAX_GAMES", 10),
    };
    strategy = new StrategyController(
      client,
      args.memoryPath,
      {
        onThinkingDelta: (delta) => thinking.push("thinking", delta),
        onThinkingEnd: () => thinking.finish(),
        onStrategy: (notes, params) => {
          console.log(c.cyan(`[${args.model}] ${notes}`));
          console.log(
            c.green(
              `[${args.model}] params: roombaFirst=${params.roombaFirst} rowW=${params.lowestRowWeight} ptsW=${params.pointsWeight} shieldPen=${params.shieldPenalty} chew=${params.chewShields} dodgeH=${params.dodgeHorizonS}s accept=${params.acceptHitBelowS}s margin=${params.corridorMarginPx}px colSpreadW=${params.columnSpreadWeight}`,
            ),
          );
        },
        onLlmError: (msg) => console.error(c.red(`[${args.model}] ${msg}`)),
      },
      args.style,
      limits,
    );
    await strategy.load();
  }

  harness = new Harness(conn, policy, persona, opts, {
    onWaveSummary: (wave, score, lives, durS) =>
      console.log(c.green(`[wave ${wave} cleared] score=${score} lives=${lives} duration=${durS}s`)),
    onSessionSummary: (summary) => console.log(c.bold(`[session] ${summary}`)),
    onGameOver: (score) => console.log(c.red(`[game over] score=${score}`)),
  }, strategy);

  try {
    await harness.connect();
    console.log(c.blue(`[harness] playing ${path.basename(args.gamePath)} at ${url}`));
    console.log(
      c.blue(
        `[harness] mode=${opts.mode} poll=${opts.pollMs}ms games=${opts.maxGames} brain=${args.noLlm ? "local-executor" : `${args.model} @ ${opts.epochMs}ms epochs`}${args.style ? c.yellow(` style="${args.style}"`) : ""}`,
      ),
    );
    await harness.run();
  } finally {
    await browser.close().catch(() => {});
    server.close();
  }
}

main().catch((e) => {
  console.error(c.red(`[harness] fatal: ${(e as Error).message}`));
  process.exitCode = 1;
});
