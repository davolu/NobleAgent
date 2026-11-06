# Writing adapters

Everything pluggable in NobleAgent is an adapter behind one small interface (design principle 8).
This guide shows the four you're most likely to write: memory, sink, decider, strategy — plus model
adapters. All interfaces are exported from `noble-agent` (or `@noble-agent/core`).

## Memory adapter

```ts
import type { MemoryAdapter, Message } from "noble-agent";

export class RedisMemory implements MemoryAdapter {
  name = "redis";

  async load(sessionId: string, query?: string): Promise<Message[]> {
    // Return the conversation for THIS session only — isolation is your job.
    // `query` is passed for semantic stores; plain stores can ignore it.
    return (await this.client.lrange(`noble:${sessionId}`, 0, -1)).map((s) => JSON.parse(s));
  }

  async save(sessionId: string, turn: Message[]): Promise<void> {
    for (const m of turn) await this.client.rpush(`noble:${sessionId}`, JSON.stringify(m));
  }
}
```

Rules:
- **Key strictly per session.** The cross-session leak test in `packages/memory/test` is the contract.
- Durable store first: `composeMemory([durable, vector])` awaits the first adapter and fire-and-forgets
  the rest with retry. A semantic `load(sessionId, query)` should return *relevant* past messages —
  they're surfaced as extra context, not replayed as literal history.

Use it: `.memory([new RedisMemory()])`.

## Sink (observability)

```ts
import type { NobleEvent, Sink } from "noble-agent";

export function webhookSink(url: string): Sink {
  return {
    name: "webhook",
    async emit(e: NobleEvent) {
      await fetch(url, { method: "POST", body: JSON.stringify(e) }); // batching encouraged
    },
  };
}
```

Rules:
- Events arrive **already redacted** (redaction runs once, before fan-out).
- Throwing is fine — the bus swallows and logs locally; you can't break a reply. Don't rely on that
  as a batching strategy though; use your SDK's batcher (see the Langfuse/LangSmith sinks).
- The event schema is the public contract: `run.start`, `model.call`, `tool.call`, `memory.read`,
  `memory.write`, `rag.step`, `decision`, `approval.pending`, `escalation`, `run.end` — every event
  carries `traceId`.

Use it: `.observe({ sinks: [webhookSink(url)], redact: ["email", /\b\d{16}\b/] })`.

## Decider

```ts
import type { Decider } from "noble-agent";
```

A `Decider` answers four things (see `packages/decide` for two full implementations):

- `choose(state, question, options)` → `{ choice, p, probs }` — always return the **full**
  probability distribution; the agent logs it on every `decision` event.
- `filter(query, items)` → indices worth keeping.
- `policy(opts)` → a `DecisionPolicy` whose `route(ctx)` picks a model (or `null` to keep the current
  one). Policies run *after* the budget hard-limit check — a runaway policy cannot overspend.
- `toolGate()` → `check(call, ctx)` returning `safe | review | block`. `review` pauses for human
  approval; `block` feeds a refusal back to the model.

Keep arithmetic out of decider questions: compute numbers in code, ask qualitative questions.

Use it: `.decide(myDecider)` — or pass a bare `DecisionPolicy`.

## Strategy

```ts
import type { Strategy } from "noble-agent";

export function pirate(): Strategy {
  return {
    name: "pirate",
    costMultiplier: 1,
    transformPrompt: (messages) => [{ role: "system", content: "Answer as a pirate." }, ...messages],
  };
}

export function bestOfTwo(): Strategy {
  return {
    name: "best-of-two",
    costMultiplier: 3, // two runs + one judge call — be honest
    async wrapRun(ctx, next) {
      const a = await next({ ...ctx, messages: structuredClone(ctx.messages) });
      if (ctx.budget.exceeded()) return a; // respect the hard limit mid-strategy
      const b = await next({ ...ctx, messages: structuredClone(ctx.messages) });
      const judge = await ctx.complete({
        messages: [{ role: "user", content: `Q: ${ctx.query}\nA1: ${a.message}\nA2: ${b.message}\nReply "1" or "2".` }],
      });
      return judge.text.includes("2") ? b : a;
    },
  };
}
```

Rules:
- `transformPrompt` for cheap message rewrites; `wrapRun` to orchestrate whole runs.
- Declare an honest `costMultiplier`. **≥ 2× strategies are refused at `ready()` unless the bot has a
  budget** — that's enforced for yours too.
- Use `ctx.complete()` for auxiliary model calls: it's budget-accounted and emits `model.call` events.
- Check `ctx.budget.exceeded()` between expensive steps.

Use it: `.promptEng([pirate(), bestOfTwo()])`.

## Model adapter

```ts
import type { ModelAdapter } from "noble-agent";
```

Implement `complete(req)` (must handle tool calls: return `toolCalls` when the model requests them,
plus `usage` token counts) and `stream(req)` (yield `token` chunks, then `toolCalls`, then `usage`).
Set `price` in USD per million tokens — that's what the budget uses. `MockModelAdapter` in
`@noble-agent/providers` is the reference for tests; `AnthropicAdapter` is the reference for a real
provider.

Use it: `.model(new MyAdapter("model-id"))` — an adapter instance bypasses provider resolution
entirely, which is also how every test in this repo runs without network access.
