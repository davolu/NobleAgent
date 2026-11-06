import { z } from "zod";
import { NobleAgent, defineTool, getRegistry, registerPreset, type PresetFn } from "@noble-agent/core";

export interface PresetConfig {
  type?: string;
  company?: string;
  hours?: string;
  tone?: string;
  [key: string]: unknown;
}

/** Env conventions: cfg wins, then COMPANY_NAME / BOT_TYPE / SUPPORT_HOURS. */
function fromEnv(cfg: PresetConfig): Required<Pick<PresetConfig, "company" | "hours">> & PresetConfig {
  return {
    ...cfg,
    company: (cfg.company as string) ?? process.env.COMPANY_NAME ?? "the company",
    hours: (cfg.hours as string) ?? process.env.SUPPORT_HOURS ?? "business hours",
  };
}

/** Built-in escalate tool: the model can hand off; code records the handoff. */
export function escalateTool() {
  return defineTool(
    {
      name: "escalate",
      description:
        "Hand this conversation to a human agent. Use when the customer asks for a human, is upset, or the request is outside your scope.",
      params: z.object({ reason: z.string().describe("short reason for the handoff") }),
      sideEffect: false, // pausing for approval would defeat the handoff
    },
    async (args, ctx) => {
      ctx.metadata.escalated = true;
      return `You're being connected to a human agent (reason: ${args.reason}). They'll have the full conversation context.`;
    }
  );
}

// Each preset is ~15 lines of the public API — readable and forkable.

export const supportPreset: PresetFn = (agent: NobleAgent, raw) => {
  const cfg = fromEnv(raw);
  agent._withSource("preset", () => {
    agent
      .system(
        `You are a customer support agent for ${cfg.company}. Be ${cfg.tone ?? "warm, concise and honest"}. ` +
          `Support hours: ${cfg.hours}. Answer only from the provided reference material and tools; ` +
          `if the answer isn't there, or the customer asks for a human, use the escalate tool. ` +
          `Cite sources as [title, p.N] when you use them. Never invent policy details.`
      )
      .goal("Resolve the customer's issue or escalate it cleanly — never leave them stuck.")
      .tools([escalateTool()])
      .guard({ input: true })
      .budget({ steps: 8, onExhausted: "escalate" });
  });
};

export const docsPreset: PresetFn = (agent: NobleAgent, raw) => {
  const cfg = fromEnv(raw);
  agent._withSource("preset", () => {
    agent
      .system(
        `You answer questions about ${cfg.company}'s internal documents. Answer strictly from the provided reference material, ` +
          `with citations as [title, p.N]. If the documents don't cover it, say so plainly.`
      )
      .goal("Accurate, cited answers from the document corpus.")
      .guard({});
  });
};

export const salesPreset: PresetFn = (agent: NobleAgent, raw) => {
  const cfg = fromEnv(raw);
  agent._withSource("preset", () => {
    agent
      .system(
        `You are a sales assistant for ${cfg.company}. Be helpful and straight — recommend what fits the customer's need, ` +
          `flag what doesn't, and never pressure. Use reference material for pricing and availability; never guess numbers.`
      )
      .goal("Help the customer find the right product and the next step to buy it.")
      .tools([escalateTool()])
      .guard({ input: true });
  });
};

export const researchPreset: PresetFn = (agent: NobleAgent, raw) => {
  const cfg = fromEnv(raw);
  agent._withSource("preset", () => {
    agent
      .system(
        `You are a research assistant for ${cfg.company}. Synthesise across the provided sources, separate what the sources ` +
          `say from your own inference, and cite everything as [title, p.N]. Note disagreements between sources explicitly.`
      )
      .goal("Well-sourced synthesis, not summaries of single documents.")
      .guard({});
  });
};

registerPreset("support", supportPreset);
registerPreset("docs", docsPreset);
registerPreset("sales", salesPreset);
registerPreset("research", researchPreset);

/** `noble.preset(type, cfg)` — type may come from a variable or env (BOT_TYPE). */
export function preset(type?: string, cfg: PresetConfig = {}): NobleAgent {
  const resolved = type ?? (cfg.type as string) ?? process.env.BOT_TYPE;
  if (!resolved) throw new Error("noble.preset(): no type given and BOT_TYPE is not set.");
  const reg = getRegistry();
  const fn = reg.presets.get(resolved);
  if (!fn) {
    // Validate unknown preset types at startup and fail loudly.
    throw new Error(
      `Unknown preset type "${resolved}". Known presets: ${[...reg.presets.keys()].join(", ")}. Register custom ones with noble.definePreset().`
    );
  }
  const agent = new NobleAgent();
  fn(agent, cfg);
  return agent;
}

export function definePreset(name: string, fn: PresetFn): void {
  registerPreset(name, fn);
}

export const sugar = {
  support: (cfg: PresetConfig = {}) => preset("support", cfg),
  docs: (cfg: PresetConfig = {}) => preset("docs", cfg),
  sales: (cfg: PresetConfig = {}) => preset("sales", cfg),
  research: (cfg: PresetConfig = {}) => preset("research", cfg),
  /** Bare agent with a custom system prompt — no preset opinions. */
  agent: (system: string) => new NobleAgent().system(system),
};
