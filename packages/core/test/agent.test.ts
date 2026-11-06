import { describe, expect, it } from "vitest";
import { z } from "zod";
import { NobleAgent, defineTool, trimHistory, type Message, type NobleEvent, type Sink } from "@noble-agent/core";
import { MockModelAdapter } from "@noble-agent/providers";

const lookupOrder = defineTool(
  { name: "lookupOrder", description: "Look up an order by id", params: z.object({ id: z.string() }) },
  async ({ id }) => ({ id, status: "shipped", eta: "tomorrow" })
);

const getHours = defineTool(
  { name: "getHours", description: "Get support hours", params: z.object({}) },
  async () => "9-5 weekdays"
);

function collector(): { sink: Sink; events: NobleEvent[] } {
  const events: NobleEvent[] = [];
  return { sink: { name: "collector", emit: (e) => void events.push(e) }, events };
}

describe("Phase 1 — core loop", () => {
  it("a 3-line agent with two tools answers correctly (mocked model)", async () => {
    const mock = new MockModelAdapter([
      { toolCalls: [{ name: "lookupOrder", args: { id: "A1" } }] },
      { text: "Order A1 has shipped, arriving tomorrow." },
    ]);
    const { sink, events } = collector();

    const bot = new NobleAgent().tools([lookupOrder, getHours]).model(mock).memory([]).observe({ sinks: [sink] });
    const r = await bot.ask("Where is my order A1?", { user: { id: "u1" } });

    expect(r.outcome).toBe("resolved");
    expect(r.message).toContain("shipped");
    expect(r.toolCalls).toEqual([expect.objectContaining({ tool: "lookupOrder", result: expect.objectContaining({ status: "shipped" }) })]);
    expect(r.cost.tokensIn).toBeGreaterThan(0);
    expect(r.cost.usd).toBeGreaterThan(0);

    // tool result fed back to the model inside the untrusted data channel
    const second = mock.requests[1];
    const toolMsg = second.messages.find((m: Message) => m.role === "tool");
    expect(toolMsg?.content).toContain("UNTRUSTED_DATA");
    expect(toolMsg?.content).toContain("shipped");

    // neutral events, all carrying the traceId
    const types = events.map((e) => e.type);
    expect(types).toContain("run.start");
    expect(types).toContain("model.call");
    expect(types).toContain("tool.call");
    expect(types).toContain("run.end");
    expect(new Set(events.map((e) => e.traceId)).size).toBe(1);
  });

  it("maxSteps stops a looping model", async () => {
    const mock = new MockModelAdapter([{ toolCalls: [{ name: "getHours", args: {} }] }], { loop: true });
    const bot = new NobleAgent().tools([getHours], { maxSteps: 3 }).model(mock).memory([]);
    const r = await bot.ask("hours?", { sessionId: "s1" });

    expect(mock.requests.length).toBe(3);
    expect(r.outcome).toBe("escalated"); // default onExhausted
  });

  it("returns zod validation errors to the model, not the user", async () => {
    const add = defineTool(
      { name: "add", description: "Add numbers", params: z.object({ a: z.number(), b: z.number() }) },
      async ({ a, b }) => a + b
    );
    const mock = new MockModelAdapter([
      { toolCalls: [{ name: "add", args: { a: "x", b: 2 } }] },
      { toolCalls: [{ name: "add", args: { a: 1, b: 2 } }] },
      { text: "The answer is 3." },
    ]);
    const bot = new NobleAgent().tools([add]).model(mock).memory([]);
    const r = await bot.ask("1+2?", { sessionId: "s" });

    expect(r.outcome).toBe("resolved");
    const retryReq = mock.requests[1];
    const errMsg = retryReq.messages.find((m: Message) => m.role === "tool");
    expect(errMsg?.content).toContain("Invalid arguments");
    expect(r.toolCalls[0].error).toContain("Invalid arguments");
    expect(r.toolCalls[1].result).toBe(3);
  });

  it("sessionId defaults to user.id and errors when neither is present", async () => {
    const bot = new NobleAgent().model(new MockModelAdapter([{ text: "hi" }])).memory([]);
    await expect(bot.ask("hello")).rejects.toThrow(/sessionId|user/);
    const r = await bot.ask("hello", { user: { id: "u9" } });
    expect(r.outcome).toBe("resolved");
  });

  it("plain-function tools get their name inferred", async () => {
    /** Returns the current plan. */
    async function currentPlan() {
      return "pro";
    }
    const mock = new MockModelAdapter([{ toolCalls: [{ name: "currentPlan", args: {} }] }, { text: "You're on pro." }]);
    const bot = new NobleAgent().tools([currentPlan]).model(mock).memory([]);
    const r = await bot.ask("what plan am I on?", { sessionId: "s" });
    expect(r.toolCalls[0]).toMatchObject({ tool: "currentPlan", result: "pro" });
  });

  it("trimHistory cuts at user boundaries and keeps system messages", () => {
    const msgs: Message[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "q1" },
      { role: "assistant", content: "", toolCalls: [{ id: "1", name: "t", args: {} }] },
      { role: "tool", content: "r", toolCallId: "1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "q2" },
      { role: "assistant", content: "a2" },
    ];
    const trimmed = trimHistory(msgs, 3);
    expect(trimmed.map((m) => m.content)).toEqual(["sys", "q2", "a2"]);
  });

  it("stream() yields tokens then done with a result", async () => {
    const mock = new MockModelAdapter([{ text: "Hello there friend" }]);
    const bot = new NobleAgent().model(mock).memory([]);
    const events: string[] = [];
    let final;
    for await (const ev of bot.stream("hi", { sessionId: "s" })) {
      events.push(ev.type);
      if (ev.type === "done") final = ev.result;
    }
    expect(events.filter((t) => t === "token").length).toBeGreaterThan(1);
    expect(events[events.length - 1]).toBe("done");
    expect(final?.message).toBe("Hello there friend");
  });
});
