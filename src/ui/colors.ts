// Tiny ANSI color helper: no dependencies, disabled when stdout is not a TTY
// or NO_COLOR is set.

const enabled = process.stdout.isTTY && !process.env.NO_COLOR;

const wrap =
  (code: string) =>
  (s: string): string =>
    enabled ? `\u001b[${code}m${s}\u001b[0m` : s;

export const c = {
  dim: wrap("2"),
  bold: wrap("1"),
  red: wrap("31"),
  green: wrap("32"),
  yellow: wrap("33"),
  blue: wrap("34"),
  magenta: wrap("35"),
  cyan: wrap("36"),
  gray: wrap("90"),
  bright: wrap("97"),
};
