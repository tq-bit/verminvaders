// Renders the strategist's thinking in one of two modes:
// - text mode (default): streams the reasoning in dim gray so long inference
//   times stay transparent
// - indicator mode (--no-thinking): a "Strategizing" line with a pixel block
//   scanning back and forth, like a tiny cat pacing
// The final JSON answer is not printed raw; the strategy layer prints notes
// and params instead.

import { c } from "./colors.ts";

// A pixel block runs left-to-right and back across an 8-cell track.
const track = (pos: number) =>
  "[" + " ".repeat(pos) + "█" + " ".repeat(7 - pos) + "]";
const SPINNER_FRAMES = [0, 1, 2, 3, 4, 5, 6, 7, 6, 5, 4, 3, 2, 1].map(track);
const FRAME_MS = 110;

export class ThinkingRenderer {
  private label: string;
  private showThinking: boolean;
  private started = false;
  private spinner: ReturnType<typeof setInterval> | null = null;
  private frame = 0;

  constructor(label: string, showThinking = true) {
    this.label = label;
    this.showThinking = showThinking;
  }

  // Called when a strategy consultation begins. In text mode the first
  // thinking delta drives output; in indicator mode the animation starts
  // immediately (also covers models that send no reasoning at all).
  begin(): void {
    if (this.showThinking || this.spinner) return;
    const draw = () => {
      process.stdout.write(
        `\r${c.dim(`  [${this.label}] Strategizing `)}${c.yellow(SPINNER_FRAMES[this.frame])}\u001b[K`,
      );
      this.frame = (this.frame + 1) % SPINNER_FRAMES.length;
    };
    draw();
    this.spinner = setInterval(draw, FRAME_MS);
  }

  push(kind: "thinking" | "text", text: string): void {
    if (kind !== "thinking") return;
    if (!this.showThinking) return; // indicator mode: reasoning is not shown
    if (!this.started) {
      this.started = true;
      process.stdout.write(c.dim(`  [${this.label}] thinking: `));
    }
    process.stdout.write(c.dim(text));
  }

  finish(): void {
    if (this.spinner) {
      clearInterval(this.spinner);
      this.spinner = null;
      process.stdout.write("\r\u001b[K"); // erase the indicator line
    }
    if (this.started) process.stdout.write("\n");
    this.started = false;
  }
}
