import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseArgs } from "../ui/cli.ts";
import { parseFloatOr, parseIntOr, parseBoolOr, promptConfig } from "../ui/wizard.ts";
import type { Questioner } from "../ui/wizard.ts";

// Questioner answering from a scripted list, in order.
function scripted(answers: string[]): Questioner & { seen: string[] } {
  const seen: string[] = [];
  let i = 0;
  return {
    seen,
    question(q: string) {
      seen.push(q);
      return Promise.resolve(answers[i++] ?? "");
    },
  };
}

describe("wizard answer parsing", () => {
  it("keeps the fallback on empty or invalid numbers", () => {
    assert.equal(parseIntOr("", 3, "games"), 3);
    assert.equal(parseIntOr("  ", 3, "games"), 3);
    assert.equal(parseIntOr("abc", 3, "games"), 3);
    assert.equal(parseIntOr("-2", 3, "games"), 3);
    assert.equal(parseFloatOr("", 10, "epoch"), 10);
    assert.equal(parseFloatOr("x2", 10, "epoch"), 10);
  });

  it("accepts positive numbers", () => {
    assert.equal(parseIntOr("7", 3, "games"), 7);
    assert.equal(parseFloatOr("2.5", 10, "epoch"), 2.5);
  });

  it("parses y/n booleans with the fallback", () => {
    assert.equal(parseBoolOr("", true), true);
    assert.equal(parseBoolOr("n", true), false);
    assert.equal(parseBoolOr("YES", false), true);
    assert.equal(parseBoolOr("maybe", true), true); // unrecognized keeps fallback
  });
});

describe("promptConfig", () => {
  const base = () => parseArgs(["node", "main.ts"]);

  it("keeps all defaults on empty answers", async () => {
    const rl = scripted(["", "", "", ""]);
    const a = await promptConfig(base(), rl);
    assert.equal(a.maxGames, 3);
    assert.equal(a.epochMs, 10000);
    assert.equal(a.style, "");
    assert.equal(a.thinking, true);
  });

  it("applies the given answers", async () => {
    const rl = scripted(["5", "2.5", "be a menace", "n"]);
    const a = await promptConfig(base(), rl);
    assert.equal(a.maxGames, 5);
    assert.equal(a.epochMs, 2500);
    assert.equal(a.style, "be a menace");
    assert.equal(a.thinking, false);
  });

  it("offers flag values as the defaults and keeps them on Enter", async () => {
    const preset = parseArgs(["node", "main.ts", "--games", "9", "--style", "cowardly cat"]);
    const rl = scripted(["", "", "", ""]);
    const a = await promptConfig(preset, rl);
    assert.equal(a.maxGames, 9);
    assert.equal(a.style, "cowardly cat");
    assert.ok(rl.seen[0].includes("(9)"), "flag value must be shown as the default");
    assert.ok(rl.seen[2].includes("(cowardly cat)"));
  });

  it("falls back to the default on garbage input", async () => {
    const rl = scripted(["banana", "later", "", ""]);
    const a = await promptConfig(base(), rl);
    assert.equal(a.maxGames, 3);
    assert.equal(a.epochMs, 10000);
    assert.equal(a.style, "");
  });
});
