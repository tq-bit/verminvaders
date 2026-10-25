// Strategic brain integration: every epoch the harness pauses the game,
// sends state + report + persistent memory to Mistral, and the model returns
// tuned executor params plus an updated memory object. Post-mortems write a
// per-game strategy summary and clean up the memory.

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ExecutorParams,
  GameRecord,
  GameState,
  MemoryFile,
  StrategyEvents,
  StrategyLimits,
  StrategyResponse,
} from "../types/index.d.ts";
import type { MistralClient } from "../llm/mistral-client.ts";
import { DEFAULT_STRATEGY_LIMITS } from "../constants/index.ts";
import { compactState } from "./strategy-prompt.ts";
import { systemPrompt } from "../prompts/system-prompt.ts";
import { normalizeParams, parseStrategyResponse } from "./strategy-params.ts";
import { EpochTracker } from "./epoch-tracker.ts";

export class StrategyController {
  private client: MistralClient;
  private memoryPath: string;
  private memory: MemoryFile = { memory: null, notes: "", games: [] };
  private epochTracker = new EpochTracker();
  private cb: StrategyEvents;
  private notes = "";
  private lastParams: ExecutorParams | null = null;
  private limits: StrategyLimits;

  private style: string;

  // strict response schema (strategy-response.schema.json), loaded once;
  // null if the file is unreadable → falls back to plain JSON mode
  private schema: Record<string, unknown> | null | undefined;

  private loadSchema(): Record<string, unknown> | null {
    if (this.schema === undefined) {
      try {
        this.schema = JSON.parse(
          readFileSync(fileURLToPath(new URL("./strategy-response.schema.json", import.meta.url)), "utf-8"),
        ) as Record<string, unknown>;
      } catch {
        this.schema = null;
      }
    }
    return this.schema;
  }

  constructor(
    client: MistralClient,
    memoryPath: string,
    cb: StrategyEvents = {},
    style = "",
    limits: Partial<StrategyLimits> = {},
  ) {
    this.client = client;
    this.memoryPath = memoryPath;
    this.cb = cb;
    this.style = style;
    this.limits = { ...DEFAULT_STRATEGY_LIMITS, ...limits };
  }

  get tracker(): EpochTracker {
    return this.epochTracker;
  }

