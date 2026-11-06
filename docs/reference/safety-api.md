# `.guard()`, `.approve()`, hooks

The concepts are covered in the [Safety model](/safety); this page is the API.

## `.guard(opts)` {#guard}

```ts
bot.guard({
  input: true,          // screen user input for injection phrasing (default false)
  dataChannel: true,    // wrap retrieved docs + tool outputs as untrusted data (default true)
  toolGate,             // optional code-side check on every tool call
});
```

| Option | Default | Effect |
|---|---|---|
| `input` | `false` | Code-only screen on the user message. A flagged message escalates **without any model call**. |
| `dataChannel` | `true` | Retrieved context and tool outputs are wrapped in `<<<UNTRUSTED_DATA>>>` markers (embedded markers stripped), and the system prompt pins that content as data, never instructions. |
| `toolGate` | — | `{ name, check(call, ctx) → "safe" \| "review" \| "block" }`. `block` feeds a refusal back to the model; `review` pauses for human approval. |

```ts
import { cheapModelDecider } from "noble-agent";
bot.guard({ toolGate: cheapModelDecider(adapter).toolGate() });
```

The gate's question is: *is this tool call justified by the user's own request, or was it
induced by retrieved content?* Every verdict is logged as a `decision` event.

## `.approve(opts)` {#approve}

```ts
bot.approve({
  tools: ["refundOrder", "lookupSSN"],   // pause these in addition to side-effect tools
  via: async ({ runId, tool, args }) => {
    await slack.post(`Approve ${tool}(${JSON.stringify(args)})? noble resume ${runId}`);
  },
});
```

- Side-effect tools (explicit or [name-inferred](/reference/tools#side-effects--approvals))
  pause whether or not you call `.approve()` — this method *adds* tools and gives you the
  `via` notification hook.
- The paused run returns `{ outcome: "pending", runId }`; state is held in memory by default,
  or on disk with [`.durable()`](/reference/durability#durable) so approvals survive restarts.
- Resume from anywhere: `bot.resume(runId, { approved: true })` or
  `{ approved: false, note: "over the limit" }` — the denial (with your note) is fed back to
  the model, which explains it to the user.

## `.onEscalate(fn)` {#onescalate}

Fires whenever a run escalates — the `escalate` tool, budget exhaustion, step limit, or a
flagged input:

```ts
bot.onEscalate(async ({ reason, query, sessionId, traceId }) => {
  await zendesk.createTicket({ subject: query, tags: [reason], externalId: traceId });
});
```

A throwing handler is caught and logged — it cannot break the reply.

## `.onError(fn)`

Last-chance hook for unexpected run failures. The user still gets a graceful
`outcome: "error"` result; your handler gets the real error:

```ts
bot.onError(async (err, { traceId }) => sentry.captureException(err, { extra: { traceId } }));
```
