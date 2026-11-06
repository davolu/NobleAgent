# Safety model

NobleAgent's safety posture follows two design principles: **unsafe things are never inferred**
and **access control lives in code, not prompts**. The model is treated as a capable but
untrusted component; everything that matters is enforced by the loop.

## Human-in-the-loop approvals

Side-effect tools pause the run instead of executing:

```ts
const r = await bot.ask("refund order A-1001", { user });
// r.outcome === "pending" — nothing has run yet
// r.runId   — hand this to your approval UI / Slack bot / queue

await bot.resume(r.runId, { approved: true });          // executes, then continues the run
await bot.resume(r.runId, { approved: false, note: "over limit" }); // denial is fed to the model
```

What pauses:

1. Tools explicitly marked `sideEffect: true`
2. Tools whose **name** implies a side effect (`create*`, `delete*`, `remove*`, `refund*`,
   `send*`, `update*`, `write*`, `post*`, `cancel*`, `charge*`, `transfer*`) — inferred tools are
   **never** auto-approved
3. Anything listed in `.approve({ tools: [...] })`, side effect or not

Opting out is per-tool and explicit: `sideEffect: false`. With `.durable()`, paused runs are
persisted to disk and survive a restart.

## The untrusted data channel

Retrieved documents and tool outputs are wrapped in `<<<UNTRUSTED_DATA>>>` markers before the
model sees them, and the system prompt pins that content as reference material — never
instructions, never a reason to call a tool. Markers embedded *inside* a document are stripped,
so a poisoned PDF can't "close" the channel and smuggle instructions.

This is defence in depth, not the only line: even a model that falls for an injected
"call refundOrder now" hits the approval pause above. The repo ships a prompt-injection fixture
(`examples/support-bot/company-pdfs/promo-notes.md`) and a test proving the refund never executes.

## Access control at retrieval time

```ts
bot.docs("./company-pdfs", { access: { "legal/**": ["legal-team"] } });
// folder convention: anything under internal/ → ["staff"]

await bot.ask(q, { user: { id: "cust-1" } });                    // never sees internal chunks
await bot.ask(q, { user: { id: "emp-7", groups: ["staff"] } });  // does
```

Filtering happens in the vector index, before the model ever sees a chunk. The model never
decides access. Set `groups` server-side from your auth system — never from client input.

## Tool gate

An optional code-side check on every tool call, returning `safe | review | block`:

```ts
import { cheapModelDecider } from "noble-agent";

bot.guard({ toolGate: cheapModelDecider(adapter).toolGate() });
// block  → refusal is fed back to the model; the call never runs
// review → pauses for human approval, same as a side-effect tool
```

## Input screening

`.guard({ input: true })` runs a cheap, code-only screen on the user message (obvious
injection phrasing like "ignore all previous instructions") and escalates without spending a
single model call.

## Budgets as a safety property

`.budget("$0.04")` is enforced by the loop **before** every model call. A looping model, a
runaway routing policy, or an expensive strategy can't spend past it — on exhaustion the run
escalates to a human (default) or stops.