  get currentNotes(): string {
    return this.notes;
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.memoryPath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<MemoryFile>;
      this.memory = {
        memory: parsed.memory ?? null,
        notes: typeof parsed.notes === "string" ? parsed.notes : "",
        games: Array.isArray(parsed.games) ? parsed.games : [],
      };
    } catch {
      this.memory = { memory: null, notes: "", games: [] };
    }
  }

  startEpoch(s: GameState): void {
    this.epochTracker.reset(s, Date.now());
  }

  // Opening consultation (once per session, before the first game): the model
  // picks its starting params from persisted memory and past games, instead
  // of the executor opening on factory defaults.
  async openingStrategy(s: GameState): Promise<ExecutorParams | null> {
    return this.askModel(
      "A new session is starting. Set your opening strategy.",
      {
        state: compactState(s),
        memory: this.memory.memory,
        previousGames: this.recentGames(),
      },
    );
  }

  // Epoch update: returns tuned executor params (or null to keep current).
  async epochUpdate(s: GameState): Promise<ExecutorParams | null> {
    const report = this.epochTracker.report(s, Date.now());
    return this.askModel(
      `Epoch ${report.epoch} finished. Adjust your strategy.`,
      {
        epochReport: report,
        state: compactState(s),
        memory: this.memory.memory,
        previousGames: this.recentGames(),
      },
    );
  }

  // Wave intermission: the model retunes for the incoming wave (deeper start,
  // faster fire) before play resumes.
  async wavePlan(s: GameState): Promise<ExecutorParams | null> {
    return this.askModel(
      `Wave ${s.wave} cleared. Retune your strategy for the next wave.`,
      {
        state: compactState(s),
        memory: this.memory.memory,
        previousGames: this.recentGames(),
      },
    );
  }

  // Post-mortem after a game ends: the model writes a per-game strategy
  // summary, tunes for the next game, and cleans up its own memory
  // (deduplication, redundancy removal).
  async postMortem(s: GameState, gameNumber: number): Promise<void> {
    const outcome =
      s.lives <= 0 ? "ran out of lives" : "a rodent reached the lasagna line";
    const record: GameRecord = {
      game: gameNumber,
      score: s.score,
      wave: s.wave,
      lives: s.lives,
      outcome,
    };
    this.memory.games.push(record);
    const resp = await this.askModelRaw(
      `Game ${gameNumber} is over (${outcome}). ` +
        "Write gameSummary: one concise strategy summary of this game (under 80 words) — " +
        "what worked, what failed, and the single most important change for the next game. " +
        "Then adjust your params and memory accordingly. " +
        "MEMORY CLEANUP: consolidate the memory you return — merge duplicated lessons, " +
        "combine near-identical strategies (e.g. repeated parameterHistory entries), remove " +
        "redundant, outdated or contradicted observations, and drop anything no longer useful. " +
        "The cleaned memory must stay under 300 words.",
      {
        gameResult: record,
        state: compactState(s),
        memory: this.memory.memory,
        previousGames: this.recentGames(),
      },
    );
    if (resp) {
      record.summary = resp.gameSummary || resp.notes;
      record.finalParams = this.lastParams ?? undefined;
    }
    await this.save();
  }

  // The most recent finished games (summaries + stats) for prompt context.
  private recentGames(): GameRecord[] {
    const n = Math.max(0, this.limits.contextGames);
    return n === 0 ? [] : this.memory.games.slice(-n);
  }

  private async askModel(instruction: string, payload: unknown): Promise<ExecutorParams | null> {
    const resp = await this.askModelRaw(instruction, payload);
    return resp ? normalizeParams(resp.params) : null;
  }

  private async askModelRaw(instruction: string, payload: unknown): Promise<StrategyResponse | null> {
    const messages = [
      { role: "system", content: systemPrompt(this.style) },
      { role: "user", content: `${instruction}\n\n${JSON.stringify(payload)}` },
    ] as Array<{ role: "system" | "user" | "assistant"; content: string }>;
    try {
      this.cb.onStrategyStart?.(); // spinner or reasoning stream begins
      const schema = this.loadSchema();
      const text = await this.client.chat(
        messages,
        {
          ...(schema ? { responseSchema: schema } : { json: true }),
          maxTokens: 12000,
        },
        (kind, delta) => {
          if (kind === "thinking") this.cb.onThinkingDelta?.(delta);
        },
      );
      const resp = parseStrategyResponse(text);
      if (!resp) {
        await this.writeDiagnostics(text);
        this.cb.onLlmError?.(
          "model returned unparseable JSON; keeping current params; raw response dumped to diagnostic.txt",
        );
        return null;
      }
      const params = normalizeParams(resp.params);
      this.lastParams = params;
      this.memory.memory = resp.memory ?? this.memory.memory;
      this.notes = resp.notes;
      this.cb.onStrategy?.(resp.notes, params);
      await this.save();
      return resp;
    } catch (e) {
      this.cb.onLlmError?.(`${(e as Error).message}; keeping current params`);
      return null;
    } finally {
      this.cb.onThinkingEnd?.();
    }
  }

  // Dump an unparseable model answer for offline inspection: appended to
  // diagnostic.txt next to the memory file, one timestamped entry per failure.
  private async writeDiagnostics(text: string): Promise<void> {
    const file = path.join(path.dirname(this.memoryPath), "diagnostic.txt");
    try {
      await mkdir(path.dirname(file), { recursive: true });
      await appendFile(file, `[${new Date().toISOString()}] unparseable strategy response:\n${text}\n\n`);
    } catch (e) {
      this.cb.onLlmError?.(`diagnostic write failed: ${(e as Error).message}`);
    }
  }

  private async save(): Promise<void> {
    // retention cap: keep only the newest game records in the file
    const max = Math.max(0, this.limits.maxMemoryGames);
    this.memory.games = max === 0 ? [] : this.memory.games.slice(-max);
    try {
      await mkdir(path.dirname(this.memoryPath), { recursive: true });
      await writeFile(this.memoryPath, JSON.stringify(this.memory, null, 2));
    } catch (e) {
      this.cb.onLlmError?.(`memory save failed: ${(e as Error).message}`);
    }
  }
}
