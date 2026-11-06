# Identity & models

## `.system(prompt)` / `.goal(goal)`

```ts
bot.system("You are Acme's senior support agent.")
   .goal("Resolve the issue in as few turns as possible; escalate cleanly when stuck.");
```

`system` replaces whatever the preset set (and `explain()` will show the source flipping from
`preset` to `user`). `goal` is appended to the system prompt as `Your goal: …` — keep the
identity stable and vary the goal per deployment.

## `.model(idOrAdapter, opts?)`

```ts
bot.model("claude-sonnet-5");                       // explicit id
bot.model("auto");                                  // resolve from noble.lock, then env keys
bot.model(new MockModelAdapter([...]));             // any ModelAdapter instance — tests, custom providers
bot.model("auto", {
  fallback: "claude-haiku-4-5-20251001",            // retried once when the primary throws
  candidates: ["claude-sonnet-5", "gpt-5"],         // scored by `noble pick-model`
  minQuality: 0.7,                                  // pick-model disqualifies below this
  temperature: 0.2,
  maxTokens: 1024,
});
```

### How `"auto"` resolves

1. **`noble.lock`** in the working directory — written by [`noble pick-model`](/reference/evaluation#pick-model),
   so model choice is a measured decision, not a vibe. The runtime honours it.
2. **Environment keys** — `ANTHROPIC_API_KEY` → `claude-sonnet-5`, else `OPENAI_API_KEY` → `gpt-5`.
3. Neither → **throws at `ready()`** with instructions.

### Options

| Option | Effect |
|---|---|
| `fallback` | When the primary adapter's `complete()` throws (rate limit, outage), the call is retried once on this model. Streaming does not fall back mid-stream. |
| `candidates` | The pool `noble pick-model` evaluates. Not used at runtime. |
| `minQuality` | Floor (0–1) enforced by pick-model scoring. |
| `temperature`, `maxTokens` | Applied to every loop call. |

### Model ids and pricing

All known ids and USD-per-MTok prices live in **one module**:
[`packages/providers/src/models.ts`](https://github.com/davolu/NobleAgent/blob/main/packages/providers/src/models.ts).
Pricing feeds [budget](/reference/decisions#budget) accounting. Verify against provider docs
before relying on the numbers.

```ts
import { MODELS, priceFor, cheapModelFor, createAdapter } from "noble-agent";
```

### Writing a model adapter

```ts
interface ModelAdapter {
  id: string;
  complete(req: ModelRequest): Promise<ModelResponse>;  // must surface toolCalls + usage
  stream(req: ModelRequest): AsyncIterable<ModelChunk>; // token → toolCalls → usage
  price: { inPerMTok: number; outPerMTok: number };
}
```

`AnthropicAdapter` is the reference implementation; `MockModelAdapter` is the test harness —
script it with turns and assert on `mock.requests`:

```ts
const mock = new MockModelAdapter([
  { toolCalls: [{ name: "lookupOrder", args: { orderId: "A-1001" } }] },
  { text: "Order A-1001 has shipped." },
]);
bot.model(mock);
// after a run: mock.requests[1] is the exact request the model saw on turn 2
```
