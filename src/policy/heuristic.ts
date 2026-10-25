// The heuristic executor policy (spec section 6): aims, leads, dodges and
// fires, guided by the ExecutorParams the strategic brain retunes each epoch.

import type { Decision, ExecutorParams, GameState, Policy, ShotPlan } from "../types/index.d.ts";
import {
  ARRIVAL_EPS,
  CAT_GLIDE_SPEED,
  DEFAULT_EXECUTOR_PARAMS,
  MIN_LEAD_MARGIN,
  MUZZLE_OFFSET,
} from "../constants/index.ts";
import {
  clampCatX,
  corridorBlocked,
  flightTime,
  glideTime,
  predictFormationX,
} from "./aim.ts";
import { fallingCrumbs, isSafeSpot, planDodge, threateningCrumbs } from "./dodge.ts";
import { hotCorridors, inHot } from "./hot-corridors.ts";
import { mulberry32 } from "./rng.ts";

// Per-row urgency, per-column targeting penalty and per-lives risk appetite
// derived from the structured params. livesRisk: 5 = neutral, 0 = defensive
// (avoid blocked corridors, dodge late hits), 10 = aggressive (chew shields,
// accept hits). Both formulas scale around 1.0 at risk 5.
function effectiveShieldPenalty(p: ExecutorParams, lives: number): number {
  const risk = p.livesRisk[Math.max(0, Math.min(2, lives - 1))] ?? 5;
  return p.shieldPenalty * (1.5 - risk / 10);
}

function effectiveAcceptBelowS(p: ExecutorParams, lives: number): number {
  const risk = p.livesRisk[Math.max(0, Math.min(2, lives - 1))] ?? 5;
  return Math.max(0.05, Math.min(0.5, p.acceptHitBelowS * (0.5 + risk / 10)));
}

export class HeuristicPolicy implements Policy {
  private params: ExecutorParams = { ...DEFAULT_EXECUTOR_PARAMS };
  // x positions where we intentionally chewed a shield hole this wave
  private holes: number[] = [];
  private wave = 0;
  // committed dodge destination (hysteresis): kept while it stays safe
  private dodgeTarget: number | null = null;
  // seeded stream for exploration sampling and aim jitter
  private rng: () => number = mulberry32(0);
  // for observability: why the last decision was what it was
  lastReason = "";

  constructor(params?: Partial<ExecutorParams>) {
    this.setParams(params);
    this.rng = mulberry32(this.params.rngSeed);
  }

  setParams(params?: Partial<ExecutorParams>): void {
    this.params = { ...DEFAULT_EXECUTOR_PARAMS, ...this.params, ...(params ?? {}) };
  }

  getParams(): ExecutorParams {
    return { ...this.params };
  }

  reset(): void {
    this.holes = [];
    this.wave = 0;
    this.dodgeTarget = null;
    this.lastReason = "";
    // fresh stream per game: the same seed replays the same choices
    this.rng = mulberry32(this.params.rngSeed);
  }

