import { describe, expect, it } from "vitest";
import { NobleAgent, type NobleEvent, type Sink } from "@noble-agent/core";
import { MockModelAdapter } from "@noble-agent/providers";

describe("Phase 7 — observability never breaks a reply", () => {
  it("a sink that throws does not affect the reply; other sinks still receive events", async () => {
    const events: NobleEvent[] = [];
    const bad: Sink = {
      name: "explodes",
      emit() {
        throw new Error("sink is down");
      },
    };
    const asyncBad: Sink = {
      name: "explodes-async",
      emit: async () => {
        throw new Error("async down");
      },
    };
    const good: Sink = { name: "good", emit: (e) => void events.push(e) };

    const bot = new NobleAgent()
      .model(new MockModelAdapter([{ text: "all fine" }]))
      .memory([])
      .observe({ sinks: [bad, asyncBad, good] });

    const r = await bot.ask("hello", { sessionId: "s" });
    expect(r.outcome).toBe("resolved");
    expect(r.message).toBe("all fine");
    expect(events.length).toBeGreaterThan(2);
  });

  it("redaction runs once, before fan-out, on keys and patterns", async () => {
    const seen: NobleEvent[] = [];
    const sink: Sink = { name: "s", emit: (e) => void seen.push(e) };
    const bot = new NobleAgent()
      .model(new MockModelAdapter([{ text: "ok" }]))
      .memory([])
      .observe({ sinks: [sink], redact: ["user", /\d{3}-\d{2}-\d{4}/] });

    await bot.ask("my ssn is 123-45-6789", { user: { id: "alice@example.com" } });

    const start = seen.find((e) => e.type === "run.start")!;
    expect(start.data.user).toBe("[redacted]");
    expect(String(start.data.query)).not.toContain("123-45-6789");
    expect(String(start.data.query)).toContain("[redacted]");
  });
});
