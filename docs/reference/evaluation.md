# `.evaluate()`, pick-model, prompt tuning

## `.evaluate(config)`

Records the eval configuration on the bot; `noble eval` turns it into a promptfoo config
(NobleAgent generates, promptfoo runs — we don't reimplement it):

```ts
bot.evaluate({
  dataset: [
    { input: "Is my blender motor covered?", expected: "two years" },
    { input: "I demand a human right now", shouldEscalate: true },
  ],
  assert: ["cites-source", "escalates-correctly", "cost", "latency", "faithfulness"],
  maxCostUsd: 0.05,
  maxLatencyMs: 8000,
  compare: ["claude-sonnet-5", "gpt-5"],      // optional side-by-side providers
});
```

```bash
noble eval --bot ./src/bot.ts     # writes promptfooconfig.yaml
npx promptfoo eval                # runs it
```

### Built-in asserts

| Assert | Checks |
|---|---|
| `cites-source` | `RunResult.sources` is non-empty |
| `escalates-correctly` | `outcome === "escalated"` exactly when the case says `shouldEscalate` |
| `cost` | `cost.usd <= maxCostUsd` |
| `latency` | promptfoo latency threshold (`maxLatencyMs`) |
| `faithfulness` | LLM rubric: claims supported by the cited sources |

Each eval run goes through the real agent (`noble eval-run`), so every result carries a
`traceId` linking it back to its trace in your sinks.

## `pickModel` / `noble pick-model` {#pick-model}

Data-driven model selection: run every candidate over the dataset, score by weighted
quality/cost/latency, enforce `minQuality`, write **`noble.lock`** — which
[`.model("auto")`](/reference/models#how-auto-resolves) honours at runtime.

```ts
import { pickModel, createAdapter } from "noble-agent";

const report = await pickModel({
  candidates: [{ model: "claude-sonnet-5" }, { model: "claude-haiku-4-5-20251001" }],
  dataset,
  minQuality: 0.7,
  weights: { quality: 0.6, cost: 0.25, latency: 0.15 },
  runCase: async (model, input) => {
    const t0 = Date.now();
    const result = await bot.model(createAdapter(model)).ask(input, { sessionId: `pick-${model}` });
    return { result, latencyMs: Date.now() - t0 };
  },
});
// report.winner, report.scores[model] = { quality, avgCostUsd, avgLatencyMs, score, disqualified? }
```

Or from the CLI, given `.model("auto", { candidates })` + `.evaluate({ dataset })`:

```bash
noble pick-model --bot ./src/bot.ts    # → noble.lock written — winner: …
```

The lock file records scores and traceIds, so "why this model?" has an audit trail.

## Prompt tuning {#prompt-tuning}

`tunePrompt()` generates prompt variants from failing cases and iterates — with guardrails
that make it safe to automate:

- **Mandatory holdout** (min 20% of the dataset): a variant must beat baseline on cases it
  never trained against, or it's refused.
- **Protected `keep` lines** survive verbatim in every variant (legal text, policy rules) —
  variants that drop them are discarded before scoring.
- Accepted improvements are written as a **diff**, applied explicitly with `noble accept`.

```ts
import { tunePrompt, createAdapter } from "noble-agent";

const report = await tunePrompt({
  basePrompt: currentSystemPrompt,
  dataset,
  keep: ["Never invent policy details."],
  rounds: 2,
  adapter: createAdapter("claude-sonnet-5"),
  runCase: async (prompt, input) =>
    (await noble.agent(prompt).model(adapter).ask(input, { sessionId: "tune" })).message,
});

// report.accepted, report.holdoutBase → report.holdoutBest, report.diffPath
```

```bash
noble accept --diff noble-prompt.diff --prompt ./prompts/support.txt
```

## CLI summary

```
noble explain      # every resolved setting and its source
noble eval         # generate promptfooconfig.yaml from .evaluate()
noble eval-run     # one input through the bot → RunResult JSON (promptfoo provider)
noble reindex      # re-ingest the .docs() corpus
noble pick-model   # score candidates, write noble.lock
noble tune         # prompt tuning pointers
noble accept       # apply a tune diff
```

All commands take `--bot ./src/bot.ts` (a module exporting `bot`); on Node without type
stripping, run through tsx: `npx tsx $(which noble) explain --bot ./src/bot.ts`.
