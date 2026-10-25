// Strategic brain integration: every epoch (default 10 s) the harness pauses
// the game, sends the state + epoch report + persistent memory to Mistral,
// and the model returns a tuned parameter set for the local executor plus an
// updated memory object. Memory survives epochs, games and sessions (JSON file)
// so the model can learn across runs.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { GameState } from "../types.ts";
import type { ChatMessage } from "../llm/mistral.ts";
import { MistralClient } from "../llm/mistral.ts";
import type { ExecutorParams } from "../policy/heuristic.ts";
import { DEFAULT_EXECUTOR_PARAMS } from "../policy/heuristic.ts";

export interface EpochReport {
  epoch: number;
  durationS: number;
  scoreStart: number;
  scoreEnd: number;
  shotsFired: number;
  hits: number;
  roombaHits: number;
  livesStart: number;
  livesEnd: number;
  wave: number;
  rodentsAlive: number;
  waveCleared: boolean;
  events: string[];
}

export interface StrategyResponse {
  params: Partial<ExecutorParams>;
  notes: string;
  memory: unknown;
}

interface MemoryFile {
  memory: unknown;
  notes: string;
  games: Array<{
    game: number;
    score: number;
    wave: number;
    lives: number;
    outcome: string;
  }>;
}

const EMPTY_MEMORY: MemoryFile = { memory: null, notes: "", games: [] };

// ---------- prompt ----------

export function systemPrompt(): string {
  return [
    "You are the strategic brain of an AI harness that plays Verminvaders, a Space-Invaders-style game.",
    "You do NOT control the cat directly. A local executor aims, predicts the rodent march,",
    "leads the Roomba, and dodges crumbs, guided by numeric parameters you set.",
    "",
    "GAME RULES:",
    "- Arena 480x600. Cat at y=536, glides at 322 px/s, x clamped to 36..444. 3 lives, 2 s invulnerability after a hit.",
    "- Furball spawns at cat.x+18 (muzzle offset), flies up at 430 px/s. Max ONE furball in flight at a time.",
    "- Rodents: 5 rows x 8 cols (rows 0-1 are rats, 30 pts; row 2 mice 20 pts; others 10 pts).",
    "  They march in 12 px steps (16 px drops at walls), firing faster as waves progress.",
    "- Crumbs fall straight down at 130+14*wave px/s. A crumb hitting the cat costs a life.",
    "- 4 furniture shields at y=392 erode when hit by either side; a furball hitting a shield is consumed.",
    "- Roomba bonus target (200 pts) crosses the top at 95 px/s, ~6 s on screen.",
    "- Game over at 0 lives OR any rodent reaching y>=510 (the lasagna line).",
    "- Each wave starts lower and fires faster; clearing a wave takes 2.2 s.",
    "",
    "EXECUTOR (runs every ~80 ms): picks a target (Roomba or rodent), walks to the aim position,",
    "shoots only when stationary and no furball is airborne, never stands in a falling crumb's column,",
    "dodges crumbs that would land within dodgeHorizonS, accepts hits closer than acceptHitBelowS,",
    "avoids shooting through intact shields by shieldPenalty, and may chew one hole per shield if chewShields.",
    "",
    "YOUR JOB: every epoch you get the game state, an epoch report and your persistent memory.",
    "Reason about what worked and what failed, then return a tuned parameter set and update your memory.",
    "Memory persists across epochs, games, and sessions: keep lessons learned, parameter history,",
    "and observations concise (under 300 words). Your goal: clear waves fast, lose as few lives as possible.",
    "",
    'Answer ONLY with a JSON object of this shape:',
    "{",
    '  "params": {',
    '    "roombaFirst": true | false,',
    '    "lowestRowWeight": number 0..10,   // urgency of deep rodents (deeper = closer to the lasagna line)',
    '    "pointsWeight": number 0..10,     // how much rodent points matter in target choice',
    '    "shieldPenalty": number 0..5000,  // 0 = shoot through shields freely, high = avoid shielded corridors',
    '    "chewShields": true | false,      // allow one deliberate shot into an intact shield to open a hole',
    '    "dodgeHorizonS": number 0.3..1.6, // react to crumbs landing within this window',
    '    "acceptHitBelowS": number 0.05..0.5, // stop dodging when impact is nearer than this',
    '    "corridorMarginPx": number 4..20  // safety margin kept from crumb columns',
    "  },",
    '  "notes": "one short paragraph summarizing your reasoning this epoch",',
    '  "memory": { ...your persistent state, any JSON shape you want... }',
    "}",
  ].join("\n");
}

