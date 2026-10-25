// Fat-cat line loading and validation. The lines themselves live in
// lines.json (or a custom file passed via --persona).

import { readFile } from "node:fs/promises";
import type { CatEventType, CatLines } from "../types/index.d.ts";
import { COOLDOWNS_MS } from "../constants/index.ts";
import defaultLines from "./lines.json" with { type: "json" };

export function validate(lines: CatLines): void {
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
