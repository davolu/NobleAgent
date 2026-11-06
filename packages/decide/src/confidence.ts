import type { DecisionPolicy, PolicyOpts, RunContext } from "@noble-agent/core";

/**
 * Code-only routing policy: no model call, no network. Scores how "easy" a
 * query looks (short, factual, no multi-part structure) and routes easy ones
 * to the cheap model. Deterministic and auditable.
 */
export function confidenceRouter(opts: PolicyOpts = {}): DecisionPolicy {
  const threshold = opts.threshold ?? 0.6;
  return {
    name: "confidenceRouter",
    async route(ctx: RunContext) {
      const q = ctx.query;
      let easiness = 1;
      if (q.length > 240) easiness -= 0.35;
      if ((q.match(/\?/g)?.length ?? 0) > 1) easiness -= 0.2;
      // each analytical keyword occurrence makes the query look harder
      easiness -= 0.2 * (q.match(/\b(why|explain|compare|analy[sz]e|strateg(y|ies)|design|debug)\b/gi)?.length ?? 0);
      if (/\b(and|then|also|additionally)\b/i.test(q)) easiness -= 0.1;
      if (q.split(/\n/).length > 3) easiness -= 0.15;
      easiness = Math.max(0, Math.min(1, easiness));

      const useCheap = easiness >= threshold && !!opts.cheap;
      const choice = useCheap ? "cheap" : "strong";
      const probs = { cheap: easiness, strong: 1 - easiness };
      return {
        model: useCheap ? (opts.cheap as string) : ((opts.strong as string) ?? null),
        decision: { choice, p: useCheap ? easiness : 1 - easiness, probs },
      };
    },
  };
}
