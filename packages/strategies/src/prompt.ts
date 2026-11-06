import type { Message, Strategy } from "@noble-agent/core";

/** Zero-shot: the baseline — no prompt transformation. */
export const zeroShot: Strategy = { name: "zero-shot", costMultiplier: 1 };

/** Role prompting: prepend a persona/system framing. */
export function role(persona: string): Strategy {
  return {
    name: "role",
    costMultiplier: 1,
    transformPrompt(messages: Message[]): Message[] {
      return [{ role: "system", content: persona }, ...messages];
    },
  };
}

export interface FewShotExample {
  user: string;
  assistant: string;
}

/**
 * Few-shot with provided or retrieved examples. Pass examples directly, or a
 * retriever that returns the most relevant examples for the current query.
 */
export function fewShot(
  examples: FewShotExample[] | ((query: string) => FewShotExample[]),
  opts: { max?: number } = {}
): Strategy {
  return {
    name: "few-shot",
    costMultiplier: 1.2,
    transformPrompt(messages, ctx) {
      const list = (typeof examples === "function" ? examples(ctx.query) : examples).slice(0, opts.max ?? 4);
      const shots: Message[] = list.flatMap((e) => [
        { role: "user" as const, content: e.user },
        { role: "assistant" as const, content: e.assistant },
      ]);
      const lastUser = messages.findLastIndex((m) => m.role === "user");
      if (lastUser === -1) return [...shots, ...messages];
      return [...messages.slice(0, lastUser), ...shots, ...messages.slice(lastUser)];
    },
  };
}

/** Chain-of-thought: ask for stepwise reasoning before the answer. */
export function cot(opts: { hidden?: boolean } = {}): Strategy {
  return {
    name: "cot",
    costMultiplier: 1.3,
    transformPrompt(messages) {
      return [
        ...messages,
        {
          role: "system",
          content: opts.hidden
            ? "Think through the problem step by step privately, then reply with only the final answer."
            : "Think through the problem step by step, then give the final answer clearly marked.",
        },
      ];
    },
  };
}

/** Step-back prompting: derive the general principle first, then answer. */
export const stepBack: Strategy = {
  name: "step-back",
  costMultiplier: 1.3,
  transformPrompt(messages) {
    return [
      ...messages,
      {
        role: "system",
        content:
          "Before answering, state the general principle or rule the question depends on, then apply it to this specific case.",
      },
    ];
  },
};
