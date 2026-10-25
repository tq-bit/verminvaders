// Fat-cat narrator: prints funny one-liners for game events, with per-event
// cooldowns and no immediate line repeats.

import type { CatEventType, CatLines } from "../types/index.d.ts";
import { COOLDOWNS_MS } from "../constants/index.ts";
import { validate } from "./lines.ts";
import { c } from "../ui/colors.ts";

export class Persona {
  private lines: CatLines;
  private lastAt = new Map<CatEventType, number>();
  private lastLine = new Map<CatEventType, string>();
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
    process.stdout.write(
      `  ${c.magenta(face)}  ${c.yellow(`"${line}"`)}${suffix ? ` ${c.gray(suffix)}` : ""}\n`,
    );
  }
}
