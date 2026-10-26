// Collects what happened during one strategy epoch: score, shots, lives,
// crumb firing statistics, near misses and notable events.

import type { EpochReport, GameState } from "../types/index.d.ts";
import { CAT_DIR_EPS_PX, CAT_HALF_WIDTH } from "../constants/index.ts";

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
  private crumbsFired = 0;
  private crumbSpawnCols: number[] = [];
  private nearMisses = 0;
  private nearMissSeen = new Set<number>();
  // movement telemetry: glide distance, direction reversals, reason census
  private catDistancePx = 0;
  private catDirectionChanges = 0;
  private lastDir = 0;
  private decisionReasons: Record<string, number> = {};

  // New game: the epoch counter is per-game — the first epoch of every
  // game reports as epoch 1 (the system prompt promises exactly that).
  beginGame(): void {
    this.epoch = 0;
  }

  reset(s: GameState, now: number): void {
    this.epoch++;    this.startedAt = now;
    this.scoreStart = s.score;
    this.livesStart = s.lives;
    this.shots = 0;
    this.hits = 0;
    this.roombaHits = 0;
    this.events = [];
    this.roombaWasPresent = s.roomba !== null;
    this.crumbsFired = 0;
    this.crumbSpawnCols = new Array<number>(s.formation.cols).fill(0);
    this.nearMisses = 0;
    this.nearMissSeen.clear();
    this.catDistancePx = 0;
    this.catDirectionChanges = 0;
    this.lastDir = 0;
    this.decisionReasons = {};
  }

  noteShot(): void {
    this.shots++;
  }

  observe(prev: GameState, s: GameState, reason = ""): void {
    if (s.score > prev.score) {
      this.hits++;
      if (s.score - prev.score >= 200) this.roombaHits++;
    }
    this.observeMovement(prev, s);
    if (reason) this.decisionReasons[reason] = (this.decisionReasons[reason] ?? 0) + 1;
    if (s.lives < prev.lives) {
      this.events.push(`life lost (crumb) while cat near x=${Math.round(s.cat.x)}, wave ${s.wave}, ${s.rods.length} rodents left`);
    }
    if (this.roombaWasPresent && !s.roomba && s.score - prev.score < 200 && this.roombaHits === 0) {
      this.events.push("roomba crossed the screen without being intercepted");
    }
    if (prev.phase === "playing" && s.phase === "waveclear") {
      this.events.push(`wave ${prev.wave} cleared`);
    }
    this.observeCrumbFire(prev, s);
    this.roombaWasPresent = s.roomba !== null;
  }

  // Movement telemetry: glide distance and direction reversals. Deltas
  // below CAT_DIR_EPS_PX count as standing still, so the direction memory
  // survives brief pauses without spuriously counting reversals.
  private observeMovement(prev: GameState, s: GameState): void {
    const dx = s.cat.x - prev.cat.x;
    this.catDistancePx += Math.abs(dx);
    if (Math.abs(dx) >= CAT_DIR_EPS_PX) {
      const dir = dx > 0 ? 1 : -1;
      if (this.lastDir !== 0 && dir !== this.lastDir) this.catDirectionChanges++;
      this.lastDir = dir;
    }
  }

  // New crumbs = present in s but not in prev. Crumb x never changes (they
  // fall straight), so identity matching is: same x, y increased modestly.
  private observeCrumbFire(prev: GameState, s: GameState): void {
    if (this.crumbSpawnCols.length !== s.formation.cols) return; // epoch not started
    for (const c of s.crumbs) {
      const carried = prev.crumbs.some(
        (p) => p.x === c.x && c.y >= p.y - 5 && c.y - p.y < 140,
      );
      if (carried) continue;
      this.crumbsFired++;
      // spawn x = gx + col*stepX + w/2 - 5 with w in {30, 36}: nearest column
      const col = Math.round(
        (c.x + 5 - prev.formation.x - 16) / prev.formation.stepX,
      );
      if (col >= 0 && col < this.crumbSpawnCols.length) this.crumbSpawnCols[col]++;
      this.events.push(
        `crumb fired from column ${Math.max(0, col)} (x=${Math.round(c.x)})`,
      );
    }
    // near misses: crumbs crossing the cat band just outside the hitbox
    for (const c of s.crumbs) {
      if (c.y + c.h < 500 || this.nearMissSeen.has(c.x)) continue;
      const dx = Math.abs(c.x + c.w / 2 - s.cat.x);
      if (dx > CAT_HALF_WIDTH && dx < CAT_HALF_WIDTH + 30) {
        this.nearMisses++;
        this.nearMissSeen.add(c.x);
        this.events.push(`near miss: crumb passed ${Math.round(dx - CAT_HALF_WIDTH)}px from the cat at x=${Math.round(c.x)}`);
      }
    }
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
      crumbsFired: this.crumbsFired,
      crumbSpawnCols: [...this.crumbSpawnCols],
      nearMisses: this.nearMisses,
      events: this.events,
      catDistancePx: Math.round(this.catDistancePx),
      catDirectionChanges: this.catDirectionChanges,
      decisionReasons: { ...this.decisionReasons },
    };
  }
}
