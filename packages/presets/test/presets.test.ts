import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { noble, MockModelAdapter, NobleAgent } from "noble-agent";

const ENV_KEYS = ["COMPANY_NAME", "BOT_TYPE", "SUPPORT_HOURS", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("Phase 8 — presets and conventions", () => {
  it("unknown preset types fail loudly at startup", () => {
    expect(() => noble.preset("telepathy", {})).toThrow(/Unknown preset type "telepathy".*support/);
    expect(() => noble.preset(undefined as unknown as string, {})).toThrow(/BOT_TYPE/);
  });

  it("BOT_TYPE and COMPANY_NAME come from env when cfg is omitted", async () => {
    process.env.BOT_TYPE = "support";
    process.env.COMPANY_NAME = "Acme Blenders";
    process.env.SUPPORT_HOURS = "9-17 CET";
    const bot = noble.preset(undefined as unknown as string, {});
    const system = bot.getConfig().get("system");
    expect(system?.source).toBe("preset");
    expect(String(system?.value)).toContain("Acme Blenders");
    expect(String(system?.value)).toContain("9-17 CET");
  });

  it("the short support bot works with a provider key and explain() lists every default", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key"; // only env needed (model calls are mocked)
    process.env.COMPANY_NAME = "Acme";

    const docsDir = mkdtempSync(join(tmpdir(), "noble-docs-"));
    writeFileSync(join(docsDir, "warranty.md"), "# Warranty\nBlender motors are covered for 2 years.");

    const bot = noble
      .support({})
      .docs(docsDir)
      .tools([async function lookupOrder() { return { status: "shipped" }; }]);
    // swap the network adapter for a scripted one; everything else is real
    bot.model(new MockModelAdapter([{ text: "Your blender motor is covered for 2 years [warranty]." }]));

    const r = await bot.ask("My blender broke, is it covered?", { user: { id: "cust-1" } });
    expect(r.outcome).toBe("resolved");
    expect(r.sources.some((s) => s.title === "warranty")).toBe(true);

    const explain = bot.explain();
    expect(explain).toContain("system");
    expect(explain).toContain("preset");
    expect(explain).toContain("maxSteps");
    expect(explain).toContain("convention");
    expect(explain).toContain("user");
    expect(explain).toMatch(/budget/);
  });

  it("the built-in escalate tool ends the run as escalated and fires onEscalate", async () => {
    const mock = new MockModelAdapter([{ toolCalls: [{ name: "escalate", args: { reason: "customer asked for a human" } }] }]);
    const escalations: string[] = [];
    const bot = noble
      .support({ company: "Acme" })
      .model(mock)
      .memory([])
      .onEscalate(async (info) => void escalations.push(info.reason));

    const r = await bot.ask("let me talk to a person", { user: { id: "u1" } });
    expect(r.outcome).toBe("escalated");
    expect(r.message).toContain("human agent");
    expect(escalations.length).toBe(1);
  });

  it("definePreset registers a custom preset usable via preset()", async () => {
    noble.definePreset("pirate", (agent: NobleAgent) => {
      agent._withSource("preset", () => agent.system("Arr, ye be helped."));
    });
    const bot = noble.preset("pirate", {});
    expect(String(bot.getConfig().get("system")?.value)).toContain("Arr");
  });

  it("noble.agent() gives a bare agent with user-source system prompt", () => {
    const bot = noble.agent("You are terse.");
    const entry = bot.getConfig().get("system");
    expect(entry).toMatchObject({ value: "You are terse.", source: "user" });
  });
});
