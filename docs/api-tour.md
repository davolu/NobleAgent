# API tour

Config and execution are separate: chain methods only record settings and return `this`.
Only `ask`, `run`, `stream`, `resume` touch the network.

## Entry points

```ts
noble.support(cfg)   noble.docs(cfg)   noble.sales(cfg)   noble.research(cfg)
noble.preset(type, cfg)        // type can come from a variable or BOT_TYPE env
noble.agent(systemPrompt)      // bare agent, no preset opinions
noble.definePreset(name, fn)   // register your own (~15 lines of the public API)
noble.workflow(name)           // DAG workflow builder
```

`cfg` may be omitted — `COMPANY_NAME`, `BOT_TYPE`, `SUPPORT_HOURS` are read from env.
Unknown preset types fail loudly at startup.

## Chain methods

| Group | Methods |
|---|---|
| Identity | `.system(prompt)`, `.goal(goal)` |
| Models | `.model(id \| "auto" \| adapter, { fallback, candidates, optimiseFor, minQuality })` |
| Knowledge | `.docs(pathOrStore, { rag, ocr, cite, web, access })` |
| Prompting | `.promptEng([cot(), fewShot(…), selfConsistency()])`, `.promptTune({ keep })` |
| Tools | `.tools(fnsOrDefs, { maxSteps })`, `.mcp(client)` |
| Memory | `.memory([new SqliteMemory(), new PineconeMemory(…)])` |
| Reasoning | `.reflect({ rounds })`, `.debate({ agents } \| false)` |
| Decisions/cost | `.decide(decider)`, `.budget("$0.04")`, `.optimiseCost({ cache, trimHistory })` |
| Safety | `.guard({ input, dataChannel, toolGate })`, `.approve({ tools, via })` |
| Hooks | `.onEscalate(fn)`, `.onError(fn)` |
| Durability | `.durable({ checkpoint })`, `.schedule("0 3 * * *", fn)` |
| Observability | `.observe({ sinks, redact })` |
| Evaluation | `.evaluate({ dataset, assert, compare })` |

## Execution & inspection

```ts
await bot.ready();                           // resolve config, ingest docs (idempotent)
const r = await bot.ask(text, { user });     // RunResult (bot.run is an alias)
for await (const ev of bot.stream(text, { user })) {}  // token | tool | source | done
await bot.resume(runId, { approved: true }); // continue an approval-paused run
bot.explain();                               // every setting + its source
await bot.history({ user });
await bot.reindex();
await bot.toMCP({ port });                   // expose the bot's tools over MCP
```

## Budgets

```ts
bot.budget("$0.04");
// or
bot.budget({ usd: 0.04, steps: 8, tokens: 50_000, onExhausted: "escalate" });
```

The loop checks the hard limit **before** every model call — no decision policy, strategy or
looping model can spend past it. On exhaustion the run escalates (default) or stops.

## Tools

```ts
import { defineTool } from "noble-agent";
import { z } from "zod";

const lookupOrder = defineTool(
  { name: "lookupOrder", description: "Look up an order", params: z.object({ orderId: z.string() }) },
  async ({ orderId }) => db.orders.get(orderId)
);

bot.tools([lookupOrder], { maxSteps: 6 });
bot.tools([async function currentPlan() { return "pro"; }]); // plain functions work too
```

Zod validation errors are returned to the model (it retries), never to the user.
Tools named `create*`, `delete*`, `refund*`, `send*`, … are treated as side effects and pause
for approval — opt out per-tool with `sideEffect: false`, never globally.

## Events

Every run emits a neutral, documented event stream — `run.start`, `model.call`, `tool.call`,
`memory.read`, `memory.write`, `rag.step`, `decision`, `approval.pending`, `escalation`,
`run.end` — each carrying a `traceId`. Sinks (console, file, OpenTelemetry, Langfuse, LangSmith)
consume it; redaction runs once before fan-out; a throwing sink can never break a reply.

## Workflows

```ts
const wf = noble.workflow("etl")
  .step("extract", async () => fetchRows())
  .step("transform", { needs: ["extract"] }, async ({ results }) => clean(results.extract))
  .durable();                      // checkpoint after each step
await wf.run();                    // ready steps run in parallel
await wf.resume(runId);            // killed process? completed steps are skipped
```

## Evaluation

```ts
bot.evaluate({
  dataset: [{ input: "Is my blender covered?", expected: "two years" }],
  assert: ["cites-source", "escalates-correctly", "cost", "faithfulness"],
});
```

- `noble eval` generates a promptfoo config (we don't reimplement promptfoo).
- `noble pick-model` scores `candidates` by weighted quality/cost/latency, enforces `minQuality`,
  and writes `noble.lock` — which `.model("auto")` honours.
- `tunePrompt()` iterates prompt variants against failing cases with a **mandatory holdout**;
  variants that don't beat baseline are refused. `noble accept` applies the written diff.

## CLI

```
noble explain | eval | eval-run | reindex | pick-model | tune | accept
```
