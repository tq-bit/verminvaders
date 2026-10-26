// Harness driver: connect(), tick(), run(), stop() per spec section 7.
// Handles phase transitions, auto-restart, considered-mode pause wrapping
// with a finally-resume watchdog, and feeds the fat-cat persona + stats.
// In async strategy mode (--strategy-mode async) the game never pauses for
// the model: consultations run in the background and their params are
// applied at the next tick boundary when they land.

import type {
  Decision,
  ExecutorParams,
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
  // async mode: params from a finished background consultation, applied at
  // the next tick boundary; consultInFlight paces epoch consultations
  private pendingParams: ExecutorParams | null = null;
  private consultInFlight = false;

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
      // a background consultation finished: its params apply here, at the
      // tick boundary — the executor never switches plans mid-tick
      await this.applyPendingParams();
      // epoch updates run only when an epoch length is configured; without
      // --epoch-ms the wave is the strategy period: no mid-wave stops, the
      // wave plan at the waveclear intermission is the mid-game consultation
      if (this.strategy && this.opts.epochMs !== undefined) {
        if (this.epochNeedsStart) {
          this.strategy.startEpoch(s);
          this.epochNeedsStart = false;
          this.nextStrategyAt = Date.now() + (this.opts.epochMs ?? 0);
        } else if (Date.now() >= this.nextStrategyAt) {
          await this.updateStrategy(s);
          // paused mode re-decides on the next tick with fresh params; in
          // async mode the consultation runs in the background and this
          // tick keeps playing with the params already in force
          if (this.opts.strategyMode !== "async") return;
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

  // Apply tuned params: the executor weights go to the policy, the vermin
  // seed goes to the game itself (it steers the crumb schedule, not the cat).
  private async applyParams(params: ExecutorParams): Promise<void> {
    (this.policy as unknown as { setParams(p: unknown): void }).setParams(params);
    await this.conn.setVerminSeed(params.verminSeed).catch(() => {});
  }

  // Params from a finished background consultation (async mode): applied at
  // the tick boundary so the executor re-decides with them on the same tick.
  private async applyPendingParams(): Promise<void> {
    if (!this.pendingParams) return;
    const params = this.pendingParams;
    this.pendingParams = null;
    this.log("background strategy finished; applying new params");
    await this.applyParams(params);
  }

  // Presentation hold at the wave boundary (--intermission-ms): freeze the
  // freshly shown banner for a moment so the transition is not abrupt, then
  // let the game's own countdown finish and the next wave start. The freeze
  // is deliberate pacing, not model waiting — consultations keep running.
  private async holdIntermission(): Promise<void> {
    const hold = this.opts.intermissionMs ?? 0;
    if (hold <= 0) return;
    await this.conn.pause();
    try {
      await sleep(hold);
    } finally {
      await this.conn.resume().catch(() => {});
    }
  }

  // Epoch boundary. Paused mode: freeze the game, let Mistral reason about
  // the finished epoch, apply the tuned params, start a new epoch, resume.
  // Async mode: fire the consultation in the background and keep playing —
  // the tuned params are applied at the next tick boundary after they land.
  private async updateStrategy(s: GameState): Promise<void> {
    if (!this.strategy) return;
    if (this.opts.strategyMode === "async") {
      if (this.consultInFlight) return; // still busy: retry on a later tick
      this.log("epoch finished; strategizing in the background...");
      this.consultInFlight = true;
      const fresh = await this.conn.readState();
      // epochUpdate snapshots the epoch report synchronously before its
      // first await, so resetting the tracker below cannot corrupt it
      this.strategy
        .epochUpdate(fresh)
        .then((params) => {
          if (params) this.pendingParams = params;
        })
        .catch(() => {}) // askModelRaw already reports LLM errors
        .finally(() => {
          this.consultInFlight = false;
        });
      this.strategy.startEpoch(fresh); // the next epoch collects from now on
      this.nextStrategyAt = Date.now() + (this.opts.epochMs ?? 0);
      return;
    }
    this.log("epoch finished; asking Mistral for a new strategy...");
    await this.conn.pause();
    try {
      const fresh = await this.conn.readState();
      const params = await this.strategy.epochUpdate(fresh);
      if (params) await this.applyParams(params);
      this.strategy.startEpoch(fresh);
      this.nextStrategyAt = Date.now() + (this.opts.epochMs ?? 0);
    } finally {
      // watchdog: a crash in the LLM path must never leave the game frozen
      await this.conn.resume().catch(() => {});
    }
  }

  // Wave intermission. Paused mode: freeze the banner, let Mistral retune
  // for the incoming wave, apply the params, resume. Async mode: fire the
  // re-plan in the background and let the intermission run its course — the
  // params apply whenever the model returns. Runs once per cleared wave and
  // RESETS the epoch clock — otherwise an epoch deadline that expired
  // during the intermission would fire a second consultation on resume.
  private async handleWavePlan(s: GameState): Promise<void> {
    if (!this.wavePlanPending) return;
    this.wavePlanPending = false;
    await this.holdIntermission();
    if (!this.strategy) return;
    this.log(`wave ${s.wave} cleared; asking Mistral for the next wave's strategy...`);
    if (this.opts.strategyMode === "async") {
      const fresh = await this.conn.readState();
      this.strategy
        .wavePlan(fresh)
        .then((params) => {
          if (params) this.pendingParams = params;
        })
        .catch(() => {}); // askModelRaw already reports LLM errors
      this.nextStrategyAt = Date.now() + (this.opts.epochMs ?? 0);
      return;
    }
    await this.conn.pause();
    try {
      const fresh = await this.conn.readState();
      const params = await this.strategy.wavePlan(fresh);
      if (params) await this.applyParams(params);
      this.nextStrategyAt = Date.now() + (this.opts.epochMs ?? 0);
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
    // post-mortem: feed the game outcome into the model's memory and apply
    // the params it tuned for the next game (also on the last game).
    // Async mode: fire it in the background and start the next game right
    // away — the tuned params apply mid-play when they land.
    if (s.phase === "gameover" && this.strategy) {
      if (this.opts.strategyMode === "async") {
        this.log("game over; post-mortem strategizing in the background...");
        this.strategy
          .postMortem(s, this.gamesStarted)
          .then((params) => {
            if (params) this.pendingParams = params;
          })
          .catch(() => {}); // askModelRaw already reports LLM errors
      } else {
        await this.conn.pause();
        try {
          const params = await this.strategy.postMortem(s, this.gamesStarted);
          if (params) await this.applyParams(params);
        } finally {
          await this.conn.resume().catch(() => {});
        }
      }
    }
    if (this.gamesStarted >= this.opts.maxGames) {
      this.cb.onSessionSummary?.(this.stats.sessionSummary(Date.now()));
      this.persona.event("sessionEnd");
      this.stop();
      return;
    }
    // a new round begins: every payload now names this game, and the
    // per-game epoch counter restarts at 1
    this.strategy?.beginGame(this.gamesStarted + 1);
    // opening consultation: async mode starts game 1 immediately and the
    // model's opening plan applies a few seconds into the first wave;
    // paused mode waits for it so the game opens on tuned params.
    // Either way, the session first warms up on the last params the model
    // played with (persisted by the previous session's final post-mortem),
    // so a fresh session continues where the old one ended — the opening
    // consultation then refines them (and overrides them on success)
    if (this.gamesStarted === 0 && this.strategy) {
      const known = this.strategy.lastKnownParams();
      if (known) await this.applyParams(known);
      if (this.opts.strategyMode === "async") {
        this.log("asking Mistral for an opening strategy in the background...");
        this.strategy
          .openingStrategy(s)
          .then((params) => {
            if (params) this.pendingParams = params;
          })
          .catch(() => {}); // askModelRaw already reports LLM errors
      } else {
        this.log("asking Mistral for an opening strategy...");
        const params = await this.strategy.openingStrategy(s);
        if (params) await this.applyParams(params);
      }
    }
    // linger on the game-over screen for a moment before the next game
    // starts (--intermission-ms); the game-over state is static, so no
    // pause is needed here — the sleep simply delays start()
    if (s.phase === "gameover") {
      const hold = this.opts.intermissionMs ?? 0;
      if (hold > 0) await sleep(hold);
    }
    await this.conn.start();
    this.gamesStarted++;
    this.policy.reset();
    this.stats.gameStartEvent(Date.now(), s.wave, s.lives);
    this.epochNeedsStart = true;
    this.wavePlanPending = false;
    // drop params that already landed for the finished game (its last epoch
    // consult): the async post-mortem is still in flight and will set fresh
    // params when it lands — it is queued after any epoch consult, so the
    // game-over tuning always applies last
    this.pendingParams = null;
    this.persona.event("gameStart");
  }

  private observeTransitions(s: GameState): void {
    const prev = this.prevState;

    if (prev) {
      this.strategy?.tracker.observe(prev, s, this.policyReason());
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
