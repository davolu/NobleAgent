import { writeFileSync } from "node:fs";

export interface EvalCase {
  input: string;
  expected?: string;
  /** For escalates-correctly: should this input end in escalation? */
  shouldEscalate?: boolean;
  vars?: Record<string, unknown>;
}

export interface EvalConfig {
  dataset: EvalCase[] | string;
  assert?: BuiltinAssert[];
  compare?: string[];
  maxCostUsd?: number;
  maxLatencyMs?: number;
  description?: string;
}

export type BuiltinAssert = "cites-source" | "escalates-correctly" | "cost" | "latency" | "faithfulness";

/**
 * Generate a promptfoo config (we generate, promptfoo runs — plan §2).
 * The provider shells out to the noble CLI so eval runs go through the real
 * agent (and therefore carry traceIds linking results to traces).
 */
export function generatePromptfooConfig(cfg: EvalConfig, opts: { outPath?: string; botModule?: string } = {}): string {
  const asserts = cfg.assert ?? ["cites-source", "escalates-correctly"];
  const cases = Array.isArray(cfg.dataset) ? cfg.dataset : [];

  const config = {
    description: cfg.description ?? "noble-agent eval",
    providers: (cfg.compare?.length ? cfg.compare : [undefined]).map((model) => ({
      id: "exec:node",
      config: {
        command: `npx noble eval-run --bot ${opts.botModule ?? "./bot.ts"}${model ? ` --model ${model}` : ""}`,
      },
    })),
    prompts: ["{{input}}"],
    tests: cases.map((c) => ({
      vars: { input: c.input, ...c.vars },
      assert: buildAsserts(asserts, c, cfg),
    })),
  };

  // JSON is valid YAML; promptfoo reads promptfooconfig.yaml either way.
  const yaml = JSON.stringify(config, null, 2);
  if (opts.outPath) writeFileSync(opts.outPath, yaml);
  return yaml;
}

function buildAsserts(asserts: BuiltinAssert[], c: EvalCase, cfg: EvalConfig): unknown[] {
  const out: unknown[] = [];
  for (const a of asserts) {
    switch (a) {
      case "cites-source":
        out.push({
          type: "javascript",
          value: "JSON.parse(output).sources.length > 0",
          metric: "cites-source",
        });
        break;
      case "escalates-correctly":
        out.push({
          type: "javascript",
          value: c.shouldEscalate
            ? 'JSON.parse(output).outcome === "escalated"'
            : 'JSON.parse(output).outcome !== "escalated"',
          metric: "escalates-correctly",
        });
        break;
      case "cost":
        out.push({
          type: "javascript",
          value: `JSON.parse(output).cost.usd <= ${cfg.maxCostUsd ?? 0.05}`,
          metric: "cost",
        });
        break;
      case "latency":
        out.push({ type: "latency", threshold: cfg.maxLatencyMs ?? 10000 });
        break;
      case "faithfulness":
        out.push({
          type: "llm-rubric",
          value:
            "The answer only makes claims supported by the cited sources; it does not invent policy details or facts.",
          metric: "faithfulness",
        });
        break;
    }
    if (c.expected) out.push({ type: "contains", value: c.expected });
  }
  return out;
}
