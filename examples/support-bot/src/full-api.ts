/**
 * The full-API version from the build plan (§7): every chain method in one
 * (compiling, runnable) agent. This is deliberately maximal — real bots
 * should look like bot.ts.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  noble,
  confidenceRouter,
  cot,
  fewShot,
  fileSink,
  consoleSink,
  HistoryMemory,
  SqliteMemory,
  selfConsistency,
  type NobleAgent,
} from "noble-agent";
import { tools } from "./tools.js";

const here = dirname(fileURLToPath(import.meta.url));

/** Fake MCP client so the chain compiles/runs without a live MCP server. */
const demoMcpClient = {
  listTools: async () => [
    { name: "kbSearch", description: "Search the knowledge base", inputSchema: { type: "object", properties: { q: { type: "string" } } } },
  ],
  callTool: async (_name: string, args: unknown) => `kb results for ${JSON.stringify(args)}`,
};

export function buildFullApiBot(): NobleAgent {
  return noble
    .preset("support", { company: "Acme Appliances", hours: "Mon-Fri 9-17 CET" })
    .system("You are Acme's senior support agent.") // overrides the preset system prompt
    .goal("Resolve the issue in as few turns as possible; escalate cleanly when stuck.")
    .model("auto", {
      fallback: "claude-haiku-4-5-20251001",
      candidates: ["claude-sonnet-5", "claude-haiku-4-5-20251001"],
      optimiseFor: "quality",
      minQuality: 0.7,
    })
    .docs(join(here, "..", "company-pdfs"), {
      rag: "hybrid",
      ocr: "auto",
      cite: true,
      web: false, // web fallback stays off unless explicitly enabled
      access: { "internal/**": ["staff"] },
    })
    .promptEng([cot({ hidden: true }), fewShot([{ user: "Where is my order?", assistant: "Could you share your order id (looks like A-1001)?" }]), selfConsistency({ n: 3 })])
    .promptTune({ rounds: 2, keep: ["Never invent policy details."] })
    .tools(tools, { maxSteps: 6 })
    .mcp(demoMcpClient)
    .memory([new SqliteMemory(join(here, "..", ".noble", "full-api.db")), new HistoryMemory()])
    .reflect({ rounds: 1 })
    .debate(false)
    .decide(confidenceRouter({ cheap: "claude-haiku-4-5-20251001", threshold: 0.7 }))
    .budget("$0.25")
    .optimiseCost({ cache: true, trimHistory: 20, routeEasy: true })
    .guard({ input: true, dataChannel: true })
    .approve({ tools: ["refundOrder"], timeoutMs: 60_000 })
    .onEscalate(async (info) => console.log("escalated:", info.reason))
    .onError(async (err) => console.error("run error:", err))
    .durable({})
    .schedule("0 3 * * *", async () => console.log("nightly reindex"))
    .observe({ sinks: [consoleSink, fileSink(join(here, "..", ".noble", "events.ndjson"))], redact: ["user", /\b\d{16}\b/] })
    .evaluate({
      dataset: [
        { input: "Is my blender motor covered?", expected: "two years" },
        { input: "I demand to speak to a human now", shouldEscalate: true },
      ],
      assert: ["cites-source", "escalates-correctly", "cost"],
      maxCostUsd: 0.05,
    });
}
