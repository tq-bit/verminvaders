// Playwright-backed connection to the game page's window.verminvaders bridge.
// Every state read measures its round-trip time and compensates crumb
// positions for half of it (mode B latency, spec section 7).

import type { Page } from "playwright";
import type { Decision, GameState } from "../types/index.d.ts";

// evaluate callbacks run in the browser page, not in Node
declare const window: any;

export interface ApplyResult {
  ok: boolean;
  shot: boolean;
}

export class Connection {
  private page: Page;
  latencyMs = 0;

  constructor(page: Page) {
    this.page = page;
  }

  async hasBridge(): Promise<boolean> {
    try {
      return await this.page.evaluate(() => typeof window.verminvaders === "object");
    } catch {
      return false;
    }
  }

  async readState(): Promise<GameState> {
    const t0 = Date.now();
    const state = await this.page.evaluate(() => window.verminvaders!.state());
    const rtt = Date.now() - t0;
    this.latencyMs = this.latencyMs ? this.latencyMs * 0.8 + rtt * 0.2 : rtt;
    // compensate vertical crumb drift for half the round trip
    const half = this.latencyMs / 2000;
    for (const c of state.crumbs) c.y += c.vy * half;
    return state as GameState;
  }

  async apply(d: Decision): Promise<ApplyResult> {
    return this.page.evaluate((dec) => {
      const v = window.verminvaders;
      if (!v) return { ok: false, shot: false };
      let shot = false;
      if (dec.stop) v.stop();
      if (typeof dec.moveTo === "number") v.moveTo(dec.moveTo);
      if (typeof dec.left === "boolean") v.moveLeft(dec.left);
      if (typeof dec.right === "boolean") v.moveRight(dec.right);
      if (dec.shoot) shot = v.shoot();
      return { ok: true, shot };
    }, d as Record<string, unknown>);
  }

  async start(): Promise<boolean> {
    return this.page.evaluate(() => window.verminvaders!.start());
  }

  async pause(): Promise<boolean> {
    return this.page.evaluate(() => window.verminvaders!.pause());
  }

  async resume(): Promise<boolean> {
    return this.page.evaluate(() => window.verminvaders!.resume());
  }

  async stopInputs(): Promise<void> {
    await this.page.evaluate(() => window.verminvaders?.stop());
  }
}