// ---------- normalization ----------

function clamp(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? v : fallback;
  return Math.max(min, Math.min(max, n));
}

export function normalizeParams(raw: unknown): ExecutorParams {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    roombaFirst: typeof r.roombaFirst === "boolean" ? r.roombaFirst : DEFAULT_EXECUTOR_PARAMS.roombaFirst,
    lowestRowWeight: clamp(r.lowestRowWeight, 0, 10, DEFAULT_EXECUTOR_PARAMS.lowestRowWeight),
    pointsWeight: clamp(r.pointsWeight, 0, 10, DEFAULT_EXECUTOR_PARAMS.pointsWeight),
    shieldPenalty: clamp(r.shieldPenalty, 0, 5000, DEFAULT_EXECUTOR_PARAMS.shieldPenalty),
    chewShields: typeof r.chewShields === "boolean" ? r.chewShields : DEFAULT_EXECUTOR_PARAMS.chewShields,
    dodgeHorizonS: clamp(r.dodgeHorizonS, 0.3, 1.6, DEFAULT_EXECUTOR_PARAMS.dodgeHorizonS),
    acceptHitBelowS: clamp(r.acceptHitBelowS, 0.05, 0.5, DEFAULT_EXECUTOR_PARAMS.acceptHitBelowS),
    corridorMarginPx: clamp(r.corridorMarginPx, 4, 20, DEFAULT_EXECUTOR_PARAMS.corridorMarginPx),
  };
}

export function parseStrategyResponse(text: string): StrategyResponse | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // models sometimes wrap JSON in prose; try the outermost braces
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      parsed = JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
  const obj = parsed as Record<string, unknown>;
  if (!obj || typeof obj !== "object") return null;
  return {
    params: (obj.params ?? {}) as Partial<ExecutorParams>,
    notes: typeof obj.notes === "string" ? obj.notes : "",
    memory: obj.memory ?? null,
  };
}

// ---------- epoch tracker ----------

export class EpochTracker {
  private epoch = 0;
  private startedAt = 0;
  private scoreStart = 0;
  private livesStart = 3;
  private shots = 0;
  private hits = 0;
  private roombaHits = 0;
  private events: string[] = [];
  private roombaWasPresent = false;

  reset(s: GameState, now: number): void {
    this.epoch++;
    this.startedAt = now;
    this.scoreStart = s.score;
    this.livesStart = s.lives;
    this.shots = 0;
    this.hits = 0;
    this.roombaHits = 0;
    this.events = [];
    this.roombaWasPresent = s.roomba !== null;
  }

  noteShot(): void {
    this.shots++;
  }

  observe(prev: GameState, s: GameState): void {
    if (s.score > prev.score) {
      this.hits++;
      if (s.score - prev.score >= 200) this.roombaHits++;
    }
    if (s.lives < prev.lives) {
      this.events.push(`life lost (crumb) while cat near x=${Math.round(s.cat.x)}, wave ${s.wave}, ${s.rods.length} rodents left`);
    }
    if (this.roombaWasPresent && !s.roomba && s.score - prev.score < 200 && this.roombaHits === 0) {
      this.events.push("roomba crossed the screen without being intercepted");
    }
    if (prev.phase === "playing" && s.phase === "waveclear") {
      this.events.push(`wave ${prev.wave} cleared`);
    }
    this.roombaWasPresent = s.roomba !== null;
  }

  report(s: GameState, now: number): EpochReport {
    return {
      epoch: this.epoch,
      durationS: Math.round(((now - this.startedAt) / 1000) * 10) / 10,
      scoreStart: this.scoreStart,
      scoreEnd: s.score,
      shotsFired: this.shots,
      hits: this.hits,
      roombaHits: this.roombaHits,
      livesStart: this.livesStart,
      livesEnd: s.lives,
      wave: s.wave,
      rodentsAlive: s.rods.length,
      waveCleared: s.phase === "waveclear",
      events: this.events,
    };
  }
}

