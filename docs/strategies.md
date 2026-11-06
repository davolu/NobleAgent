# Strategies: honest costs

Every prompting/reasoning strategy and RAG strategy declares a `costMultiplier` — roughly how many
base-run model calls it spends. Anything ≥ 2× **refuses to run without `.budget()`** (design principle 9),
and the budget hard-limit still applies inside the strategy: if the limit trips mid-strategy, remaining
samples/rounds are skipped.

Numbers below are the declared multipliers plus measured behaviour on the example eval set
(`examples/support-bot`, 2-case dataset, mock-model token counts; re-measure on your corpus with
`noble eval`).

## Prompt-level (transform the messages; ~1× cost)

| Strategy | Cost | When it helps | Notes |
|---|---|---|---|
| `zeroShot` | 1× | baseline | no-op |
| `role(persona)` | 1× | tone/stance control | prepends a system persona |
| `fewShot(examples)` | 1.2× | format-sensitive outputs | examples can be retrieved per query |
| `cot({ hidden })` | 1.3× | multi-step reasoning | `hidden: true` keeps reasoning out of the reply |
| `stepBack` | 1.3× | rule-then-case questions (warranty terms, policies) | states the general principle first |

## Run-level (wrap the whole run)

| Strategy | Cost | When it helps | Notes |
|---|---|---|---|
| `selfConsistency({ n })` | n× (default 3×) | short factual answers where variance is the enemy | majority vote on normalised answers |
| `cove()` | 3× | fact-heavy answers prone to confident errors | draft → verification questions → revise |
| `reflect({ rounds })` | 1+rounds× | quality bar on long answers | critic says "OK" → stops early |
| `reflexion(memory)` | ~2.5× | repeated similar tasks in one session | stores lessons in episodic memory |
| `skeletonOfThought()` | 2× | long structured answers | outline, then expand |
| `chainOfDensity({ rounds })` | rounds+1× | **summarisation only** — validates the task and refuses otherwise | denser rewrite per round |
| `programOfThought()` | 1.5× | arithmetic/data questions | model-written JS runs in a `node:vm` sandbox — no require, no process, no network, 1s timeout |
| `tot({ breadth, depth })` | breadth·depth+1× | search-shaped problems | bounded BFS over approaches |
| `debate({ agents, rounds })` | agents·rounds+2× | contested judgment calls | positions argued, then judged |

Rule of thumb: start with `hybrid` RAG + no run-level strategy. Add `reflect` when answer quality is
the complaint, `selfConsistency` when inconsistency is, and treat `tot`/`debate` as last resorts with
a real budget.

## RAG strategies (`.docs(path, { rag })`)

| Strategy | Cost | Extra model calls | What it does |
|---|---|---|---|
| `naive` | 1× | none | vector search only |
| `hybrid` (default) | 1× | none | vector + keyword, reciprocal-rank fusion |
| `self` | 2× | grade, maybe rewrite, critique | self-RAG: grade results, rewrite weak queries |
| `crag` | 2× | grade | corrective RAG: falls back to web **only** if `web: true` |
| `adaptive` | 1.5× | should-retrieve gate | skips retrieval for small talk |
| `agentic` | 1.5× | model-driven | exposes `search_docs` as a tool the model calls |
| `hyde` | 1.5× | hypothetical answer | embeds a hypothetical answer instead of the query |
| `fusion` | 2× | query expansion | multi-query + RRF merge |
| `graph` | 3× + offline build | one call per chunk up front | refuses to run until the graph index is built — the error tells you the build cost |

Evals: each strategy has an entry in the example's `.evaluate()` dataset; run `noble eval` then
`npx promptfoo eval` to compare on your own corpus.
