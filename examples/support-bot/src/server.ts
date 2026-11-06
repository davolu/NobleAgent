import express, { type NextFunction, type Request, type Response } from "express";
import type { NobleAgent, NobleUser } from "noble-agent";
import { bot } from "./bot.js";

export interface CustomerRequest extends Request {
  customer?: NobleUser;
}

/**
 * Auth stub: in a real app this validates a session/token. Access control
 * (which docs a user can retrieve) is driven by `groups` — set by the server,
 * never by the client body.
 */
export function requireCustomer(req: CustomerRequest, res: Response, next: NextFunction): void {
  const id = req.header("x-customer-id");
  if (!id) {
    res.status(401).json({ error: "missing x-customer-id header" });
    return;
  }
  const staff = req.header("x-staff-token") === process.env.STAFF_TOKEN && !!process.env.STAFF_TOKEN;
  req.customer = { id, groups: staff ? ["staff"] : [] };
  next();
}

export function createApp(agent: NobleAgent = bot): express.Express {
  const app = express();
  app.use(express.json());

  // The acceptance endpoint from the build plan (§7).
  app.post("/api/support/chat", requireCustomer, async (req: CustomerRequest, res) => {
    const r = await agent.ask(req.body.message, { user: req.customer });
    res.json({ reply: r.message, outcome: r.outcome, sources: r.sources, runId: r.runId });
  });

  // Resume a paused (approval-pending) run — e.g. after a human approves a refund.
  app.post("/api/support/resume", requireCustomer, async (req: CustomerRequest, res) => {
    const r = await agent.resume(req.body.runId, { approved: !!req.body.approved, note: req.body.note });
    res.json({ reply: r.message, outcome: r.outcome, sources: r.sources });
  });

  // SSE streaming endpoint: token / tool / source / done events.
  app.post("/api/support/stream", requireCustomer, async (req: CustomerRequest, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    try {
      for await (const ev of agent.stream(req.body.message, { user: req.customer })) {
        res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
      }
    } catch (err) {
      res.write(`event: error\ndata: ${JSON.stringify({ message: String(err) })}\n\n`);
    }
    res.end();
  });

  return app;
}

// Started directly: node --experimental-strip-types src/server.ts
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const port = Number(process.env.PORT ?? 3000);
  createApp().listen(port, () => console.log(`support bot listening on :${port}`));
}
