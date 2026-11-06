import { writeFileSync, readFileSync, existsSync } from "node:fs";
import type { ModelAdapter } from "@noble-agent/core";
import type { EvalCase } from "./promptfoo.js";

export interface TuneOpts {
  basePrompt: string;
  dataset: EvalCase[];
  /** Runs one case with a candidate prompt and returns the answer. */
  runCase: (prompt: string, input: string) => Promise<string>;
  judge?: (c: EvalCase, answer: string) => Promise<number> | number;
  /** Lines that must survive verbatim in every variant (policy, legal, etc.). */
  keep?: string[];
  rounds?: number;
  variantsPerRound?: number;
  /** Fraction of the dataset held out — mandatory, min 20%. */
  holdout?: number;
  adapter: ModelAdapter;
  diffPath?: string;
}

export interface TuneReport {
  accepted: boolean;
  basePrompt: string;
  bestPrompt: string;
  baseScore: number;
  bestScore: number;
  holdoutBase: number;
  holdoutBest: number;
  diffPath?: string;
}

/**
 * Prompt tuning: generate variants from failing cases, iterate rounds on the
 * train split, then compare on a mandatory holdout. A variant that doesn't
 * beat baseline on holdout is refused. Writes a diff for `noble accept`.
 */
export async function tunePrompt(opts: TuneOpts): Promise<TuneReport> {
  const judge = opts.judge ?? ((c: EvalCase, a: string) => (c.expected ? (a.toLowerCase().includes(c.expected.toLowerCase()) ? 1 : 0) : 0.5));
  const holdoutFrac = Math.max(0.2, opts.holdout ?? 0.25);
  const keep = opts.keep ?? [];
  for (const line of keep) {
    if (!opts.basePrompt.includes(line)) throw new Error(`tune: keep line not present in base prompt: "${line}"`);
  }

  const shuffled = [...opts.dataset];
  const holdoutN = Math.max(1, Math.floor(shuffled.length * holdoutFrac));
  const holdout = shuffled.slice(0, holdoutN);
  const train = shuffled.slice(holdoutN);
  if (!train.length) throw new Error("tune: dataset too small to split train/holdout.");

  const score = async (prompt: string, cases: EvalCase[]): Promise<{ score: number; failures: { c: EvalCase; answer: string }[] }> => {
    let total = 0;
    const failures: { c: EvalCase; answer: string }[] = [];
    for (const c of cases) {
      const answer = await opts.runCase(prompt, c.input);
      const s = await judge(c, answer);
      total += s;
      if (s < 0.5) failures.push({ c, answer });
    }
    return { score: total / cases.length, failures };
  };

  let best = opts.basePrompt;
  let { score: bestScore, failures } = await score(best, train);
  const baseScore = bestScore;

  for (let round = 0; round < (opts.rounds ?? 2); round++) {
    if (!failures.length) break;
    const gen = await opts.adapter.complete({
      messages: [
        {
          role: "user",
          content: [
            `Current system prompt:\n---\n${best}\n---`,
            `It fails on these cases:`,
            ...failures.slice(0, 5).map((f) => `Input: ${f.c.input}\nGot: ${f.answer.slice(0, 200)}\nWanted (contains): ${f.c.expected ?? "n/a"}`),
            `Write ${opts.variantsPerRound ?? 2} improved variants of the prompt. Each variant must contain these lines verbatim:\n${keep.join("\n") || "(none)"}`,
            `Separate variants with a line containing only "=====".`,
          ].join("\n\n"),
        },
      ],
      temperature: 0.7,
    });
    const variants = gen.text
      .split(/^=====$/m)
      .map((v) => v.trim())
      .filter((v) => v.length > 20 && keep.every((line) => v.includes(line)));

    for (const variant of variants) {
      const r = await score(variant, train);
      if (r.score > bestScore) {
        best = variant;
        bestScore = r.score;
        failures = r.failures;
      }
    }
  }

  // Mandatory holdout comparison: refuse prompts that don't beat baseline.
  const holdoutBase = (await score(opts.basePrompt, holdout)).score;
  const holdoutBest = best === opts.basePrompt ? holdoutBase : (await score(best, holdout)).score;
  const accepted = best !== opts.basePrompt && holdoutBest > holdoutBase;

  let diffPath: string | undefined;
  if (accepted) {
    diffPath = opts.diffPath ?? "noble-prompt.diff";
    writeFileSync(
      diffPath,
      JSON.stringify({ base: opts.basePrompt, tuned: best, train: { base: baseScore, best: bestScore }, holdout: { base: holdoutBase, best: holdoutBest } }, null, 2)
    );
  }

  return {
    accepted,
    basePrompt: opts.basePrompt,
    bestPrompt: accepted ? best : opts.basePrompt,
    baseScore,
    bestScore,
    holdoutBase,
    holdoutBest,
    diffPath,
  };
}

/** `noble accept`: apply a previously written tune diff to a prompt file. */
export function acceptTune(diffPath: string, promptFile: string): void {
  if (!existsSync(diffPath)) throw new Error(`accept: no diff at ${diffPath}. Run tune first.`);
  const diff = JSON.parse(readFileSync(diffPath, "utf8")) as { base: string; tuned: string };
  const current = readFileSync(promptFile, "utf8");
  if (!current.includes(diff.base)) {
    throw new Error("accept: the prompt file no longer matches the tuned baseline — re-run tune.");
  }
  writeFileSync(promptFile, current.replace(diff.base, diff.tuned));
}
