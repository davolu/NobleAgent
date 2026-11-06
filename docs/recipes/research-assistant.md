# Recipe: research assistant with verified answers

A bot that synthesises across a folder of papers/reports, where wrong-but-confident answers
are worse than no answer. This recipe trades tokens for reliability — deliberately and
measurably.

## The bot

```ts
import { noble, cove, stepBack } from "noble-agent";

export const researcher = noble
  .research({ company: "Acme Research" })     // preset: synthesise, cite, separate fact from inference
  .docs("./papers", {
    rag: "fusion",                            // multi-query expansion — better recall on vague questions
    topK: 8,
  })
  .promptEng([
    stepBack,                                 // state the general principle before the specific case
    cove(),                                   // chain-of-verification: draft → verify → revise (3×)
  ])
  .budget("$0.40")                            // cove is honest about costing ~3× — pay for it explicitly
  .observe({ redact: [/\bconfidential\b/i] });
```

Why these choices:

- **`fusion` RAG**: research questions are phrased vaguely ("evidence on X affecting Y?");
  fusion expands to multiple phrasings and merges results via reciprocal-rank fusion. Costs
  one extra model call.
- **`cove()`**: the model drafts, writes its own verification questions, answers them
  independently, then revises. Catches confident fabrications. Without `.budget()`, this
  refuses to run — that's [honest strategies](/strategies) working as designed.
- **The preset's prompt** forces the fact/inference split and `[title, p.N]` citations.

## Using it

```ts
const r = await researcher.ask(
  "What does our corpus say about retrieval quality vs chunk size? Note disagreements.",
  { user: { id: "dr-chen", groups: ["staff"] } }
);

r.message   // synthesised answer with [title, p.N] citations and an explicit disagreements section
r.sources   // every doc+page actually used — render as footnotes
r.cost.usd  // typically 3-4× a plain run; the budget caps the worst case
```

## Interactive deep-dives: agentic retrieval

For "explore the corpus" sessions, switch retrieval to a tool the model drives:

```ts
researcher.docs("./papers", { rag: "agentic" }).tools([], { maxSteps: 10 });

const r = await researcher.ask(
  "Find the three strongest counter-arguments to the approach in the Nakamura paper",
  { user }
);
// the model calls search_docs repeatedly: "Nakamura", then targeted follow-up searches
```

`maxSteps` bounds the exploration; the budget bounds the bill.

## Prove it's actually better

Reliability claims need evals, not vibes:

```ts
researcher.evaluate({
  dataset: factualCases,        // inputs with expected key facts
  assert: ["cites-source", "faithfulness", "cost"],
  maxCostUsd: 0.5,
});
```

Run it with and without `cove()` (`noble eval` → `npx promptfoo eval`) and keep the verifier
only if the faithfulness delta justifies 3× the cost. The per-strategy numbers in
[Strategies & costs](/strategies) came from exactly this loop.
