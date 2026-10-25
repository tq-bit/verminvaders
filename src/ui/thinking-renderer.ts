// Streams a thinking model's reasoning to the terminal in dim gray so long
// inference times stay transparent. The final JSON answer is not printed
// raw; the strategy layer prints notes and params instead.

import { c } from "./colors.ts";

export class ThinkingRenderer {
  private started = false;
  private label: string;

  constructor(label: string) {
    this.label = label;
  }

  push(kind: "thinking" | "text", text: string): void {
    if (kind !== "thinking") return;
    if (!this.started) {
      this.started = true;
      process.stdout.write(c.dim(`  [${this.label}] thinking: `));
    }
    process.stdout.write(c.dim(text));
  }

  finish(): void {
    if (this.started) process.stdout.write("\n");
    this.started = false;
  }
}
