// Interactive setup wizard: asks for the player-flavored run parameters
// (games, epoch period, style directive, reasoning display) with the
// current values — flags or defaults — as the preselected answers.
// Enter keeps the shown default; garbage falls back with a warning.

import { stdin, stdout } from "node:process";
import { createInterface, type Interface } from "node:readline/promises";
import { c } from "./colors.ts";
import type { Args } from "../types/index.d.ts";

// The question interface is injected so the wizard is unit-testable.
export interface Questioner {
  question(q: string): Promise<string>;
}

export function makeQuestioner(): Questioner {
  return createInterface({ input: stdin, output: stdout }) as unknown as Questioner;
}

// Positive integer answer; empty or garbage keeps the fallback.
export function parseIntOr(raw: string, fallback: number, label: string): number {
  const t = raw.trim();
  if (!t) return fallback;
  const n = Number(t);
  if (!Number.isInteger(n) || n <= 0) {
    console.error(c.yellow(`[harness] ignoring invalid ${label} "${t}", using ${fallback}`));
    return fallback;
  }
  return n;
}

// Positive number (fractions allowed) answer; empty or garbage keeps it.
export function parseFloatOr(raw: string, fallback: number, label: string): number {
  const t = raw.trim();
  if (!t) return fallback;
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0) {
    console.error(c.yellow(`[harness] ignoring invalid ${label} "${t}", using ${fallback}`));
    return fallback;
  }
  return n;
}

// Y/n answer; empty keeps the fallback, anything unrecognized keeps it too.
export function parseBoolOr(raw: string, fallback: boolean): boolean {
  const t = raw.trim().toLowerCase();
  if (!t) return fallback;
  if (["y", "yes"].includes(t)) return true;
  if (["n", "no"].includes(t)) return false;
  return fallback;
}

export async function promptConfig(args: Args, rl: Questioner): Promise<Args> {
  console.log(c.blue("[harness] interactive setup — press Enter to keep the shown default"));
  const out: Args = { ...args };

  out.maxGames = parseIntOr(
    await rl.question(`Games per session (${args.maxGames}): `),
    args.maxGames,
    "games",
  );
  // epoch: undefined = per-wave strategy (no mid-wave epoch updates)
  const epochDefault = args.epochMs === undefined ? "per wave" : `${args.epochMs / 1000}`;
  const rawEpoch = await rl.question(`Strategy epoch in seconds (${epochDefault}): `);
  const t = rawEpoch.trim();
  if (t) {
    const n = Number(t);
    if (Number.isFinite(n) && n > 0) out.epochMs = Math.round(n * 1000);
    else console.error(c.yellow(`[harness] ignoring invalid epoch "${t}", keeping ${epochDefault}`));
  } // empty answer keeps args.epochMs (possibly undefined = per wave)
  const styleDefault = args.style.trim() ? args.style : "none";
  out.style =
    (await rl.question(`Style directive for the model (${styleDefault}): `)).trim() || args.style;
  out.thinking = parseBoolOr(
    await rl.question(`Show the model's reasoning text? (y/N): `),
    args.thinking,
  );

  console.log(
    c.blue(
      `[harness] games=${out.maxGames} epoch=${out.epochMs === undefined ? "per wave" : `${out.epochMs / 1000}s`} style="${
        out.style.trim() ? out.style : "none"
      }" reasoning=${out.thinking ? "streamed" : "Strategizing indicator"}`,
    ),
  );
  return out;
}
