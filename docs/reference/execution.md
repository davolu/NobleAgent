# Execution & inspection

Config and execution are separate: nothing below the chain touches the network until one of
these runs.

## `bot.ready()`

Resolves the configuration (conventions → env → preset → your chain), ingests docs, connects
MCP tools, starts schedules. Idempotent — call it eagerly at boot to fail fast, or let the
first `ask()` trigger it:

```ts
await bot.ready();   // throws here, not mid-conversation, if something's misconfigured
```

## `bot.ask(text, opts)` / `bot.run(...)` {#ask}

```ts
const r = await bot.ask("My blender broke, is it covered?", {
  user: { id: "cust-1", groups: [] },   // sessionId defaults to user.id
  sessionId: "ticket-8812",             // override when a user has parallel threads
  metadata: { channel: "web" },         // carried on the RunContext
});
```

Throws if neither `sessionId` nor `user.id` is present. `run()` is an alias.

### `RunResult`

```ts
{
  message: string,
  outcome: "resolved" | "escalated" | "pending" | "error",
  sources: [{ title, page?, id, source: "corpus" | "web" }],
  toolCalls: [{ tool, args, result?, error? }],
  traceId: string,     // ties the run to events, sinks, eval reports
  runId: string,       // the handle for resume()
  cost: { usd, tokensIn, tokensOut },
}
```

| `outcome` | Meaning |
|---|---|
| `resolved` | normal answer |
| `escalated` | escalate tool / budget or step limit / flagged input — `.onEscalate()` fired |
| `pending` | a tool call is awaiting approval — resume with `runId` |
| `error` | unexpected failure — `.onError()` fired, user got a graceful message |

## `bot.stream(text, opts)` {#stream}

Async generator for token-level UIs (SSE, websockets):

```ts
for await (const ev of bot.stream(message, { user })) {
  switch (ev.type) {
    case "source": render(ev.source); break;        // retrieval citations, up front
    case "token":  write(ev.text); break;
    case "tool":   showSpinner(ev.tool); break;
    case "done":   finish(ev.result); break;        // full RunResult
  }
}
```

Tool calls, approvals, budgets and memory behave exactly as in `ask()` — a side-effect tool
mid-stream ends the stream with a `pending` result.

## `bot.resume(runId, { approved, note? })` {#resume}

Continues an approval-paused run: executes the pending tool (or feeds the denial + note back
to the model), handles any remaining tool calls from the same turn — each of which may pause
again — then finishes the run and saves memory. Unknown/completed runIds throw. Combine with
[`.durable()`](/reference/durability#durable) to survive restarts.

## `bot.history({ user | sessionId })`

The session's stored messages from the primary memory adapter.

## `bot.reindex()` {#reindex}

Re-runs document ingestion now (file hashes still skip unchanged files). Pair with
`.schedule("0 3 * * *", () => bot.reindex())`.

## `bot.classify(text, labels)` / `bot.summarise(textOrSession)`

```ts
await bot.classify("where's my parcel??", ["billing", "shipping", "other"]);  // "shipping"
await bot.summarise({ sessionId: "cust-1" });   // model summary of the stored conversation
```

`classify` uses the configured [decider](/reference/decisions) when present (cheap), else one
model call.

## `bot.explain()` {#explain}

Returns (and prints) every resolved setting with its source — `preset`, `env`, `convention`
or `user` — plus warnings (schemaless tools, convention fallbacks):

```
setting   value                                  source
--------  -------------------------------------  ----------
budget    {"steps":8,"onExhausted":"escalate"}   preset
docs      {"pathOrStore":"./company-pdfs"}       user
maxSteps  8                                      convention
model     claude-sonnet-5                        env
```

## `bot.toMCP({ port? })`

Serves the bot's tools over MCP — see [Tools](/reference/tools#bottomcp-port--expose-your-tools)
and the [MCP recipe](/recipes/mcp).

## `bot.getConfig()` / `bot.resolvedTools()` / `bot.stopSchedules()`

Introspection and lifecycle: the raw config map (used by the CLI), the final tool list
(used by `toMCP`), and a clean shutdown for `.schedule()` timers.
