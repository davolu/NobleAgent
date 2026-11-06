import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NobleAgent, type Message } from "@noble-agent/core";
import { MockModelAdapter } from "@noble-agent/providers";
import { HistoryMemory, SqliteMemory, composeMemory } from "@noble-agent/memory";

describe("Phase 2 — memory", () => {
  it("conversation survives a process restart with sqlite", async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "noble-")), "memory.db");

    const bot1 = new NobleAgent().model(new MockModelAdapter([{ text: "Nice to meet you, Alice!" }])).memory([new SqliteMemory(dbPath)]);
    await bot1.ask("Hi, my name is Alice", { user: { id: "u1" } });

    // "restart": brand new agent + adapter instance over the same db file
    const mock2 = new MockModelAdapter([{ text: "Your name is Alice." }]);
    const bot2 = new NobleAgent().model(mock2).memory([new SqliteMemory(dbPath)]);
    const r = await bot2.ask("What's my name?", { user: { id: "u1" } });

    expect(r.outcome).toBe("resolved");
    const history = mock2.requests[0].messages.map((m: Message) => m.content).join("\n");
    expect(history).toContain("my name is Alice");

    const stored = await bot2.history({ user: { id: "u1" } });
    expect(stored.length).toBe(4); // two turns of user+assistant
  });

  it("two users never see each other's turns (cross-session leak test)", async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "noble-")), "memory.db");
    const mem = new SqliteMemory(dbPath);

    const bot = new NobleAgent()
      .model(new MockModelAdapter([{ text: "noted" }], { loop: true }))
      .memory([mem]);
    await bot.ask("my secret is BANANA", { user: { id: "alice" } });

    const mock2 = new MockModelAdapter([{ text: "I don't know any secrets." }]);
    const bot2 = new NobleAgent().model(mock2).memory([new SqliteMemory(dbPath)]);
    await bot2.ask("what is alice's secret?", { user: { id: "bob" } });

    const bobContext = mock2.requests[0].messages.map((m: Message) => m.content).join("\n");
    expect(bobContext).not.toContain("BANANA");

    const bobHistory = await bot2.history({ user: { id: "bob" } });
    expect(bobHistory.every((m) => !m.content.includes("BANANA"))).toBe(true);
  });

  it("composeMemory: durable store is the source of truth; failing vector writes never break save", async () => {
    const durable = new HistoryMemory();
    let attempts = 0;
    const flaky = {
      name: "flaky-vector",
      load: async () => [],
      save: async () => {
        attempts++;
        throw new Error("vector store down");
      },
    };
    const mem = composeMemory([durable, flaky]);
    await mem.save("s1", [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ]);
    expect(await mem.load("s1")).toHaveLength(2); // durable write landed
    await new Promise((r) => setTimeout(r, 500)); // async retries ran and were swallowed
    expect(attempts).toBe(3);
  });

  it("composeMemory surfaces semantic recall as extra context, deduped", async () => {
    const durable = new HistoryMemory();
    await durable.save("s1", [{ role: "user", content: "current" }]);
    const vector = {
      name: "vector",
      load: async (_s: string, q?: string) => (q ? [{ role: "user" as const, content: "old relevant fact" }] : []),
      save: async () => {},
    };
    const mem = composeMemory([durable, vector]);
    const loaded = await mem.load("s1", "a query");
    expect(loaded[0].role).toBe("system");
    expect(loaded[0].content).toContain("old relevant fact");
    expect(loaded[1].content).toBe("current");
  });
});
