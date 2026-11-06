import { describe, expect, it } from "vitest";
import { Budget, NobleAgent, type Message, type RunContext, type RunResult } from "@noble-agent/core";
import { MockModelAdapter } from "@noble-agent/providers";
import { HistoryMemory } from "@noble-agent/memory";
import {
  chainOfDensity,
  cot,
  cove,
  debate,
  fewShot,
  programOfThought,
  reflect,
  reflexion,
  role,
  selfConsistency,
  skeletonOfThought,
  stepBack,
  tot,
  zeroShot,
} from "@noble-agent/strategies";

function ctxWith(completions: string[], budget = new Budget({})): { ctx: RunContext; requests: string[] } {
  const requests: string[] = [];
  let i = 0;
  const ctx: RunContext = {
    traceId: "t",
    sessionId: "s",
    query: "What is the warranty on blenders?",
    messages: [{ role: "user", content: "What is the warranty on blenders?" }],
    model: "mock",
    budget,
    metadata: {},
    emit: () => {},
    complete: async (req) => {
      requests.push(req.messages.map((m) => m.content).join("\n"));
      return { text: completions[Math.min(i++, completions.length - 1)], toolCalls: [], usage: { tokensIn: 10, tokensOut: 10 }, stopReason: "end" };
    },
  };
  return { ctx, requests };
}

function result(message: string): RunResult {
  return { message, outcome: "resolved", sources: [], toolCalls: [], traceId: "t", runId: "r", cost: { usd: 0, tokensIn: 0, tokensOut: 0 } };
}

describe("Phase 5 — prompt-level strategies", () => {
  const base: Message[] = [{ role: "user", content: "q" }];

  it("zero-shot is a no-op with cost 1", () => {
    expect(zeroShot.transformPrompt).toBeUndefined();
    expect(zeroShot.costMultiplier).toBe(1);
  });

  it("role prepends a persona", () => {
    const out = role("You are a pirate.").transformPrompt!(base, ctxWith([]).ctx);
    expect(out[0]).toEqual({ role: "system", content: "You are a pirate." });
  });

  it("few-shot inserts examples before the last user message", () => {
    const out = fewShot([{ user: "ex-q", assistant: "ex-a" }]).transformPrompt!(
      [{ role: "system", content: "sys" }, { role: "user", content: "real-q" }],
      ctxWith([]).ctx
    );
    expect(out.map((m) => m.content)).toEqual(["sys", "ex-q", "ex-a", "real-q"]);
  });

  it("few-shot supports retrieved examples keyed by query", () => {
    const s = fewShot((q) => (q.includes("warranty") ? [{ user: "w?", assistant: "w!" }] : []));
    const out = s.transformPrompt!(base, ctxWith([]).ctx);
    expect(out.some((m) => m.content === "w!")).toBe(true);
  });

  it("cot and step-back append reasoning instructions", () => {
    expect(cot().transformPrompt!(base, ctxWith([]).ctx).at(-1)?.content).toMatch(/step by step/);
    expect(stepBack.transformPrompt!(base, ctxWith([]).ctx).at(-1)?.content).toMatch(/general principle/);
  });
});

