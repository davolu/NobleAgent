# `.budget()`, `.decide()`, `.optimiseCost()`

## `.budget(shorthand | limits)` {#budget}

```ts
bot.budget("$0.04");                                    // USD shorthand
bot.budget({ usd: 0.04, steps: 8, tokens: 50_000, onExhausted: "escalate" });
```

Hard limits beat smart policies: the loop checks the budget **before every model call** —
before any decision policy runs, inside every strategy, on every tool-loop iteration. Nothing
can spend past it:

- a looping model → stopped at `steps`
- a routing policy that always picks the expensive model → stopped at `usd`
- `selfConsistency({ n: 10 })` → remaining samples skipped the moment the limit trips

On exhaustion: `onExhausted: "escalate"` (default) ends the run as `outcome: "escalated"` and
fires [`.onEscalate()`](/reference/safety-api#onescalate); `"stop"` ends it as an error.
Budgets are **per run** — each `ask()` starts fresh.

Cost is computed from the adapter's `price` (USD per MTok) declared in
[models.ts](/reference/models#model-ids-and-pricing), and returned on every result:

```ts
r.cost  // { usd: 0.0031, tokensIn: 1540, tokensOut: 220 }
```

## `.decide(deciderOrPolicy)`

Routes each query to the right model before the loop starts. Accepts a full `Decider` or a
bare `DecisionPolicy`. Every decision is logged as a `decision` event **with the full
probability distribution** — auditable, not a black box.

### `confidenceRouter` — code-only, free, deterministic

```ts
import { confidenceRouter } from "noble-agent";

bot.decide(confidenceRouter({
  cheap: "claude-haiku-4-5-20251001",
  strong: "claude-sonnet-5",     // optional — defaults to the configured model
  threshold: 0.6,                // easiness required to route cheap
}));
```

Scores query "easiness" from shape (length, analytical keywords, multi-part structure). No
model call, no network, same answer every time.

### `cheapModelDecider` — a small model decides

```ts
import { cheapModelDecider, createAdapter } from "noble-agent";

const decider = cheapModelDecider(createAdapter("claude-haiku-4-5-20251001"));
bot.decide(decider);
```

Also provides `decider.choose(state, question, options)`, `decider.filter(query, items)` and
`decider.toolGate()` (→ [safety](/reference/safety-api#guard)). Questions are qualitative —
arithmetic stays in code.

### `jevDecider` <Badge type="warning" text="experimental" />

Same `Decider` interface backed by TypeSafe's Jev API (`TYPESAFE_API_KEY`,
`TYPESAFE_BASE_URL`). The SDK shape is unverified; this is a plain HTTP client you can swap
for the official SDK without touching call sites.

### Writing a policy

```ts
bot.decide({
  name: "office-hours",
  route: async (ctx) => ({
    model: isOfficeHours() ? null : "claude-haiku-4-5-20251001",  // null = keep current
    decision: { choice: isOfficeHours() ? "strong" : "cheap", p: 1, probs: { cheap: 1 } },
  }),
});
```

## `.optimiseCost(opts)`

```ts
bot.optimiseCost({
  cache: true,                   // or { ttlMs: 300_000 }
  trimHistory: 20,               // keep the last N messages per request
});
```

- **Response cache**: identical `(session, model, normalised query)` within the TTL returns
  the cached result without a model call. Only `resolved` outcomes are cached.
- **History trimming**: requests send at most N messages, cut **only at user-message
  boundaries** so an assistant tool call is never separated from its results; system messages
  survive trimming.

A worked cost-reduction setup (router + cache + budget + pick-model):
[Cost control recipe](/recipes/cost-control).

## `bot.classify(text, labels)`

Uses the configured decider when present (free/cheap), otherwise one model call:

```ts
const intent = await bot.classify(msg, ["billing", "shipping", "technical", "other"]);
```
