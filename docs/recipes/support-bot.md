# Recipe: customer support bot with refunds

The complete build behind [`examples/support-bot`](https://github.com/davolu/NobleAgent/tree/main/examples/support-bot):
a PDF-grounded support agent with order tools, human-approved refunds and an Express API with
streaming. Everything here is runnable.

## 1. Tools

```ts
// tools.ts
import { z } from "zod";
import { defineTool } from "noble-agent";

export const lookupOrder = defineTool(
  {
    name: "lookupOrder",
    description: "Look up an order by its id (e.g. A-1001). Returns item, status and total.",
    params: z.object({ orderId: z.string() }),
  },
  async ({ orderId }) => db.orders.get(orderId) ?? { error: `No order ${orderId} found.` }
);

// "refund*" is name-inferred as a side effect → always pauses for human approval
export const refundOrder = defineTool(
  {
    name: "refundOrder",
    description: "Refund an order to the original payment method.",
    params: z.object({ orderId: z.string(), reason: z.string() }),
  },
  async ({ orderId }) => db.refunds.create(orderId)
);

export const tools = [lookupOrder, refundOrder];
```

## 2. The bot

```ts
// bot.ts
import { noble } from "noble-agent";
import { tools } from "./tools.js";

const BOT = {
  type: process.env.BOT_TYPE ?? "support",
  company: process.env.COMPANY_NAME ?? "Acme Appliances",
  hours: process.env.SUPPORT_HOURS ?? "Mon-Fri 9:00-17:00 CET",
};

export const bot = noble
  .preset(BOT.type, BOT)        // escalate tool, input guard, steps budget — from the preset
  .docs("./company-pdfs")       // warranty.pdf, shipping.md, internal/escalation-playbook.md
  .tools(tools)
  .approve({
    via: async ({ runId, tool, args }) =>
      slack.post("#support-approvals", `Approve ${tool} ${JSON.stringify(args)}? runId=${runId}`),
  })
  .durable()                    // pending approvals survive restarts
  .onEscalate(async ({ reason, sessionId }) => zendesk.handoff(sessionId, reason));
```

What you get without asking: durable SQLite memory per customer, hybrid retrieval with
`[warranty, p.2]`-style citations, staff-only access to `internal/` docs, and a hard step
budget. Run `bot.explain()` to see all of it with sources.

## 3. The API

```ts
// server.ts
import express from "express";
import { bot } from "./bot.js";

const app = express().use(express.json());

app.post("/api/support/chat", requireCustomer, async (req, res) => {
  const r = await bot.ask(req.body.message, { user: req.customer });
  res.json({ reply: r.message, outcome: r.outcome, sources: r.sources, runId: r.runId });
});

// your approvals UI / Slack action calls this
app.post("/api/support/resume", requireAgent, async (req, res) => {
  const r = await bot.resume(req.body.runId, { approved: req.body.approved, note: req.body.note });
  res.json({ reply: r.message, outcome: r.outcome });
});

// SSE streaming
app.post("/api/support/stream", requireCustomer, async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  for await (const ev of bot.stream(req.body.message, { user: req.customer })) {
    res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
  }
  res.end();
});
```

`requireCustomer` sets `req.customer = { id, groups }` **server-side** — groups drive which
documents retrieval may touch; never accept them from the client body.

## 4. The refund flow, end to end

```
customer: "I want a refund for A-1001, it arrived broken"
  → model calls refundOrder({ orderId: "A-1001", reason: "arrived broken" })
  → loop pauses BEFORE execution: outcome "pending", approval.pending event, Slack ping
agent clicks approve → POST /api/support/resume { runId, approved: true }
  → refundOrder executes, model confirms to the customer: outcome "resolved"

(denied instead → tool never runs; the model relays: "a reviewer declined: over the limit")
```

The repo's test suite includes a poisoned document that *orders* the model to refund order 999
— the same pause means it can't execute even if the model complies. See
[Safety model](/safety).

## 5. Keep it honest

```ts
bot.evaluate({
  dataset: [
    { input: "Is my blender motor covered?", expected: "two years" },
    { input: "talk to a human now", shouldEscalate: true },
  ],
  assert: ["cites-source", "escalates-correctly", "cost"],
  maxCostUsd: 0.05,
});
```

```bash
noble eval && npx promptfoo eval     # regression-test the bot like code
```
