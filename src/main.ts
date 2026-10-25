// Verminvaders terminal harness (spec section 7, mode B).
// Serves the game page on localhost, drives it headless (or headed) through
// the window.verminvaders bridge, and narrates as a fat cat.
// CLI parsing lives in ui/cli.ts, the static server in www/static-server.ts.
//
// Usage:
//   node main.ts [--headed] [--mode realtime|considered] [--poll <ms>]
//                [--games <n>] [--persona <path>] [--game <path>]
//                [--log-level silent|normal|verbose]

import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { HeuristicPolicy } from "./policy/heuristic.ts";
import { Connection } from "./driver/connection.ts";
import { Harness } from "./driver/driver.ts";
import { StrategyController } from "./driver/strategy-controller.ts";
import { MistralClient } from "./llm/mistral-client.ts";
import { c } from "./ui/colors.ts";
import { ThinkingRenderer } from "./ui/thinking-renderer.ts";
import { parseArgs, loadEnvFile, intEnv } from "./ui/cli.ts";
import { serveDir } from "./www/static-server.ts";
import { loadCatLines } from "./persona/lines.ts";
import { Persona } from "./persona/persona.ts";
import type { RunOptions } from "./types/index.d.ts";

// page.evaluate callbacks run in the browser, not in Node
declare const window: any;

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
  // env-seeded executor RNG: same seed replays the same play (the model may
  // still retune rngSeed in its strategy answers)
  const policy = new HeuristicPolicy({ rngSeed: intEnv("VERMINVADERS_RNG_SEED", 0) });
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
          console.log(
            c.green(
              `[${args.model}] levers: rowWeights=${params.rowWeights.join("/")} colAvoid=${params.colAvoid.join("/")} livesRisk=${params.livesRisk.join("/")} exploration=${params.exploration} aimJitter=${params.aimJitterPx}px seed=${params.rngSeed}`,
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
