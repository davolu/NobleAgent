# `.observe()` — sinks, redaction, events

```ts
import { consoleSink, fileSink, langfuseSink, langsmithSink, otelSink } from "noble-agent";

bot.observe({
  sinks: [consoleSink, fileSink(".noble/events.ndjson"), await langfuseSink()],
  redact: ["email", "user", /\b\d{16}\b/],   // key names + regex patterns
});
```

Two guarantees (design principle 7):

1. **Redaction runs once, before fan-out** — no sink ever sees unredacted data, and you can't
   forget to redact one of them.
2. **Sink failures never throw into the run.** A sink that crashes (sync or async) is logged
   locally once and the reply is unaffected — there's a test for it.

## Redaction rules

- A **string** matches event-data keys case-insensitively → value replaced with `[redacted]`.
- A **RegExp** is applied to every string value (deep) → matches replaced with `[redacted]`.

## Built-in sinks

| Sink | Notes |
|---|---|
| `consoleSink` | compact one-line-per-event; silenced by `NOBLE_QUIET=1` |
| `fileSink(path)` | NDJSON, one event per line — grep-able, tail-able |
| `await otelSink({ tracerName? })` | one span per run, other events attached as span events; needs the optional `@opentelemetry/api` peer + your SDK setup |
| `await langfuseSink(opts?)` | trace per run, generation per model call, span per other event; reads `LANGFUSE_*` env; uses the batched SDK |
| `await langsmithSink({ projectName? })` | RunTree per run with child runs; reads `LANGSMITH_*` env |

The provider sinks load their SDKs lazily — install only what you use.

## The event schema (public contract)

Every event: `{ type, traceId, ts, data }`. `traceId` ties a run together across sinks and
also appears on `RunResult` and eval reports.

| `type` | Emitted when | Key `data` fields |
|---|---|---|
| `run.start` | ask/stream begins | `runId`, `sessionId`, `query`, `user` |
| `model.call` | before every completion | `model`, `step`, `purpose: "aux"` for strategy/RAG calls |
| `tool.call` | before every tool execution | `tool`, `args` |
| `memory.read` / `memory.write` | history load/save | `adapter`, `messages` |
| `rag.step` | after each retrieval pipeline step | `step`, `chunks`, `query` |
| `decision` | routing policies and tool gates | `policy`/`gate`, `choice`, `p`, `probs` |
| `approval.pending` | a tool call paused for approval | `runId`, `tool`, `args` |
| `escalation` | any escalation path | `reason` |
| `run.end` | run finished | `outcome`, `usd`, `steps` |

## Writing a sink

```ts
interface Sink { name: string; emit(e: NobleEvent): void | Promise<void> }
```

Guidance and a webhook example: [Writing adapters](/adapters#sink-observability).
