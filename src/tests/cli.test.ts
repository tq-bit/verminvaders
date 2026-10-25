import assert from "node:assert/strict";
import { describe, it } from "node:test";
import path from "node:path";
import { parseArgs } from "../ui/cli.ts";

describe("parseArgs (commander)", () => {
  it("applies the documented defaults", () => {
    const a = parseArgs(["node", "main.ts"]);
    assert.equal(a.headed, false);
    assert.equal(a.mode, "realtime");
    assert.equal(a.pollMs, 80);
    assert.equal(a.maxGames, 3);
    assert.equal(a.logLevel, "normal");
    assert.equal(a.model, "mistral-large-4");
    assert.equal(a.epochMs, 10000);
    assert.equal(a.style, "");
    assert.equal(a.noLlm, false);
    assert.equal(a.thinking, true, "reasoning streams unless --no-thinking");
    assert.ok(a.gamePath.endsWith("app/index.html"));
    assert.ok(a.memoryPath.endsWith("mistral-strategy.json"));
  });

  it("parses value flags and resolves paths", () => {
    const a = parseArgs([
      "node",
      "main.ts",
      "--headed",
      "--games",
      "7",
      "--epoch-ms",
      "2500",
      "--style",
      "be a menace",
      "--memory",
      "mem/strategy.json",
    ]);
    assert.equal(a.headed, true);
    assert.equal(a.maxGames, 7);
    assert.equal(a.epochMs, 2500);
    assert.equal(a.style, "be a menace");
    assert.equal(a.memoryPath, path.resolve("mem/strategy.json"));
  });

  it("supports the negated flags --no-llm and --no-thinking", () => {
    const a = parseArgs(["node", "main.ts", "--no-llm", "--no-thinking"]);
    assert.equal(a.noLlm, true);
    assert.equal(a.thinking, false);
  });

  it("rejects unknown options", () => {
    assert.throws(() => parseArgs(["node", "main.ts", "--nonsense"]), /unknown/i);
  });

  it("rejects options with a missing value", () => {
    assert.throws(() => parseArgs(["node", "main.ts", "--mode"]));
  });
});
