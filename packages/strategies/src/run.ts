import { createContext, runInContext } from "node:vm";
import type { MemoryAdapter, RunContext, RunResult, Strategy } from "@noble-agent/core";

/**
 * Self-consistency: sample n runs, majority-vote on the normalised answer.
 * costMultiplier n — refuses to run without a budget (enforced by the agent).
 */
export function selfConsistency(opts: { n?: number } = {}): Strategy {
  const n = opts.n ?? 3;
  return {
    name: "self-consistency",
    costMultiplier: n,
    async wrapRun(ctx, next) {
      const results: RunResult[] = [];
      for (let i = 0; i < n; i++) {
        const c: RunContext = { ...ctx, messages: structuredClone(ctx.messages) };
        results.push(await next(c));
        if (ctx.budget.exceeded()) break; // hard limit beats the strategy
      }
      const groups = new Map<string, RunResult[]>();
      for (const r of results) {
        const key = normalise(r.message);
        groups.set(key, [...(groups.get(key) ?? []), r]);
      }
      const winner = [...groups.values()].sort((a, b) => b.length - a.length)[0];
      return winner[0];
    },
  };
}

/** Chain-of-Verification: answer → verification questions → revise. */
export function cove(): Strategy {
  return {
    name: "cove",
    costMultiplier: 3,
    async wrapRun(ctx, next) {
      const draft = await next(ctx);
      if (draft.outcome !== "resolved" || ctx.budget.exceeded()) return draft;
      const qs = await ctx.complete({
        messages: [
          {
            role: "user",
            content: `Question: ${ctx.query}\nDraft answer: ${draft.message}\n\nList up to 3 short verification questions that would catch factual errors in the draft. One per line.`,
          },
        ],
        temperature: 0,
      });
      const answers = await ctx.complete({
        messages: [{ role: "user", content: `Answer each briefly and independently:\n${qs.text}` }],
        temperature: 0,
      });
      const revised = await ctx.complete({
        messages: [
          {
            role: "user",
            content: `Question: ${ctx.query}\nDraft: ${draft.message}\nVerification Q&A:\n${qs.text}\n${answers.text}\n\nRewrite the draft fixing anything the verification contradicts. Reply with the final answer only.`,
          },
        ],
        temperature: 0,
      });
      return { ...draft, message: revised.text };
    },
  };
}

/** Tree-of-thoughts (bounded breadth/depth BFS over candidate approaches). */
export function tot(opts: { breadth?: number; depth?: number } = {}): Strategy {
  const breadth = opts.breadth ?? 2;
  const depth = opts.depth ?? 2;
  return {
    name: "tot",
    costMultiplier: breadth * depth + 1,
    async wrapRun(ctx, next) {
      let approaches = [""];
      for (let d = 0; d < depth && !ctx.budget.exceeded(); d++) {
        const expanded: { approach: string; score: number }[] = [];
        for (const base of approaches) {
          const gen = await ctx.complete({
            messages: [
              {
                role: "user",
                content: `Problem: ${ctx.query}\n${base ? `Current approach so far: ${base}\n` : ""}Propose ${breadth} distinct next steps or refinements, one per line.`,
              },
            ],
            temperature: 0.7,
          });
          for (const line of gen.text.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, breadth)) {
            const judge = await ctx.complete({
              messages: [
                {
                  role: "user",
                  content: `Problem: ${ctx.query}\nApproach: ${base} ${line}\nRate this approach's promise 0-10. Reply with the number only.`,
                },
              ],
              temperature: 0,
            });
            expanded.push({ approach: `${base} ${line}`.trim(), score: Number(judge.text.match(/\d+/)?.[0] ?? 0) });
          }
        }
        approaches = expanded.sort((a, b) => b.score - a.score).slice(0, breadth).map((e) => e.approach);
      }
      const c: RunContext = {
        ...ctx,
        messages: [
          ...ctx.messages,
          { role: "system", content: `A promising approach (from search): ${approaches[0] ?? ""}. Use it if it holds up.` },
        ],
      };
      return next(c);
    },
  };
}

/** Skeleton-of-thought: outline, then expand each point. */
export function skeletonOfThought(): Strategy {
  return {
    name: "skeleton-of-thought",
    costMultiplier: 2,
    async wrapRun(ctx, next) {
      const skeleton = await ctx.complete({
        messages: [{ role: "user", content: `Outline the answer to this as 3-5 short bullet points (no detail):\n${ctx.query}` }],
        temperature: 0,
      });
      const c: RunContext = {
        ...ctx,
        messages: [...ctx.messages, { role: "system", content: `Expand this outline into the full answer:\n${skeleton.text}` }],
      };
      return next(c);
    },
  };
}

/**
 * Chain-of-density — summarisation only. Validates the task: refuses queries
 * that don't look like a summarisation request unless task: "summarise" is
 * passed explicitly.
 */
export function chainOfDensity(opts: { rounds?: number; task?: "summarise" } = {}): Strategy {
  const rounds = opts.rounds ?? 2;
  return {
    name: "chain-of-density",
    costMultiplier: rounds + 1,
    async wrapRun(ctx, next) {
      const looksLikeSummary = /\b(summari[sz]e|summary|tl;?dr|condense|shorten)\b/i.test(ctx.query);
      if (!looksLikeSummary && opts.task !== "summarise") {
        throw new Error('chainOfDensity is a summarisation strategy. Pass { task: "summarise" } to force it on other queries.');
      }
      let result = await next(ctx);
      for (let i = 0; i < rounds && !ctx.budget.exceeded(); i++) {
        const denser = await ctx.complete({
          messages: [
            {
              role: "user",
              content: `Rewrite this summary to be denser: same length, more named entities and concrete facts, no filler.\n\n${result.message}`,
            },
          ],
          temperature: 0,
        });
        result = { ...result, message: denser.text };
      }
      return result;
    },
  };
}

