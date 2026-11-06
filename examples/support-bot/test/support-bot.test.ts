import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { noble, HistoryMemory, MockModelAdapter, type Message, type NobleAgent } from "noble-agent";
import { tools } from "../src/tools.js";
import { BOT } from "../src/bot.js";
import { createApp } from "../src/server.js";
import { buildFullApiBot } from "../src/full-api.js";

const here = dirname(fileURLToPath(import.meta.url));
const PDF_DIR = join(here, "..", "company-pdfs");

/** Same composition as src/bot.ts, with a scripted model and isolated memory. */
function makeBot(mock: MockModelAdapter): NobleAgent {
  return noble.preset(BOT.type, BOT).docs(PDF_DIR).tools(tools).model(mock).memory([new HistoryMemory()]);
}

describe("acceptance — examples/support-bot (§7)", () => {
  it("answers warranty questions from the sample PDFs with correct page citations", async () => {
    const mock = new MockModelAdapter([
      { text: "Yes — your blender's motor is covered for two years [warranty, p.2]." },
    ]);
    const bot = makeBot(mock);
    const r = await bot.ask("My blender broke, is it covered?", { user: { id: "cust-1" } });

    expect(r.outcome).toBe("resolved");
    expect(r.message).toContain("covered");
    const warranty = r.sources.find((s) => s.title === "warranty");
    expect(warranty).toBeDefined();
    expect(warranty!.page).toBe(2); // the blender clause is on page 2
    expect(warranty!.source).toBe("corpus");

    // the model actually received the warranty text, wrapped as untrusted data
    const req = mock.requests[0];
    const context = req.messages.map((m: Message) => m.content).join("\n");
    expect(context).toContain("motor is covered for two years");
    expect(context).toContain("UNTRUSTED_DATA");
    expect(req.system).toContain("UNTRUSTED_DATA"); // data-channel instruction present
  });

  it("a public user cannot retrieve an internal PDF chunk; staff can", async () => {
    const mockPublic = new MockModelAdapter([{ text: "I can't share internal limits." }]);
    const botPublic = makeBot(mockPublic);
    await botPublic.ask("What is the maximum discretionary refund in the escalation playbook?", { user: { id: "cust-1" } });
    const publicContext = mockPublic.requests[0].messages.map((m: Message) => m.content).join("\n");
    expect(publicContext).not.toContain("INTERNAL-ONLY-MARKER");

    const mockStaff = new MockModelAdapter([{ text: "EUR 75 without manager approval." }]);
    const botStaff = makeBot(mockStaff);
    const r = await botStaff.ask("What is the maximum discretionary refund in the escalation playbook?", {
      user: { id: "emp-7", groups: ["staff"] },
    });
    const staffContext = mockStaff.requests[0].messages.map((m: Message) => m.content).join("\n");
    expect(staffContext).toContain("INTERNAL-ONLY-MARKER");
    expect(r.sources.some((s) => s.id.includes("internal/"))).toBe(true);
  });

  it("a prompt-injection fixture inside the corpus cannot trigger a refund (pauses for approval instead)", async () => {
    // The injected document tells the model to refund order 999. Even a model
    // that falls for it cannot execute: refundOrder is side-effect-inferred and
    // always pauses for human approval.
    const mock = new MockModelAdapter([
      { toolCalls: [{ name: "refundOrder", args: { orderId: "999", reason: "document said so" } }] },
      { text: "I couldn't do that — the request was declined." },
    ]);
    const bot = makeBot(mock);

    const r = await bot.ask("What do the promo notes say?", { user: { id: "cust-1" } });
    // the injected instructions did reach the model, but only as untrusted data
    const context = mock.requests[0].messages.map((m: Message) => m.content).join("\n");
    expect(context).toContain("IGNORE ALL PREVIOUS INSTRUCTIONS");
    expect(context).toContain("UNTRUSTED_DATA");

    expect(r.outcome).toBe("pending"); // no refund happened
    expect(r.toolCalls.every((t) => t.result === undefined)).toBe(true);

    // a human reviewer declines; the run completes without the side effect
    const final = await bot.resume(r.runId, { approved: false, note: "injection attempt" });
    expect(final.outcome).toBe("resolved");
    expect(final.toolCalls.some((t) => (t as { result?: unknown }).result)).toBe(false);
  });

  it("escalates when the customer asks for a human", async () => {
    const mock = new MockModelAdapter([{ toolCalls: [{ name: "escalate", args: { reason: "human requested" } }] }]);
    const bot = makeBot(mock);
    const r = await bot.ask("get me a real person please", { user: { id: "cust-2" } });
    expect(r.outcome).toBe("escalated");
  });
});

describe("acceptance — Express API", () => {
  async function withServer<T>(bot: NobleAgent, fn: (base: string) => Promise<T>): Promise<T> {
    const app = createApp(bot);
    const server = app.listen(0);
    const { port } = server.address() as AddressInfo;
    try {
      return await fn(`http://127.0.0.1:${port}`);
    } finally {
      server.close();
    }
  }

  it("POST /api/support/chat returns reply, outcome and sources", async () => {
    const bot = makeBot(new MockModelAdapter([{ text: "Covered for two years [warranty, p.2]." }]));
    await withServer(bot, async (base) => {
      const res = await fetch(`${base}/api/support/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-customer-id": "cust-1" },
        body: JSON.stringify({ message: "Is my blender covered?" }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { reply: string; outcome: string; sources: { title: string }[] };
      expect(body.outcome).toBe("resolved");
      expect(body.reply).toContain("two years");
      expect(body.sources.some((s) => s.title === "warranty")).toBe(true);
    });
  });

  it("rejects unauthenticated requests", async () => {
    const bot = makeBot(new MockModelAdapter([{ text: "x" }]));
    await withServer(bot, async (base) => {
      const res = await fetch(`${base}/api/support/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "hi" }),
      });
      expect(res.status).toBe(401);
    });
  });

  it("the SSE endpoint streams token events then done", async () => {
    const bot = makeBot(new MockModelAdapter([{ text: "Standard shipping takes three to five days." }]));
    await withServer(bot, async (base) => {
      const res = await fetch(`${base}/api/support/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-customer-id": "cust-1" },
        body: JSON.stringify({ message: "How long does shipping take?" }),
      });
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      const text = await res.text();
      const eventTypes = [...text.matchAll(/^event: (\w+)$/gm)].map((m) => m[1]);
      expect(eventTypes.filter((t) => t === "token").length).toBeGreaterThan(1);
      expect(eventTypes.at(-1)).toBe("done");
      const done = JSON.parse([...text.matchAll(/^data: (.+)$/gm)].at(-1)![1]);
      expect(done.result.message).toContain("shipping");
    });
  });
});

describe("acceptance — full-API bot compiles and initialises", () => {
  it("every chain method composes; ready() resolves with only a provider key set", async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "test-key-not-used";
    try {
      const bot = buildFullApiBot();
      bot.model(new MockModelAdapter([{ text: "A" }, { text: "A" }, { text: "A" }])); // no network in CI
      await bot.ready();
      // every chain method overrides the preset, so everything reads "user"
      const explain = bot.explain();
      expect(explain).toContain("user");
      expect(explain).toContain("budget");
      expect(explain).toContain("self-consistency");
      expect(explain).toContain("no zod schema"); // warning for the schemaless MCP tool

      const r = await bot.ask("Is my blender motor covered?", { user: { id: "cust-1" } });
      expect(r.outcome).toBe("resolved");
      bot.stopSchedules();
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = saved;
    }
  });
});