// ---------- strategy controller ----------

export interface StrategyEvents {
  onStrategy?: (notes: string, params: ExecutorParams) => void;
  onLlmError?: (message: string) => void;
}

export class StrategyController {
  private client: MistralClient;
  private memoryPath: string;
  private memory: MemoryFile = { ...EMPTY_MEMORY };
  private epochTracker = new EpochTracker();
  private cb: StrategyEvents;
  private notes = "";

  constructor(client: MistralClient, memoryPath: string, cb: StrategyEvents = {}) {
    this.client = client;
    this.memoryPath = memoryPath;
    this.cb = cb;
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
      this.memory = { ...EMPTY_MEMORY };
    }
  }

  startEpoch(s: GameState): void {
    this.epochTracker.reset(s, Date.now());
  }

  // Epoch update: returns tuned executor params (or null to keep current).
  async epochUpdate(s: GameState): Promise<ExecutorParams | null> {
    const report = this.epochTracker.report(s, Date.now());
    return this.askModel(
      `Epoch ${report.epoch} finished. Adjust your strategy.`,
      { epochReport: report, state: compactState(s), memory: this.memory.memory, previousGames: this.memory.games },
    );
  }

  // Post-mortem after a game ends; feeds the outcome into the memory.
  async postMortem(s: GameState, gameNumber: number): Promise<void> {
    const outcome =
      s.lives <= 0 ? "ran out of lives" : "a rodent reached the lasagna line";
    const result = {
      game: gameNumber,
      score: s.score,
      wave: s.wave,
      lives: s.lives,
      outcome,
    };
    this.memory.games.push(result);
    await this.askModel(
      `Game ${gameNumber} is over (${outcome}). Summarize what to do differently next game.`,
      { gameResult: result, state: compactState(s), memory: this.memory.memory, previousGames: this.memory.games },
    );
    await this.save();
  }

  private async askModel(instruction: string, payload: unknown): Promise<ExecutorParams | null> {
    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt() },
      { role: "user", content: `${instruction}\n\n${JSON.stringify(payload)}` },
    ];
    try {
      const text = await this.client.chat(messages, { json: true, maxTokens: 8000 });
      const resp = parseStrategyResponse(text);
      if (!resp) {
        this.cb.onLlmError?.("model returned unparseable JSON; keeping current params");
        return null;
      }
      const params = normalizeParams(resp.params);
      this.memory.memory = resp.memory ?? this.memory.memory;
      this.notes = resp.notes;
      this.cb.onStrategy?.(resp.notes, params);
      await this.save();
      return params;
    } catch (e) {
      this.cb.onLlmError?.(`${(e as Error).message}; keeping current params`);
      return null;
    }
  }

  private async save(): Promise<void> {
    try {
      await mkdir(path.dirname(this.memoryPath), { recursive: true });
      await writeFile(this.memoryPath, JSON.stringify(this.memory, null, 2));
    } catch (e) {
      this.cb.onLlmError?.(`memory save failed: ${(e as Error).message}`);
    }
  }
}

// Compact state for the prompt: same fields, rounded for fewer tokens.
function compactState(s: GameState): Record<string, unknown> {
  return {
    ...s,
    cat: { x: Math.round(s.cat.x), y: s.cat.y },
    crumbs: s.crumbs.map((c) => ({ x: Math.round(c.x), y: Math.round(c.y), vy: c.vy })),
    rods: s.rods.map((r) => ({ x: Math.round(r.x), y: Math.round(r.y), row: r.row, col: r.col, rat: r.rat, points: r.points })),
    furball: s.furball ? { x: Math.round(s.furball.x), y: Math.round(s.furball.y) } : null,
    roomba: s.roomba ? { x: Math.round(s.roomba.x), vx: s.roomba.vx } : null,
    shields: s.shields.map((sh) => ({ x: sh.x, w: sh.w, cellsLeft: sh.cellsLeft })),
  };
}
