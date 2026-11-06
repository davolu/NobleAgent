# NobleAgent

[![CI](https://github.com/davolu/NobleAgent/actions/workflows/ci.yml/badge.svg)](https://github.com/davolu/NobleAgent/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

NobleAgent is an open-source TypeScript framework for chat agents that are safe to put in front of customers. Compose a bot in a few chained lines and get cited RAG, durable memory, hard cost budgets, and human-in-the-loop approvals out of the box — **short chains, smart defaults, full control when needed.**

**📚 Docs: [davolu.github.io/NobleAgent](https://davolu.github.io/NobleAgent/)**

```ts
import { noble } from "noble-agent";

const bot = noble
  .preset(BOT.type, BOT)      // "support" | "docs" | "sales" | "research" | custom
  .docs("./company-pdfs")     // RAG over a folder (PDF/md/txt, page citations)
  .tools(tools);              // zod-validated tools, or plain functions

const reply = await bot.ask("My blender broke, is it covered?", { user });
// { message, outcome, sources: [{ title: "warranty", page: 2, ... }], cost, traceId }
```

That's the whole bot. Everything else — model selection, memory, budgets, safety, observability — has a sensible default you can override one chain link at a time. The complete working app lives in [`examples/support-bot`](examples/support-bot).

## Design principles

1. **Do more with less.** The common case is 3–5 chained lines; presets, conventions and env detection fill the gaps.
2. **Config and execution are separate.** Chained methods only record settings. Only `ask`, `run`, `stream`, `resume` touch the network.
3. **Nothing is a black box.** `bot.explain()` prints every resolved setting and its source (`preset` / `env` / `convention` / `user`).
4. **Unsafe things are never inferred.** Web fallback, auto-approving side-effect tools and expensive strategies require explicit opt-in.
5. **Hard limits beat smart policies.** The budget is enforced by the loop before any decision policy runs.
6. **Access control lives in code, not prompts.** Retrieval filters and tool gates enforce permissions; the model never decides access.
7. **Observability never breaks a reply.** Sink failures are swallowed and logged locally.
8. **Everything pluggable has one interface.** Models, memory, vector stores, strategies, sinks and deciders are adapters.
9. **Honest strategies.** Every strategy reports its cost multiplier; expensive ones refuse to run without a budget.

## Install

```bash
pnpm add noble-agent        # umbrella package: everything wired
export ANTHROPIC_API_KEY=…  # or OPENAI_API_KEY — "auto" picks a model from env
```

Requires Node 20+, ESM.

## API tour

### Entry points

```ts
noble.support(cfg)   noble.docs(cfg)   noble.sales(cfg)   noble.research(cfg)
noble.preset(type, cfg)        // type can come from a variable or BOT_TYPE env
noble.agent(systemPrompt)      // bare agent, no preset opinions
noble.definePreset(name, fn)   // register your own (~15 lines of the public API)
noble.workflow(name)           // DAG workflow builder
```

`cfg` may be omitted — `COMPANY_NAME`, `BOT_TYPE`, `SUPPORT_HOURS` are read from env. Unknown preset types fail loudly at startup.

### Chain methods (all return `this`, none touch the network)

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

### Execution & inspection

```ts
await bot.ready();                          // resolve config, ingest docs (idempotent)
const r = await bot.ask(text, { user });    // RunResult (bot.run is an alias)
for await (const ev of bot.stream(text, { user })) …  // { type: "token" | "tool" | "source" | "done" }
await bot.resume(runId, { approved: true }); // continue an approval-paused run
bot.explain();                              // every setting + its source
await bot.history({ user });  await bot.reindex();  await bot.toMCP({ port });
```

### Safety model

- **Side-effect tools pause for approval.** Explicit `sideEffect: true`, names like `refund*`/`create*`/`delete*`/`send*` (inferred — never auto-approved), or anything listed in `.approve({ tools })`. The run returns `outcome: "pending"`; a human calls `bot.resume(runId, { approved })`.
- **Untrusted data channel.** Retrieved documents and tool outputs are wrapped in `<<<UNTRUSTED_DATA>>>` markers (embedded markers are stripped so a document can't close the channel), and the system prompt pins them as data, not instructions.
- **Tool gate.** `.guard({ toolGate })` runs a code-side `safe | review | block` check on every call — e.g. `cheapModelDecider(adapter).toolGate()`.
- **Access control at query time.** Folder conventions (`internal/**` → `staff`) plus explicit `access` maps filter retrieval by `user.groups` — in code, before the model ever sees a chunk.

### Budgets

```ts
bot.budget("$0.04")                             // or { usd, steps, tokens, onExhausted: "escalate" | "stop" }
```

The loop checks the hard limit **before** every model call, so no decision policy, strategy or looping model can spend past it.

### RAG strategies

`.docs(path, { rag: "hybrid" })` — `naive`, `hybrid` (default), `self`, `crag`, `adaptive`, `agentic` (retrieval as a tool), `hyde`, `fusion`. `graph` requires building an offline index first and tells you what that costs. `web: false` by default; web results are marked `source: "web"`. See [docs/strategies.md](docs/strategies.md) for cost/quality notes.

### Evaluation

```ts
bot.evaluate({ dataset, assert: ["cites-source", "escalates-correctly", "cost", "faithfulness"] });
```

`noble eval` generates a promptfoo config (we don't reimplement promptfoo). `noble pick-model` scores `candidates` by weighted quality/cost/latency, enforces `minQuality`, and writes `noble.lock` — which `.model("auto")` honours. `tunePrompt()` iterates prompt variants against failing cases with a **mandatory holdout**: a variant that doesn't beat baseline is refused; `noble accept` applies the written diff.

### Workflows

```ts
const wf = noble.workflow("etl")
  .step("extract", async () => fetchRows())
  .step("transform", { needs: ["extract"] }, async ({ results }) => clean(results.extract))
  .durable();                      // checkpoint after each step
await wf.run();                    // ready steps run in parallel
await wf.resume(runId);            // killed process? completed steps are skipped
```

### CLI

```
noble explain | eval | eval-run | reindex | pick-model | tune | accept
```

## Monorepo layout

| Package | What's in it |
|---|---|
| `@noble-agent/core` | `NobleAgent`, run loop, types, events, budget, guard, explain |
| `@noble-agent/providers` | Anthropic, OpenAI, Mock adapters; model ids/pricing in one module |
| `@noble-agent/memory` | history, sqlite (default durable), postgres, pinecone, compose |
| `@noble-agent/rag` | pipe/branch steps, strategies, PDF ingestion, access control |
| `@noble-agent/strategies` | CoT → debate, each with an honest `costMultiplier` |
| `@noble-agent/decide` | `confidenceRouter`, `cheapModelDecider`, Jev adapter (experimental) |
| `@noble-agent/observe` | console, file, OpenTelemetry, Langfuse, LangSmith sinks |
| `@noble-agent/eval` | promptfoo generation, pick-model, prompt tuning |
| `@noble-agent/workflow` | DAG workflows, durability, cron scheduling |
| `@noble-agent/mcp` | consume MCP tools; `bot.toMCP()` server |
| `@noble-agent/presets` | support/docs/sales/research presets, `definePreset` |
| `noble-agent` | umbrella: re-exports everything, wires the registry |
| `@noble-agent/cli` | `npx noble …` |

Writing your own adapter (memory, sink, decider, strategy)? See [docs/adapters.md](docs/adapters.md).

## Development

```bash
pnpm install
pnpm test        # vitest, 82 tests — all integration tests run against a scripted mock model
pnpm build       # tsup, all packages
pnpm lint && pnpm exec tsc --noEmit -p tsconfig.json
```

Model ids and pricing live in `packages/providers/src/models.ts` — verify against provider docs before release.

## Contributing

NobleAgent is MIT-licensed and built in the open. Issues and PRs are welcome — the bar for a change is the same as for the codebase: a test that proves it (all tests run against a scripted mock model, so you don't need API keys), `pnpm lint && pnpm test && pnpm build` green, and honest cost declarations on anything that spends tokens. Adapter contributions (memory stores, sinks, deciders, strategies) are the easiest way in — see [docs/adapters.md](docs/adapters.md).

## License

[MIT](LICENSE)