/**
 * Program-of-thought: the model writes a small JS program; we execute it in a
 * sandboxed vm with no require/process/network/secrets and a hard timeout,
 * then the numeric/string result feeds the final answer.
 */
export function programOfThought(opts: { timeoutMs?: number } = {}): Strategy {
  return {
    name: "program-of-thought",
    costMultiplier: 1.5,
    async wrapRun(ctx, next) {
      const gen = await ctx.complete({
        messages: [
          {
            role: "user",
            content: `Write a short JavaScript expression or IIFE that computes the answer to the computational part of this question. No imports, no I/O, pure computation. Return only the code.\n\nQuestion: ${ctx.query}`,
          },
        ],
        temperature: 0,
      });
      const code = gen.text.replace(/^```(?:js|javascript)?/m, "").replace(/```$/m, "").trim();
      let computed: string;
      try {
        const sandbox = createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } });
        const value = runInContext(code, sandbox, { timeout: opts.timeoutMs ?? 1000 });
        computed = JSON.stringify(value);
      } catch (err) {
        computed = `(computation failed: ${String(err)})`;
      }
      const c: RunContext = {
        ...ctx,
        messages: [
          ...ctx.messages,
          { role: "system", content: `A sandboxed computation for this question returned: ${computed}. Use it if relevant.` },
        ],
      };
      return next(c);
    },
  };
}

/** Critic loop: draft → critique → revise, `rounds` times. */
export function reflect(opts: { rounds?: number; criteria?: string } = {}): Strategy {
  const rounds = opts.rounds ?? 1;
  return {
    name: "reflect",
    costMultiplier: 1 + rounds,
    async wrapRun(ctx, next) {
      let result = await next(ctx);
      for (let i = 0; i < rounds && result.outcome === "resolved" && !ctx.budget.exceeded(); i++) {
        const critique = await ctx.complete({
          messages: [
            {
              role: "user",
              content: `Question: ${ctx.query}\nAnswer: ${result.message}\n\nCritique this answer${opts.criteria ? ` against: ${opts.criteria}` : ""}. If it is already good, reply "OK". Otherwise list concrete problems.`,
            },
          ],
          temperature: 0,
        });
        if (/^ok\b/i.test(critique.text.trim())) break;
        const revised = await ctx.complete({
          messages: [
            {
              role: "user",
              content: `Question: ${ctx.query}\nAnswer: ${result.message}\nCritique: ${critique.text}\n\nRewrite the answer addressing the critique. Final answer only.`,
            },
          ],
          temperature: 0,
        });
        result = { ...result, message: revised.text };
      }
      return result;
    },
  };
}

/** Reflexion: reflect + episodic memory of past reflections per session. */
export function reflexion(memory: MemoryAdapter, opts: { rounds?: number } = {}): Strategy {
  const inner = reflect(opts);
  return {
    name: "reflexion",
    costMultiplier: (inner.costMultiplier ?? 2) + 0.5,
    async wrapRun(ctx, next) {
      const episodeKey = `reflexion:${ctx.sessionId}`;
      const past = await memory.load(episodeKey);
      const c: RunContext = past.length
        ? {
            ...ctx,
            messages: [
              { role: "system", content: `Lessons from earlier attempts:\n${past.map((m) => m.content).join("\n")}` },
              ...ctx.messages,
            ],
          }
        : ctx;
      const result = await inner.wrapRun!(c, next);
      const lesson = await ctx.complete({
        messages: [
          {
            role: "user",
            content: `Task: ${ctx.query}\nOutcome: ${result.outcome}\nAnswer: ${result.message.slice(0, 500)}\n\nWrite one short lesson for handling similar tasks better next time.`,
          },
        ],
        temperature: 0,
      });
      await memory.save(episodeKey, [{ role: "system", content: lesson.text.slice(0, 500) }]);
      return result;
    },
  };
}

/** Multi-agent debate: n debaters argue, a judge synthesises. Explicit opt-in. */
export function debate(opts: { agents?: number; rounds?: number } = {}): Strategy {
  const agents = opts.agents ?? 2;
  const rounds = opts.rounds ?? 1;
  return {
    name: "debate",
    costMultiplier: agents * rounds + 2,
    async wrapRun(ctx, next) {
      const positions: string[] = [];
      for (let a = 0; a < agents && !ctx.budget.exceeded(); a++) {
        const res = await ctx.complete({
          messages: [
            {
              role: "user",
              content: `You are debater #${a + 1}. ${positions.length ? `Other positions so far:\n${positions.join("\n---\n")}\n` : ""}Give your best answer to, and argument for: ${ctx.query}`,
            },
          ],
          temperature: 0.7,
        });
        positions.push(res.text);
      }
      const c: RunContext = {
        ...ctx,
        messages: [
          ...ctx.messages,
          {
            role: "system",
            content: `Independent positions from a debate:\n${positions.join("\n---\n")}\nJudge them and give the best-supported final answer.`,
          },
        ],
      };
      return next(c);
    },
  };
}

function normalise(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 120);
}
