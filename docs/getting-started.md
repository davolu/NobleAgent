# Getting started

## Install

```bash
pnpm add noble-agent        # or npm / yarn
export ANTHROPIC_API_KEY=…  # or OPENAI_API_KEY — "auto" picks a model from env
```

Requires Node 20+, ESM.

## A complete support bot

```ts
import { noble } from "noble-agent";
import { tools } from "./tools.js";

export const bot = noble
  .preset("support", { company: "Acme Appliances" })
  .docs("./company-pdfs")   // RAG with page-level citations
  .tools(tools);            // zod-validated, approval-gated

const r = await bot.ask("My blender broke, is it covered?", { user: { id: "cust-1" } });
// r.message  → "Yes — the motor is covered for two years [warranty, p.2]."
// r.outcome  → "resolved" | "escalated" | "pending" | "error"
// r.sources  → [{ title: "warranty", page: 2, source: "corpus" }]
// r.cost     → { usd, tokensIn, tokensOut }
```

That bot already has:

- **Durable memory** (SQLite by convention — conversations survive restarts, keyed per user)
- **Hybrid retrieval** over your PDFs/markdown with page citations and incremental re-indexing
- **A budget** (`steps: 8`, escalate on exhaustion — from the support preset)
- **Input screening and an untrusted data channel** around retrieved content and tool outputs
- **An escalate tool** wired to `outcome: "escalated"` and your `.onEscalate()` hook

Check what was decided for you:

```ts
bot.explain();
// setting   value                              source
// --------  ---------------------------------  ----------
// budget    {"steps":8,"onExhausted":...}      preset
// docs      {"pathOrStore":"./company-pdfs"}   user
// maxSteps  8                                  convention
// model     auto                               convention
// system    You are a customer support agent…  preset
```

## Behind an API

```ts
app.post("/api/support/chat", requireCustomer, async (req, res) => {
  const r = await bot.ask(req.body.message, { user: req.customer });
  res.json({ reply: r.message, outcome: r.outcome, sources: r.sources });
});
```

A refund request returns `outcome: "pending"` with a `runId` — the side-effect tool paused for
approval. A human (or your admin UI) resumes it:

```ts
await bot.resume(runId, { approved: true });
```

Streaming (SSE-friendly):

```ts
for await (const ev of bot.stream(message, { user })) {
  // { type: "token" | "tool" | "source" | "done", ... }
}
```

The full working app — Express server, sample PDFs, approval flow, tests — is in
[`examples/support-bot`](https://github.com/davolu/NobleAgent/tree/main/examples/support-bot).

## Testing without API keys

Every integration test in the repo runs against a scripted mock model:

```ts
import { MockModelAdapter } from "noble-agent";

bot.model(new MockModelAdapter([
  { toolCalls: [{ name: "lookupOrder", args: { orderId: "A-1001" } }] },
  { text: "Order A-1001 has shipped." },
]));
```

Next: the [API tour](/api-tour) covers every chain method; the [safety model](/safety) explains
approvals, the data channel and access control.
