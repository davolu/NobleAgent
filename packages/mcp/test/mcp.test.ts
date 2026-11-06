import { describe, expect, it } from "vitest";
import { z } from "zod";
import { NobleAgent, defineTool } from "@noble-agent/core";
import { MockModelAdapter } from "@noble-agent/providers";
import { mcpTools, serveMcp } from "@noble-agent/mcp";

describe("Phase 10 — MCP", () => {
  it("toMCP exposes the agent's tools over JSON-RPC", async () => {
    const hours = defineTool(
      { name: "getHours", description: "Get support hours", params: z.object({ day: z.string().optional() }) },
      async ({ day }) => `9-5 on ${day ?? "weekdays"}`
    );
    const bot = new NobleAgent().tools([hours]).model(new MockModelAdapter([{ text: "x" }])).memory([]);
    const server = await serveMcp(bot, {});

    const rpc = async (method: string, params?: unknown) => {
      const res = await fetch(`http://127.0.0.1:${server.port}/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      return res.json() as Promise<{ result?: any; error?: any }>;
    };

    const init = await rpc("initialize", { protocolVersion: "2025-06-18" });
    expect(init.result.serverInfo.name).toBe("noble-agent");

    const list = await rpc("tools/list");
    expect(list.result.tools.map((t: any) => t.name)).toContain("getHours");

    const call = await rpc("tools/call", { name: "getHours", arguments: { day: "Monday" } });
    expect(call.result.content[0].text).toBe("9-5 on Monday");

    const bad = await rpc("tools/call", { name: "nope", arguments: {} });
    expect(bad.error.message).toContain("Unknown tool");

    server.close();
  });

  it("mcpTools wraps a client's tools as ToolDefs", async () => {
    const client = {
      listTools: async () => ({
        tools: [{ name: "lookup", description: "Lookup things", inputSchema: { type: "object", properties: { q: { type: "string" } } } }],
      }),
      callTool: async (params: any) => `looked up ${params.arguments.q}`,
    };
    const tools = await mcpTools(client);
    expect(tools[0].name).toBe("lookup");
    expect(tools[0].jsonSchema).toMatchObject({ type: "object" });
    const out = await tools[0].run({ q: "warranty" }, {} as any);
    expect(out).toBe("looked up warranty");
  });
});