  decide(s: GameState): Decision {
    if (s.phase !== "playing") return {};
    if (s.wave !== this.wave) {
      this.wave = s.wave;
      this.holes = [];
      this.dodgeTarget = null;
    }

    // 1. dodging wins over aiming: a saved life buys future shots. The
    // committed destination (hysteresis) is what stops the left-right gait.
    const dodgeX = this.planDodgeCommitted(s);
    if (dodgeX !== null) {
      this.lastReason = "dodge";
      return { moveTo: dodgeX };
    }
    this.dodgeTarget = null;

    // 2. plan the best shot (Roomba first, then rodents)
    const plan = this.planShot(s);
    if (!plan) {
      this.lastReason = "no-target";
      return {};
    }

    // never walk back into a falling crumb's corridor: if the best standing
    // spot is hot and the cat is currently safe, hold position and wait
    const threatened = threateningCrumbs(s, this.params.dodgeHorizonS).length > 0;
    if (plan.hot && !threatened && !this.arrived(s.cat.x, plan.catX)) {
      this.lastReason = "wait-corridor";
      return {};
    }

    const arrived = this.arrived(s.cat.x, plan.catX);
    const decision: Decision = {};
    if (!arrived) {
      decision.moveTo = plan.catX;
    }
    // 3. fire only when in position, no furball airborne, corridor sane
    if (arrived && s.furball === null) {
      if (!plan.blocked) {
        decision.shoot = true;
        if (plan.kind === "roomba") this.lastReason = "shoot-roomba";
        else this.lastReason = "shoot-rodent";
      } else if (this.params.chewShields) {
        // accept the trade once per shield: the chew opens the corridor
        decision.shoot = true;
        this.holes.push(plan.shotX);
        this.lastReason = "chew-shield";
      } else {
        this.lastReason = "hold-fire-blocked";
      }
    } else if (arrived) {
      this.lastReason = "wait-furball";
    } else {
      this.lastReason = "reposition";
    }
    return decision;
  }

  // Dodge with commitment (anti-jitter hysteresis): once a safe destination
  // is chosen, keep it until it actually becomes unsafe — re-validated with
  // the same criterion that selected it. The commitment survives the invuln
  // window and the accept-the-hit cutoff: abandoning a half-finished dodge
  // is worse than finishing it. Cleared by decide() when nothing threatens.
  private planDodgeCommitted(s: GameState): number | null {
    const threats = threateningCrumbs(s, this.params.dodgeHorizonS);
    // mid-dodge: keep the committed destination while it stays safe from ALL
    // falling crumbs. Hysteresis — survives threat-set churn, the invuln
    // window and the accept-the-hit cutoff; abandoning a half-finished
    // dodge is worse than finishing it.
    if (this.dodgeTarget !== null && (threats.length > 0 || s.invuln > 0)) {
      if (isSafeSpot(s, this.dodgeTarget, fallingCrumbs(s))) {
        return clampCatX(this.dodgeTarget);
      }
    }
    if (!threats.length || s.invuln > 0) {
      return null; // nothing threatens, or invulnerable with nothing to finish
    }
    const fresh = planDodge(s, {
      horizonS: this.params.dodgeHorizonS,
      acceptBelowS: effectiveAcceptBelowS(this.params, s.lives),
    });
    this.dodgeTarget = fresh;
    return fresh;
  }

  planShot(s: GameState): ShotPlan | null {
    if (this.params.roombaFirst) {
      const roombaPlan = this.planRoomba(s);
      if (roombaPlan) return roombaPlan;
    }
    return this.planRodent(s);
  }

  // Lead the Roomba: it travels ~102 px during the 1.09 s flight.
  // Total lead covers glide time (cat arriving) + flight time.
  private planRoomba(s: GameState): ShotPlan | null {
    const rb = s.roomba;
    if (!rb) return null;
    const hot = hotCorridors(s, this.params);
    const flightT = flightTime(rb.y);
    let catX = clampCatX(rb.x + rb.vx * flightT - MUZZLE_OFFSET);
    // fixed-point iteration: arrival time shifts the lead
    for (let i = 0; i < 3; i++) {
      const arrive = Math.abs(catX - s.cat.x) / CAT_GLIDE_SPEED;
      catX = clampCatX(rb.x + rb.vx * (arrive + flightT) - MUZZLE_OFFSET);
    }
    const arrive = Math.abs(catX - s.cat.x) / CAT_GLIDE_SPEED;
    if (arrive > flightT * MIN_LEAD_MARGIN) return null; // unreachable
    if (rb.vx > 0 && rb.x + rb.vx * (arrive + flightT) > 470) return null;
    if (rb.vx < 0 && rb.x + rb.vx * (arrive + flightT) < 10) return null;
    const shotX = catX + MUZZLE_OFFSET;
    if (inHot(catX, hot)) return null; // skip: standing spot is in a crumb corridor
    const blocked = corridorBlocked(s, shotX, rb.y, this.holes);
    return { kind: "roomba", catX, shotX, flightT, blocked, hot: false };
  }

