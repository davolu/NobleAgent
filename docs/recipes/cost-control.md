# Recipe: cost control for a high-traffic bot

A bot answering thousands of questions a day lives or dies on unit cost. NobleAgent gives you
four layers that compose; this recipe applies all of them and measures the result.

## The stack

```ts
import { noble, confidenceRouter } from "noble-agent";

export const bot = noble
  .support({ company: "Acme" })
  .docs("./kb")                                          // hybrid RAG: no extra model calls
  .model("auto", {
    candidates: ["claude-sonnet-5", "claude-haiku-4-5-20251001", "gpt-5-mini"],
    minQuality: 0.75,                                    // the floor pick-model must respect
    fallback: "claude-haiku-4-5-20251001",               // outages degrade, not fail
  })
  .decide(confidenceRouter({ cheap: "claude-haiku-4-5-20251001", threshold: 0.6 }))
  .optimiseCost({ cache: true, trimHistory: 16 })
  .budget({ usd: 0.02, steps: 6, onExhausted: "escalate" });
```

## Layer by layer

### 1. Hard budget — the floor under everything

`$0.02` per run, checked **before every model call**. Whatever the other layers decide, a
single conversation can't cost more; on exhaustion the customer gets a human, not a bill.

### 2. Routing — don't pay sonnet prices for "what are your hours?"

`confidenceRouter` is code-only (free, deterministic): easy-shaped queries go to haiku, hard
ones stay on the default. Every decision is a `decision` event with the full probability
distribution, so you can audit the split:

```ts
bot.observe({ sinks: [fileSink(".noble/events.ndjson")] });
// jq 'select(.type=="decision") | .data.choice' .noble/events.ndjson | sort | uniq -c
```

Want smarter routing? Swap in `cheapModelDecider(haiku)` — one tiny model call decides — same
interface, same audit trail.

### 3. Cache + trim — don't pay twice

- Identical question in the same session within 5 minutes → cached result, zero calls.
- `trimHistory: 16` caps request size as conversations grow; trims only at user-message
  boundaries so tool calls stay paired with their results.

### 4. pick-model — make the base model a measured choice

```ts
bot.evaluate({ dataset, assert: ["cites-source", "cost"] });
```

```bash
noble pick-model --bot ./src/bot.ts
# → noble.lock written — winner: claude-haiku-4-5-20251001  (quality 0.82, $0.0009/run)
```

`noble.lock` records scores and traceIds; `.model("auto")` honours it on the next boot. When
the dataset grows or models change, re-run and the lock updates — model choice becomes a CI
artifact, not a opinion.

## Watch the actual spend

Every result carries real numbers — log them:

```ts
const r = await bot.ask(q, { user });
metrics.histogram("bot.cost_usd", r.cost.usd);
metrics.histogram("bot.tokens", r.cost.tokensIn + r.cost.tokensOut);
```

And `run.end` events include `usd` per run for any sink you attach.

## What not to do

Don't reach for expensive strategies to paper over weak retrieval — `selfConsistency({ n: 5 })`
is a 5× multiplier that often loses to spending nothing on a better chunking of your corpus.
The framework makes this visible: expensive strategies refuse to run without a budget, and
[every strategy publishes its multiplier](/strategies).
