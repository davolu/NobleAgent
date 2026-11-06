import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunResult } from "@noble-agent/core";
import type { EvalCase } from "./promptfoo.js";

export interface Candidate {
  model: string;
  quality?: number; // prior 0–1 when no judge is available
}

export interface PickModelOpts {
  candidates: Candidate[];
  dataset: EvalCase[];
  /** Runs one case against one model; typically bot.ask with a model override. */
  runCase: (model: string, input: string) => Promise<{ result: RunResult; latencyMs: number }>;
  /** Scores one answer 0–1; defaults to expected-substring match. */
  judge?: (c: EvalCase, answer: string) => Promise<number> | number;
  weights?: { quality?: number; cost?: number; latency?: number };
  minQuality?: number;
  lockPath?: string;
}

export interface PickModelReport {
  winner: string;
  scores: Record<string, { quality: number; avgCostUsd: number; avgLatencyMs: number; score: number; disqualified?: string }>;
  traceIds: string[];
}

/**
 * Run every candidate over the dataset, score by weighted quality/cost/latency,
 * enforce minQuality, and write noble.lock (which the runtime honours for
 * model "auto").
 */
export async function pickModel(opts: PickModelOpts): Promise<PickModelReport> {
  const weights = { quality: 0.6, cost: 0.25, latency: 0.15, ...opts.weights };
  const judge = opts.judge ?? ((c: EvalCase, answer: string) => (c.expected ? (answer.toLowerCase().includes(c.expected.toLowerCase()) ? 1 : 0) : 0.5));

  const raw: Record<string, { quality: number; avgCostUsd: number; avgLatencyMs: number }> = {};
  const traceIds: string[] = [];

  for (const cand of opts.candidates) {
    let qualitySum = 0;
    let costSum = 0;
    let latencySum = 0;
    for (const c of opts.dataset) {
      const { result, latencyMs } = await opts.runCase(cand.model, c.input);
      traceIds.push(result.traceId);
      qualitySum += await judge(c, result.message);
      costSum += result.cost.usd;
      latencySum += latencyMs;
    }
    const n = Math.max(1, opts.dataset.length);
    raw[cand.model] = { quality: qualitySum / n, avgCostUsd: costSum / n, avgLatencyMs: latencySum / n };
  }

  const maxCost = Math.max(...Object.values(raw).map((r) => r.avgCostUsd), 1e-9);
  const maxLat = Math.max(...Object.values(raw).map((r) => r.avgLatencyMs), 1);

  const scores: PickModelReport["scores"] = {};
  for (const [model, r] of Object.entries(raw)) {
    const disqualified = opts.minQuality !== undefined && r.quality < opts.minQuality ? `quality ${r.quality.toFixed(2)} < minQuality ${opts.minQuality}` : undefined;
    const score =
      weights.quality * r.quality + weights.cost * (1 - r.avgCostUsd / maxCost) + weights.latency * (1 - r.avgLatencyMs / maxLat);
    scores[model] = { ...r, score, disqualified };
  }

  const eligible = Object.entries(scores).filter(([, s]) => !s.disqualified);
  if (!eligible.length) throw new Error("pick-model: every candidate fell below minQuality.");
  const winner = eligible.sort(([, a], [, b]) => b.score - a.score)[0][0];

  const lockPath = opts.lockPath ?? join(process.cwd(), "noble.lock");
  writeFileSync(
    lockPath,
    JSON.stringify({ model: winner, pickedAt: new Date().toISOString(), scores, traceIds: traceIds.slice(0, 50) }, null, 2)
  );
  return { winner, scores, traceIds };
}
