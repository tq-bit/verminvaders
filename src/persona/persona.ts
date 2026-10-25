// Fat-cat narrator: prints funny one-liners for game events, with per-event
// cooldowns and no immediate line repeats. All lines live in lines.json
// (or a custom file passed via --persona) so they are easy to edit.

import { readFile } from "node:fs/promises";
import defaultLines from "./lines.json" with { type: "json" };

export type CatEventType =
  | "boot"
  | "gameStart"
  | "waveClear"
  | "roombaHit"
  | "lifeLost"
  | "dodge"
  | "idle"
  | "gameOver"
  | "sessionEnd";

export interface CatLines {
  faces: string[];
  lines: { [K in CatEventType]: string[] };
}

const COOLDOWNS_MS: { [K in CatEventType]: number } = {
  boot: 0,
  gameStart: 0,
  waveClear: 3000,
  roombaHit: 2000,
  lifeLost: 2000,
  dodge: 12000,
  idle: 30000,
  gameOver: 0,
  sessionEnd: 0,
};

function validate(lines: CatLines): void {
  for (const key of Object.keys(COOLDOWNS_MS) as CatEventType[]) {
    if (!lines.lines[key] || !lines.lines[key].length) {
      throw new Error(`persona file: missing or empty "${key}" lines`);
    }
  }
  if (!lines.faces || !lines.faces.length) {
    throw new Error("persona file: missing or empty faces");
  }
}

export async function loadCatLines(path?: string): Promise<CatLines> {
  if (!path) return defaultLines as CatLines;
  const raw = await readFile(path, "utf-8");
  const parsed = JSON.parse(raw) as CatLines;
  validate(parsed);
  return parsed;
}

export class Persona {
  private lines: CatLines;
  private lastAt = new Map<CatEventType, number>();
  private lastLine = new Map<CatEventType, string>();
  private seeded = false;
  private quiet = false;

  constructor(lines: CatLines, quiet = false) {
    validate(lines);
    this.lines = lines;
    this.quiet = quiet;
  }

  setQuiet(quiet: boolean): void {
    this.quiet = quiet;
  }

  event(type: CatEventType, suffix = ""): void {
    if (this.quiet) return;
    const now = Date.now();
    const last = this.lastAt.get(type) ?? -Infinity;
    if (now - last < COOLDOWNS_MS[type]) return;
    const pool = this.lines.lines[type];
    let line = pool[Math.floor(Math.random() * pool.length)];
    if (pool.length > 1 && line === this.lastLine.get(type)) {
      line = pool[(pool.indexOf(line) + 1) % pool.length];
    }
    this.lastAt.set(type, now);
    this.lastLine.set(type, line);
    const face = this.lines.faces[Math.floor(Math.random() * this.lines.faces.length)];
    process.stdout.write(`  ${face}  "${line}"${suffix ? " " + suffix : ""}\n`);
  }
}
