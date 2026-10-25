// Harness driver: connect(), tick(), run(), stop() per spec section 7.
// Handles phase transitions, auto-restart, considered-mode pause wrapping
// with a finally-resume watchdog, and feeds the fat-cat persona + stats.

import type {
  Decision,
  GameState,
  HarnessCallbacks,
  Policy,
  RunOptions,
} from "../types/index.d.ts";
import { Connection } from "./connection.ts";
import { Stats } from "./stats.ts";
import type { StrategyController } from "./strategy-controller.ts";
import { BRIDGE_TIMEOUT_MS } from "../constants/index.ts";
import { sleep } from "./sleep.ts";
import type { Persona } from "../persona/persona.ts";
import { c } from "../ui/colors.ts";

export class Harness {
  private conn: Connection;
  private policy: Policy;
  private persona: Persona;
  private opts: RunOptions;
  private cb: HarnessCallbacks;
  private strategy: StrategyController | null;
  private stats = new Stats();
  private running = false;
  private gamesStarted = 0;
  private lastPhase = "";
  private prevState: GameState | null = null;
  private nextStrategyAt = 0;
  private epochNeedsStart = true;
  private wavePlanPending = false;

  constructor(
    conn: Connection,
    policy: Policy,
    persona: Persona,
    opts: RunOptions,
    cb: HarnessCallbacks = {},
    strategy: StrategyController | null = null,
  ) {
    this.conn = conn;
    this.policy = policy;
    this.persona = persona;
    this.opts = opts;
    this.cb = cb;
    this.strategy = strategy;
  }

