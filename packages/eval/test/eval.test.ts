import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MockModelAdapter } from "@noble-agent/providers";
import { acceptTune, generatePromptfooConfig, pickModel, tunePrompt } from "@noble-agent/eval";
import type { RunResult } from "@noble-agent/core";

function fakeResult(message: string, usd: number): RunResult {
  return { message, outcome: "resolved", sources: [], toolCalls: [], traceId: `tr-${Math.random()}`, runId: "r", cost: { usd, tokensIn: 10, tokensOut: 10 } };
}

describe("Phase 9 — promptfoo generation", () => {
  it("generates a config with the builtin asserts", () => {
    const yaml = generatePromptfooConfig(
      {
        dataset: [
          { input: "Is my blender covered?", expected: "2 years" },
          { input: "I want to talk to a human", shouldEscalate: true },
        ],
        assert: ["cites-source", "escalates-correctly", "cost", "faithfulness"],
        maxCostUsd: 0.03,
      },
      { botModule: "./bot.ts" }
    );
    const cfg = JSON.parse(yaml); // JSON is valid YAML
    expect(cfg.tests).toHaveLength(2);
    const asserts0 = JSON.stringify(cfg.tests[0].assert);
    expect(asserts0).toContain("sources.length > 0");
    expect(asserts0).toContain('outcome !== \\"escalated\\"');
    expect(asserts0).toContain("0.03");
    const asserts1 = JSON.stringify(cfg.tests[1].assert);
    expect(asserts1).toContain('outcome === \\"escalated\\"');
    expect(JSON.stringify(cfg)).toContain("llm-rubric");
  });
});

describe("Phase 9 — pick-model", () => {
  it("scores candidates, enforces minQuality and writes a lock file the runtime honours", async () => {
    const dir = mkdtempSync(join(tmpdir(), "noble-lock-"));
    const lockPath = join(dir, "noble.lock");

    const report = await pickModel({
      candidates: [{ model: "smart-but-pricey" }, { model: "good-and-cheap" }, { model: "bad-and-cheap" }],
      dataset: [
        { input: "warranty?", expected: "2 years" },
        { input: "shipping?", expected: "3-5 days" },
      ],
      minQuality: 0.6,
      lockPath,
      runCase: async (model, input) => {
        const answers: Record<string, string> = {
          "smart-but-pricey": input.includes("warranty") ? "2 years" : "3-5 days",
          "good-and-cheap": input.includes("warranty") ? "Covered 2 years" : "Takes 3-5 days",
          "bad-and-cheap": "I don't know",
        };
        const cost = model === "smart-but-pricey" ? 0.09 : 0.002;
        return { result: fakeResult(answers[model], cost), latencyMs: model === "smart-but-pricey" ? 4000 : 800 };
      },
    });

    expect(report.winner).toBe("good-and-cheap");
    expect(report.scores["bad-and-cheap"].disqualified).toContain("minQuality");
    expect(report.traceIds.length).toBe(6); // eval results link to traces

    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    expect(lock.model).toBe("good-and-cheap");
    expect(lock.scores["good-and-cheap"].quality).toBe(1);
  });

  it("throws when every candidate misses minQuality", async () => {
    await expect(
      pickModel({
        candidates: [{ model: "weak" }],
        dataset: [{ input: "q", expected: "impossible" }],
        minQuality: 0.9,
        lockPath: join(mkdtempSync(join(tmpdir(), "noble-lock-")), "noble.lock"),
        runCase: async () => ({ result: fakeResult("nope", 0.001), latencyMs: 100 }),
      })
    ).rejects.toThrow(/minQuality/);
  });
});

describe("Phase 9 — prompt tuning", () => {
  const dataset = Array.from({ length: 8 }, (_, i) => ({
    input: `case ${i}`,
    expected: "MAGIC",
  }));

  it("accepts a variant only when it beats baseline on the holdout, keeps protected lines, writes a diff", async () => {
    const keepLine = "Never promise refunds.";
    const adapter = new MockModelAdapter([
      { text: `You are helpful. Always answer MAGIC.\n${keepLine}\n=====\nYou are helpful but vague.\n${keepLine}` },
    ]);
    const dir = mkdtempSync(join(tmpdir(), "noble-tune-"));
    const diffPath = join(dir, "noble-prompt.diff");

    const report = await tunePrompt({
      basePrompt: `You are helpful.\n${keepLine}`,
      dataset,
      keep: [keepLine],
      adapter,
      diffPath,
      rounds: 1,
      // the run obeys the prompt: only the MAGIC-instructing prompt passes
      runCase: async (prompt) => (prompt.includes("MAGIC") ? "MAGIC" : "something else"),
    });

    expect(report.accepted).toBe(true);
    expect(report.bestPrompt).toContain("MAGIC");
    expect(report.bestPrompt).toContain(keepLine);
    expect(report.holdoutBest).toBeGreaterThan(report.holdoutBase);
    expect(existsSync(diffPath)).toBe(true);

    // noble accept applies the diff
    const promptFile = join(dir, "prompt.txt");
    writeFileSync(promptFile, `prefix\nYou are helpful.\n${keepLine}\nsuffix`);
    acceptTune(diffPath, promptFile);
    expect(readFileSync(promptFile, "utf8")).toContain("Always answer MAGIC.");
  });

  it("refuses a prompt that does not beat baseline on holdout", async () => {
    const adapter = new MockModelAdapter([{ text: "A worse prompt variant.\n=====\nAnother bad one." }]);
    const report = await tunePrompt({
      basePrompt: "You are helpful.",
      dataset,
      adapter,
      rounds: 1,
      runCase: async () => "never right",
    });
    expect(report.accepted).toBe(false);
    expect(report.bestPrompt).toBe("You are helpful.");
    expect(report.diffPath).toBeUndefined();
  });

  it("rejects keep lines missing from the base prompt", async () => {
    await expect(
      tunePrompt({
        basePrompt: "You are helpful.",
        dataset,
        keep: ["This line is not in the prompt."],
        adapter: new MockModelAdapter([{ text: "x" }]),
        runCase: async () => "x",
      })
    ).rejects.toThrow(/keep line/);
  });
});
