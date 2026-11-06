import type {
  Decider,
  Decision,
  DecisionPolicy,
  GateVerdict,
  PolicyOpts,
  RunContext,
  ToolCallGate,
} from "@noble-agent/core";

/**
 * EXPERIMENTAL — Jev adapter (TypeSafe).
 *
 * The TypeSafe SDK shape could not be verified against their docs at build
 * time (open question §10 in the plan), so this is a plain HTTP client that
 * implements the same `Decider` interface. Endpoint and payload shape are
 * configurable; swap in the official SDK behind the same interface when
 * confirmed. Keep arithmetic out of Jev questions — compute numbers in code
 * and ask qualitative questions only.
 */
export function jevDecider(opts: { apiKey?: string; baseUrl?: string } = {}): Decider {
  const apiKey = opts.apiKey ?? process.env.TYPESAFE_API_KEY;
  const baseUrl = opts.baseUrl ?? process.env.TYPESAFE_BASE_URL ?? "https://api.typesafe.ai/v1";
  if (!apiKey) {
    throw new Error("jevDecider needs TYPESAFE_API_KEY (or pass { apiKey }). Marked experimental — verify SDK shape with TypeSafe docs.");
  }

  async function post(path: string, body: unknown): Promise<any> {
    const res = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Jev ${path} failed: ${res.status} ${await res.text()}`);
    return res.json();
  }

  const decider: Decider = {
    name: "jev",
    experimental: true,

    async choose(state: unknown, question: string, options: string[]): Promise<Decision> {
      const data = await post("/decide", { state, question, options });
      const probs: Record<string, number> = data.probs ?? Object.fromEntries(options.map((o) => [o, o === data.choice ? 1 : 0]));
      return { choice: data.choice, p: probs[data.choice] ?? 1, probs };
    },

    async filter(query: string, items: string[]): Promise<number[]> {
      const data = await post("/filter", { query, items });
      return Array.isArray(data.keep) ? data.keep : [];
    },

    policy(popts: PolicyOpts): DecisionPolicy {
      return {
        name: "jevPolicy",
        async route(ctx: RunContext) {
          const d = await decider.choose(
            { query: ctx.query },
            "Is the stronger model needed for this query, or is the cheap model enough?",
            ["cheap", "strong"]
          );
          const useCheap = d.choice === "cheap" && d.p >= (popts.threshold ?? 0.55) && !!popts.cheap;
          return { model: useCheap ? (popts.cheap as string) : ((popts.strong as string) ?? null), decision: d };
        },
      };
    },

    toolGate(): ToolCallGate {
      return {
        name: "jevGate",
        async check(call, ctx): Promise<GateVerdict> {
          const d = await decider.choose(
            { tool: call.tool, args: call.args, query: ctx.query },
            "Is this tool call clearly justified by the user's own request?",
            ["safe", "review", "block"]
          );
          return d.choice as GateVerdict;
        },
      };
    },
  };

  return decider;
}
