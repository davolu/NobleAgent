# Entry points

Everything starts from the `noble` object:

```ts
import { noble } from "noble-agent";
```

## `noble.preset(type, cfg?)`

Creates a `NobleAgent` from a named preset. `type` can come from a variable or env — the
acceptance pattern is config-driven:

```ts
const BOT = { type: process.env.BOT_TYPE ?? "support", company: process.env.COMPANY_NAME };
const bot = noble.preset(BOT.type, BOT);
```

- Built-in types: `support`, `docs`, `sales`, `research` (plus anything you register).
- Unknown types **throw at startup** with the list of known presets — fail loudly, not at 2am.
- `cfg` fields: `company`, `hours`, `tone`, plus anything your own preset reads. Every field
  falls back to env: `COMPANY_NAME`, `SUPPORT_HOURS`; `type` itself falls back to `BOT_TYPE`.

## Sugar constructors

```ts
noble.support(cfg?)    // = noble.preset("support", cfg)
noble.docs(cfg?)       // = noble.preset("docs", cfg)
noble.sales(cfg?)      // = noble.preset("sales", cfg)
noble.research(cfg?)   // = noble.preset("research", cfg)
noble.agent(system)    // bare agent with your system prompt, no preset opinions
```

What the presets opine on (all overridable later in the chain):

| Preset | System prompt | Extras |
|---|---|---|
| `support` | warm support agent, cite sources, never invent policy | `escalate` tool, `.guard({ input: true })`, `.budget({ steps: 8, onExhausted: "escalate" })` |
| `docs` | answer strictly from documents with citations | — |
| `sales` | recommend what fits, never guess numbers | `escalate` tool, input guard |
| `research` | synthesise across sources, separate fact from inference | — |

## `noble.definePreset(name, fn)`

Presets are ~15 lines of the public API — readable and forkable. Register your own:

```ts
noble.definePreset("onboarding", (agent, cfg) => {
  agent._withSource("preset", () => {
    agent
      .system(`You onboard new ${cfg.company ?? "Acme"} customers. One step at a time.`)
      .goal("Get the user to a working first project.")
      .budget({ steps: 6, onExhausted: "escalate" })
      .guard({ input: true });
  });
});

const bot = noble.preset("onboarding", { company: "Acme" });
```

The `_withSource("preset", …)` wrapper attributes those settings to `preset` in
[`bot.explain()`](/reference/execution#explain) — so your users can still see what came from
the preset vs. their own chain.

## `noble.workflow(name)`

DAG workflow builder — see [Durability & workflows](/reference/durability).

## Direct class access

```ts
import { NobleAgent, defineTool, MockModelAdapter } from "noble-agent";
const bot = new NobleAgent().system("You are terse.");
```

Importing from `noble-agent` (the umbrella) also wires the registry: provider factories,
the RAG engine, the default SQLite memory convention, strategies and the MCP server. If you
import only `@noble-agent/core`, you get the agent loop with none of those conveniences —
useful for tests and minimal builds.