  // Target rodents: predicted center at impact, muzzle offset compensation,
  // free-corridor preference, per-row urgency and per-column avoidance.
  // Candidates are scored, then either taken as argmax (exploration 0) or
  // sampled among the top 3 (exploration > 0, seeded RNG).
  private planRodent(s: GameState): ShotPlan | null {
    if (!s.rods.length) return null;
    const hot = hotCorridors(s, this.params);
    const shieldPenalty = effectiveShieldPenalty(this.params, s.lives);
    // live rodents per column: killing a column's last rodent concentrates
    // the enemy's random fire into the remaining columns (it picks a
    // uniformly random live rodent per shot)
    const colAlive = new Array<number>(s.formation.cols).fill(0);
    for (const r of s.rods) colAlive[r.col]++;
    const candidates: Array<ShotPlan & { score: number }> = [];

    for (const r of s.rods) {
      const flightT = flightTime(r.y + r.h / 2);
      if (flightT <= 0) continue;
      const catX = clampCatX(r.x + r.w / 2 - MUZZLE_OFFSET); // first guess
      const arrive = glideTime(s.cat.x, catX);
      // predict the formation's march during glide + flight
      const gx = predictFormationX(s, arrive + flightT);
      // aim jitter: a seeded random offset makes the executor imperfect
      const jitter =
        this.params.aimJitterPx > 0 ? (this.rng() * 2 - 1) * this.params.aimJitterPx : 0;
      const targetX = gx + r.col * s.formation.stepX + r.w / 2 + jitter;
      const finalCatX = clampCatX(targetX - MUZZLE_OFFSET);
      const finalArrive = glideTime(s.cat.x, finalCatX);
      if (finalArrive > flightT * MIN_LEAD_MARGIN) continue; // unreachable

      const shotX = finalCatX + MUZZLE_OFFSET;
      const blocked = corridorBlocked(s, shotX, r.y + r.h / 2, this.holes);
      const isHot = inHot(finalCatX, hot);
      // deeper rodents are more urgent, weighted per row; free, clean
      // corridors are preferred; colAvoid steers targeting away from columns
      let score =
        r.y * this.params.lowestRowWeight * (this.params.rowWeights[r.row] ?? 1) +
        r.points * this.params.pointsWeight -
        (this.params.colAvoid[r.col] ?? 0) * 100;
      // travelCost: laziness — 1 score point per 10 px of glide, so the
      // model can trade urgency against shooting from where the cat stands
      score -= (this.params.travelCost * Math.abs(finalCatX - s.cat.x)) / 10;
      if (blocked) score -= shieldPenalty;
      if (isHot) score -= 2000;
      if (colAlive[r.col] <= 1) score -= this.params.columnSpreadWeight * 100;
      candidates.push({
        kind: "rodent",
        catX: finalCatX,
        shotX,
        flightT,
        blocked,
        hot: isHot,
        score,
      });
    }
    if (!candidates.length) return null;
    candidates.sort((a, b) => b.score - a.score);
    const best = this.pickCandidate(candidates);
    const { score: _score, ...plan } = best;
    return plan;
  }

  // Exploration sampling: with probability 0.25 * exploration/10 swap the
  // argmax pick for the 2nd (60%) or 3rd (40%) best candidate. Seeded, so a
  // fixed rngSeed replays the same choices; exploration 0 stays deterministic.
  private pickCandidate<T>(top: Array<T>): T {
    const e = this.params.exploration / 10;
    if (e <= 0 || top.length < 2 || this.rng() >= 0.25 * e) return top[0];
    return this.rng() < 0.6 ? top[1] : (top[2] ?? top[1]);
  }

  private arrived(catX: number, targetX: number): boolean {
    return Math.abs(targetX - catX) <= ARRIVAL_EPS;
  }
}
