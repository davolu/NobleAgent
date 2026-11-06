import { describe, expect, it } from "vitest";
import { Budget, type RunContext } from "@noble-agent/core";
import { MockModelAdapter } from "@noble-agent/providers";
import { cheapModelDecider, confidenceRouter } from "@noble-agent/decide";

function ctx(query: string): RunContext {
  return {
    traceId: "t",
    sessionId: "s",
    query,
    messages: [],
    model: "strong-model",
    budget: new Budget({}),
    metadata: {},
    emit: () => {},
    complete: async () => ({ text: "", toolCalls: [], usage: { tokensIn: 0, tokensOut: 0 }, stopReason: "end" as const }),
  };
}

describe("Phase 3 — deciders", () => {
  it("confidenceRouter routes easy queries to the cheap model, hard ones to strong (code-only)", async () => {
    const policy = confidenceRouter({ cheap: "cheap-model", strong: "strong-model" });

    const easy = await policy.route(ctx("What are your opening hours?"));
    expect(easy.model).toBe("cheap-model");
    expect(easy.decision.probs.cheap).toBeGreaterThan(easy.decision.probs.strong);

    const hard = await policy.route(
      ctx(
        "Explain why the reconciliation job fails on leap days, compare the two retry strategies we discussed, and then design a fix.\n- constraint 1\n- constraint 2\n- constraint 3\n- constraint 4"
      )
    );
    expect(hard.model).toBe("strong-model");
    expect(hard.decision.probs.strong).toBeGreaterThan(hard.decision.probs.cheap);
  });

  it("cheapModelDecider parses choices with normalised probabilities", async () => {
    const mock = new MockModelAdapter([{ text: '{"choice": "cheap", "probs": {"cheap": 0.8, "strong": 0.2}}' }]);
    const decider = cheapModelDecider(mock);
    const d = await decider.choose({}, "which model?", ["cheap", "strong"]);
    expect(d.choice).toBe("cheap");
    expect(d.p).toBeCloseTo(0.8);
    expect(d.probs.cheap + d.probs.strong).toBeCloseTo(1);
  });

  it("cheapModelDecider.filter returns valid indices only", async () => {
    const mock = new MockModelAdapter([{ text: '{"keep": [0, 2, 9]}' }]);
    const decider = cheapModelDecider(mock);
    expect(await decider.filter("q", ["a", "b", "c"])).toEqual([0, 2]);
  });

  it("cheapModelDecider.toolGate maps verdicts", async () => {
    const mock = new MockModelAdapter([{ text: '{"choice": "block", "probs": {"safe": 0.1, "review": 0.2, "block": 0.7}}' }]);
    const gate = cheapModelDecider(mock).toolGate();
    expect(await gate.check({ tool: "sendEmail", args: {} }, ctx("what is my warranty?"))).toBe("block");
  });
});