  // Poll for window.verminvaders until present; fail with a clear message
  // after 10 s (spec section 8).
  async connect(): Promise<boolean> {
    const deadline = Date.now() + BRIDGE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (await this.conn.hasBridge()) {
        this.persona.event("boot");
        return true;
      }
      await sleep(100);
    }
    throw new Error("bridge not found: window.verminvaders missing after 10 s");
  }

  // One decide-act cycle.
  async tick(): Promise<void> {
    let s: GameState;
    try {
      s = await this.conn.readState();
    } catch (e) {
      this.log(`state read failed: ${(e as Error).message}`);
      await this.conn.stopInputs().catch(() => {});
      return;
    }
    this.observeTransitions(s);

    try {
      if (s.phase === "title" || s.phase === "gameover") {
        await this.handleRestart(s);
        return;
      }
      if (s.phase === "waveclear") {
        await this.handleWavePlan(s); // re-plan during the intermission
        return; // no commands while the wave-clear banner shows
      }
      if (this.strategy) {
        if (this.epochNeedsStart) {
          this.strategy.startEpoch(s);
          this.epochNeedsStart = false;
          this.nextStrategyAt = Date.now() + this.opts.epochMs;
        } else if (Date.now() >= this.nextStrategyAt) {
          await this.updateStrategy(s);
          return; // re-decide on the next tick with fresh params
        }
      }
      await this.playOneCycle(s);
    } catch (e) {
      // never leave the game frozen or inputs held after a policy crash
      this.log(`tick error: ${(e as Error).message}`);
      await this.conn.stopInputs().catch(() => {});
      await this.conn.resume().catch(() => {});
    }
  }

  private async playOneCycle(s: GameState): Promise<void> {
    if (this.opts.mode === "considered") {
      await this.conn.pause();
      try {
        const fresh = await this.conn.readState();
        const d = this.policy.decide(fresh);
        await this.act(s, d);
      } finally {
        await this.conn.resume().catch(() => {});
      }
    } else {
      const d = this.policy.decide(s);
      await this.act(s, d);
    }
  }

  private async act(s: GameState, d: Decision): Promise<void> {
    if (d.shoot) this.stats.noteShot();
    const res = await this.conn.apply(d);
    if (res.shot) this.strategy?.tracker.noteShot();
    if (res.shot && this.opts.logLevel === "verbose") {
      this.log(`shot from x=${s.cat.x + 18} (latency ${Math.round(this.conn.latencyMs)} ms)`);
    }
    if (this.policyReason() === "dodge") {
      this.persona.event("dodge");
    }
  }

  // Epoch boundary: pause the game, let Mistral reason about the finished
  // epoch, apply the tuned params, start a new epoch, resume.
  private async updateStrategy(s: GameState): Promise<void> {
    if (!this.strategy) return;
    this.log("epoch finished; asking Mistral for a new strategy...");
    await this.conn.pause();
    try {
      const fresh = await this.conn.readState();
      const params = await this.strategy.epochUpdate(fresh);
      if (params) {
        (this.policy as unknown as { setParams(p: unknown): void }).setParams(params);
      }
      this.strategy.startEpoch(fresh);
      this.nextStrategyAt = Date.now() + this.opts.epochMs;
    } finally {
      // watchdog: a crash in the LLM path must never leave the game frozen
      await this.conn.resume().catch(() => {});
    }
  }

  // Wave intermission: pause the frozen banner, let Mistral retune for the
  // incoming wave, apply the params, resume. Runs once per cleared wave.
  private async handleWavePlan(s: GameState): Promise<void> {
    if (!this.wavePlanPending || !this.strategy) return;
    this.wavePlanPending = false;
    this.log(`wave ${s.wave} cleared; asking Mistral for the next wave's strategy...`);
    await this.conn.pause();
    try {
      const fresh = await this.conn.readState();
      const params = await this.strategy.wavePlan(fresh);
      if (params) {
        (this.policy as unknown as { setParams(p: unknown): void }).setParams(params);
      }
    } finally {
      // watchdog: a crash in the LLM path must never leave the game frozen
      await this.conn.resume().catch(() => {});
    }
  }

  private policyReason(): string {
    const p = this.policy as unknown as { lastReason?: string };
    return p.lastReason ?? "";
  }

  private async handleRestart(s: GameState): Promise<void> {
    // post-mortem: feed the game outcome into the model's memory
    // (also on the last game of the session)
    if (s.phase === "gameover" && this.strategy) {
      await this.conn.pause();
      try {
        await this.strategy.postMortem(s, this.gamesStarted);
      } finally {
        await this.conn.resume().catch(() => {});
      }
    }
    if (this.gamesStarted >= this.opts.maxGames) {
      this.cb.onSessionSummary?.(this.stats.sessionSummary(Date.now()));
      this.persona.event("sessionEnd");
      this.stop();
      return;
    }
    // opening consultation: the first game starts on model-tuned params
    // informed by persisted memory, not on executor defaults
    if (this.gamesStarted === 0 && this.strategy) {
      this.log("asking Mistral for an opening strategy...");
      const params = await this.strategy.openingStrategy(s);
      if (params) {
        (this.policy as unknown as { setParams(p: unknown): void }).setParams(params);
      }
    }
    await this.conn.start();
    this.gamesStarted++;
    this.policy.reset();
    this.stats.gameStartEvent(Date.now(), s.wave, s.lives);
    this.epochNeedsStart = true;
    this.wavePlanPending = false;
    this.persona.event("gameStart");
  }

  private observeTransitions(s: GameState): void {
    const prev = this.prevState;

    if (prev) {
      this.strategy?.tracker.observe(prev, s);
      if (s.score > prev.score) this.stats.noteHit(s.score - prev.score);
      if (s.lives < prev.lives) {
        this.stats.noteLifeLost();
        this.persona.event("lifeLost", `(lives: ${s.lives})`);
      }
      if (s.score - prev.score >= 200) {
        this.persona.event("roombaHit", `(+${s.score - prev.score})`);
      }
      if (prev.phase === "playing" && s.phase === "waveclear") {
        this.wavePlanPending = true; // ask for a next-wave plan during the banner
        const sum = this.stats.waveSummary(Date.now(), s.score, s.lives);
        this.cb.onWaveSummary?.(sum.wave, sum.score, sum.lives, sum.durationS);
        this.persona.event("waveClear", `(wave ${sum.wave}, score ${sum.score})`);
      }
      if (prev.phase === "waveclear" && s.phase === "playing") {
        this.stats.waveStartEvent(Date.now(), s.wave, s.lives, s.score);
      }
      if (prev.phase === "playing" && s.phase === "gameover") {
        this.persona.event("gameOver", `(score ${s.score})`);
        this.cb.onGameOver?.(s.score);
      }
    }
    this.stats.noteBestScore(s.score);
    this.prevState = s;

    if (s.phase !== this.lastPhase) {
      // every transition clears held inputs (spec section 5.3)
      this.conn.stopInputs().catch(() => {});
      this.lastPhase = s.phase;
    }

    if (s.phase === "playing") this.persona.event("idle");
  }

  // Main loop. Resolves when the session ends (maxGames reached) or stop().
  async run(options?: Partial<RunOptions>): Promise<void> {
    this.opts = { ...this.opts, ...options };
    this.running = true;
    this.stats.sessionStart(Date.now());
    while (this.running) {
      const started = Date.now();
      await this.tick();
      const budget = this.opts.pollMs - (Date.now() - started);
      if (this.running && budget > 0) await sleep(budget);
    }
    // clean shutdown: never leave the game paused or inputs held
    await this.conn.stopInputs().catch(() => {});
    await this.conn.resume().catch(() => {});
  }

  stop(): void {
    this.running = false;
  }

  private log(msg: string): void {
    if (this.opts.logLevel !== "silent") console.error(c.dim(`[harness] ${msg}`));
  }
}
