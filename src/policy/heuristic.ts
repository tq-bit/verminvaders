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
import { planDodge, threateningCrumbs } from "./dodge.ts";
import { hotCorridors, inHot } from "./hot-corridors.ts";

export class HeuristicPolicy implements Policy {
  private params: ExecutorParams = { ...DEFAULT_EXECUTOR_PARAMS };
  // x positions where we intentionally chewed a shield hole this wave
  private holes: number[] = [];
  private wave = 0;
  // for observability: why the last decision was what it was
  lastReason = "";

  constructor(params?: Partial<ExecutorParams>) {
    this.setParams(params);
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
    this.lastReason = "";
  }

  decide(s: GameState): Decision {
    if (s.phase !== "playing") return {};
    if (s.wave !== this.wave) {
      this.wave = s.wave;
      this.holes = [];
    }

    // 1. dodging wins over aiming: a saved life buys future shots
    const dodgeX = planDodge(s, {
      horizonS: this.params.dodgeHorizonS,
      acceptBelowS: this.params.acceptHitBelowS,
    });
    if (dodgeX !== null) {
      this.lastReason = "dodge";
      return { moveTo: dodgeX };
    }

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
  // free-corridor preference, lowest row first (they end the game first).
  private planRodent(s: GameState): ShotPlan | null {
    if (!s.rods.length) return null;
    const hot = hotCorridors(s, this.params);
    // live rodents per column: killing a column's last rodent concentrates
    // the enemy's random fire into the remaining columns (it picks a
    // uniformly random live rodent per shot)
    const colAlive = new Array<number>(s.formation.cols).fill(0);
    for (const r of s.rods) colAlive[r.col]++;
    let best: (ShotPlan & { score: number }) | null = null;

    for (const r of s.rods) {
      const flightT = flightTime(r.y + r.h / 2);
      if (flightT <= 0) continue;
      const catX = clampCatX(r.x + r.w / 2 - MUZZLE_OFFSET); // first guess
      const arrive = glideTime(s.cat.x, catX);
      // predict the formation's march during glide + flight
      const gx = predictFormationX(s, arrive + flightT);
      const targetX = gx + r.col * s.formation.stepX + r.w / 2;
      const finalCatX = clampCatX(targetX - MUZZLE_OFFSET);
      const finalArrive = glideTime(s.cat.x, finalCatX);
      if (finalArrive > flightT * MIN_LEAD_MARGIN) continue; // unreachable

      const shotX = finalCatX + MUZZLE_OFFSET;
      const blocked = corridorBlocked(s, shotX, r.y + r.h / 2, this.holes);
      const isHot = inHot(finalCatX, hot);
      // deeper rodents are more urgent; free, clean corridors are preferred
      let score = r.y * this.params.lowestRowWeight + r.points * this.params.pointsWeight;
      if (blocked) score -= this.params.shieldPenalty;
      if (isHot) score -= 2000;
      if (colAlive[r.col] <= 1) score -= this.params.columnSpreadWeight * 100;
      if (best === null || score > best.score) {
        best = {
          kind: "rodent",
          catX: finalCatX,
          shotX,
          flightT,
          blocked,
          hot: isHot,
          score,
        };
      }
    }
    if (!best) return null;
    return {
      kind: "rodent",
      catX: best.catX,
      shotX: best.shotX,
      flightT: best.flightT,
      blocked: best.blocked,
      hot: best.hot,
    };
  }

  private arrived(catX: number, targetX: number): boolean {
    return Math.abs(targetX - catX) <= ARRIVAL_EPS;
  }
}