describe("Phase 5 — run-level strategies", () => {
  it("self-consistency majority-votes across n runs and declares its cost", async () => {
    const s = selfConsistency({ n: 3 });
    expect(s.costMultiplier).toBe(3);
    const answers = ["Two years.", "One year.", "Two years!"];
    let call = 0;
    const { ctx } = ctxWith([]);
    const out = await s.wrapRun!(ctx, async () => result(answers[call++]));
    expect(out.message).toBe("Two years.");
  });

  it("self-consistency refuses to run without a budget (agent enforces)", async () => {
    const bot = new NobleAgent().model(new MockModelAdapter([{ text: "x" }])).memory([]).promptEng([selfConsistency({ n: 5 })]);
    await expect(bot.ready()).rejects.toThrow(/budget/i);

    const withBudget = new NobleAgent()
      .model(new MockModelAdapter([{ text: "A" }, { text: "A" }, { text: "B" }]))
      .memory([])
      .promptEng([selfConsistency({ n: 3 })])
      .budget("$1.00");
    const r = await withBudget.ask("q", { sessionId: "s" });
    expect(r.message).toBe("A");
  });

  it("CoVe asks verification questions and revises", async () => {
    const { ctx, requests } = ctxWith(["Q1? Q2?", "A1. A2.", "Blenders are covered for two years."]);
    const out = await cove().wrapRun!(ctx, async () => result("Blenders covered one year."));
    expect(out.message).toContain("two years");
    expect(requests[0]).toContain("verification questions");
    expect(requests[2]).toContain("Rewrite the draft");
  });

  it("ToT searches approaches then answers once", async () => {
    const { ctx } = ctxWith(["idea A\nidea B", "7", "5", "refine A1\nrefine A2", "8", "6"]);
    let nextCtx: RunContext | undefined;
    const out = await tot({ breadth: 2, depth: 2 }).wrapRun!(ctx, async (c) => {
      nextCtx = c;
      return result("final");
    });
    expect(out.message).toBe("final");
    expect(nextCtx?.messages.at(-1)?.content).toContain("promising approach");
  });

  it("skeleton-of-thought outlines then expands", async () => {
    const { ctx } = ctxWith(["- point 1\n- point 2"]);
    let sawOutline = false;
    await skeletonOfThought().wrapRun!(ctx, async (c) => {
      sawOutline = c.messages.some((m) => m.content.includes("point 1"));
      return result("done");
    });
    expect(sawOutline).toBe(true);
  });

  it("chain-of-density only runs on summarisation tasks", async () => {
    const { ctx } = ctxWith(["denser v1", "denser v2"]);
    await expect(chainOfDensity().wrapRun!(ctx, async () => result("x"))).rejects.toThrow(/summarisation/);

    const summaryCtx = ctxWith(["denser v1", "denser v2"]).ctx;
    summaryCtx.query = "Summarise the warranty policy";
    const out = await chainOfDensity({ rounds: 2 }).wrapRun!(summaryCtx, async () => result("loose summary"));
    expect(out.message).toBe("denser v2");
  });

  it("program-of-thought executes model code in a sandbox without process/require", async () => {
    const { ctx } = ctxWith(["(6 * 7)"]);
    let injected = "";
    await programOfThought().wrapRun!(ctx, async (c) => {
      injected = c.messages.at(-1)?.content ?? "";
      return result("42");
    });
    expect(injected).toContain("42");

    // sandbox: no access to require/process; failure is contained
    const evil = ctxWith(["process.exit(1)"]);
    let note = "";
    await programOfThought().wrapRun!(evil.ctx, async (c) => {
      note = c.messages.at(-1)?.content ?? "";
      return result("ok");
    });
    expect(note).toContain("computation failed");
  });

  it("reflect critiques and revises; stops early on OK", async () => {
    const { ctx } = ctxWith(["Missing the 2-year motor detail.", "Covered 1 year; motors 2 years."]);
    const out = await reflect({ rounds: 2 }).wrapRun!(ctx, async () => result("Covered 1 year."));
    expect(out.message).toContain("motors 2 years");

    const okCtx = ctxWith(["OK"]).ctx;
    const unchanged = await reflect({ rounds: 3 }).wrapRun!(okCtx, async () => result("Fine answer."));
    expect(unchanged.message).toBe("Fine answer.");
  });

  it("reflexion stores lessons in episodic memory and replays them", async () => {
    const memory = new HistoryMemory();
    const s = reflexion(memory, { rounds: 1 });
    const first = ctxWith(["OK", "Lesson: cite page numbers."]);
    await s.wrapRun!(first.ctx, async () => result("answer one"));
    const stored = await memory.load("reflexion:s");
    expect(stored[0]?.content).toContain("Lesson");

    const second = ctxWith(["OK", "Lesson: be brief."]);
    let sawLesson = false;
    await s.wrapRun!(second.ctx, async (c) => {
      sawLesson = c.messages[0]?.content.includes("Lesson: cite page numbers.") ?? false;
      return result("answer two");
    });
    expect(sawLesson).toBe(true);
  });

  it("debate gathers positions and judges them", async () => {
    const { ctx, requests } = ctxWith(["Position A", "Position B"]);
    let judged = "";
    const out = await debate({ agents: 2 }).wrapRun!(ctx, async (c) => {
      judged = c.messages.at(-1)?.content ?? "";
      return result("judged answer");
    });
    expect(out.message).toBe("judged answer");
    expect(judged).toContain("Position A");
    expect(judged).toContain("Position B");
    expect(requests[1]).toContain("Position A"); // debater 2 sees debater 1
  });

  it("every strategy declares an honest cost multiplier", () => {
    for (const s of [selfConsistency(), cove(), tot(), skeletonOfThought(), chainOfDensity(), programOfThought(), reflect(), debate()]) {
      expect(s.costMultiplier, s.name).toBeGreaterThanOrEqual(1);
    }
    expect(debate({ agents: 3, rounds: 2 }).costMultiplier).toBe(8);
  });
});
