import { createServer, type Server } from "node:http";
import { z } from "zod";
import { toModelToolSpec } from "@noble-agent/core";
import type { NobleAgent, ToolDef } from "@noble-agent/core";

/** Minimal MCP client shape — the official SDK's Client satisfies this. */
export interface McpClientLike {
  listTools(): Promise<{ tools?: McpToolInfo[] } | McpToolInfo[]>;
  callTool(params: { name: string; arguments?: unknown } | string, args?: unknown): Promise<unknown>;
}

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/** Wrap MCP tools from a connected client as noble ToolDefs. */
export async function mcpTools(client: McpClientLike): Promise<ToolDef[]> {
  const listed = await client.listTools();
  const tools: McpToolInfo[] = Array.isArray(listed) ? listed : (listed.tools ?? []);
  return tools.map((t) => ({
    name: t.name,
    description: t.description ?? `MCP tool ${t.name}`,
    params: z.record(z.any()),
    jsonSchema: t.inputSchema,
    run: async (args: unknown) => {
      try {
        return await client.callTool({ name: t.name, arguments: args });
      } catch {
        return client.callTool(t.name as never, args);
      }
    },
  }));
}

/**
 * Expose an agent's tools over MCP (streamable-HTTP style JSON-RPC endpoint).
 * Minimal, dependency-free server covering initialize / tools/list /
 * tools/call — enough for MCP clients speaking HTTP JSON-RPC.
 */
export async function serveMcp(agent: NobleAgent, opts: { port?: number } = {}): Promise<{ close(): void; port: number }> {
  const tools = await agent.resolvedTools();

  const server: Server = createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      let id: unknown = null;
      try {
        const rpc = JSON.parse(body) as { id?: unknown; method: string; params?: any };
        id = rpc.id ?? null;
        const result = await handle(rpc.method, rpc.params);
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
      } catch (err) {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: String(err) } }));
      }
    });
  });

  async function handle(method: string, params: any): Promise<unknown> {
    switch (method) {
      case "initialize":
        return {
          protocolVersion: params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "noble-agent", version: "0.1.0" },
        };
      case "tools/list":
        return { tools: tools.map((t) => ({ ...toModelToolSpec(t), inputSchema: toModelToolSpec(t).inputSchema })) };
      case "tools/call": {
        const tool = tools.find((t) => t.name === params?.name);
        if (!tool) throw new Error(`Unknown tool "${params?.name}".`);
        const parsed = tool.params.safeParse(params?.arguments ?? {});
        if (!parsed.success) throw new Error(`Invalid arguments: ${parsed.error.message}`);
        const out = await tool.run(parsed.data, {
          traceId: "mcp",
          sessionId: "mcp",
          query: "",
          messages: [],
          model: "mcp",
          budget: { usd: 0, tokensIn: 0, tokensOut: 0, steps: 0, limits: {}, exceeded: () => false, reason: () => "" },
          metadata: {},
          emit: () => {},
          complete: async () => {
            throw new Error("model calls not available over toMCP()");
          },
        });
        return { content: [{ type: "text", text: typeof out === "string" ? out : JSON.stringify(out) }] };
      }
      default:
        throw new Error(`Unsupported method "${method}".`);
    }
  }

  const port = await new Promise<number>((resolve) => {
    server.listen(opts.port ?? 0, () => {
      const addr = server.address();
      resolve(typeof addr === "object" && addr ? addr.port : (opts.port ?? 0));
    });
  });

  return { close: () => server.close(), port };
}
