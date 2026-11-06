import { describe, expect, it } from "vitest";
import { z } from "zod";
import { NobleAgent, parseBudget, defineTool, type DecisionPolicy, type NobleEvent, type Sink } from "@noble-agent/core";
import { MockModelAdapter } from "@noble-agent/providers";

describe("Phase 3 — budget and decisions", () => {
  it('parses the "$0.04" shorthand', () => {
    expect(parseBudget("$0.04")).toMatchObject({ usd: 0.04, onExhausted: "escalate" });
    expect(parseBudget({ steps: 5, onExhausted: "stop" })).toMatchObject({ steps: 5, onExhausted: "stop" });
    expect(() => parseBudget("four cents")).toThrow();
    expect(() => parseBudget({})).toThrow();
  });

  it("a policy that always picks the expensive model cannot exceed the budget", async () => {
    const alwaysExpensive: DecisionPolicy = {
      name: "runaway",
      route: async () => ({ model: "expensive-model", decision: { choice: "expensive", p: 1, probs: { expensive: 1 } } }),
    };
    const noop = defineTool({ name: "noop", description: "noop", params: z.object({}) }, async () => "ok");
    // Each call costs (10k*3 + 10k*15)/1e6 = $0.18 — the $0.20 budget allows one call, blocks the second.
    const mock = new MockModelAdapter(
      [{ toolCalls: [{ name: "noop", args: {} }], usage: { tokensIn: 10_000, tokensOut: 10_000 } }],
      { loop: true }
    );
    const events: NobleEvent[] = [];
    const sink: Sink = { name: "c", emit: (e) => void events.push(e) };

    const bot = new NobleAgent()
      .tools([noop])
      .model(mock)
      .memory([])
      .decide(alwaysExpensive)
      .budget("$0.20")
      .observe({ sinks: [sink] });

    const r = await bot.ask("spend everything", { sessionId: "s" });

    expect(r.outcome).toBe("escalated");
    expect(mock.requests.length).toBeLessThanOrEqual(2); // hard limit beat the policy
    expect(r.cost.usd).toBeLessThan(0.4);

    // decisions are logged with the full probability distribution
    const decision = events.find((e) => e.type === "decision");
    expect(decision?.data).toMatchObject({ choice: "expensive", probs: { expensive: 1 } });
    // escalation event emitted when the budget trips
    expect(events.some((e) => e.type === "escalation")).toBe(true);
  });

  it('onExhausted: "stop" returns an error outcome instead of escalating', async () => {
    const mock = new MockModelAdapter([{ text: "hi", usage: { tokensIn: 10_000, tokensOut: 10_000 } }], { loop: true });
    const bot = new NobleAgent().model(mock).memory([]).budget({ usd: 0.000001, onExhausted: "stop" });
    const first = await bot.ask("one", { sessionId: "s" }); // spends past the limit
    expect(first.outcome).toBe("resolved");
    const second = await bot.ask("two", { sessionId: "s" });
    expect(second.outcome).toBe("resolved"); // budgets are per-run, fresh each ask
  });

  it("budget steps limit stops the loop before maxSteps", async () => {
    const noop = defineTool({ name: "noop", description: "noop", params: z.object({}) }, async () => "ok");
    const mock = new MockModelAdapter([{ toolCalls: [{ name: "noop", args: {} }] }], { loop: true });
    const bot = new NobleAgent().tools([noop], { maxSteps: 10 }).model(mock).memory([]).budget({ steps: 2 });
    const r = await bot.ask("loop", { sessionId: "s" });
    expect(mock.requests.length).toBe(2);
    expect(r.outcome).toBe("escalated");
  });

  it("optimiseCost caches identical queries", async () => {
    const mock = new MockModelAdapter([{ text: "cached answer" }], { loop: true });
    const bot = new NobleAgent().model(mock).memory([]).optimiseCost({ cache: true });
    const a = await bot.ask("same question", { sessionId: "s" });
    const b = await bot.ask("same question", { sessionId: "s" });
    expect(mock.requests.length).toBe(1);
    expect(b.message).toBe(a.message);
  });
});
