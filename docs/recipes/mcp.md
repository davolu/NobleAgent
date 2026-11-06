# Recipe: MCP in both directions

NobleAgent speaks MCP both ways: **consume** tools from any MCP server, and **expose** your
bot's tools to any MCP client (Claude Desktop, Claude Code, other agents).

## Consume: give your bot MCP tools

Any connected client with `listTools()` / `callTool()` works — the official SDK's `Client`
qualifies:

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { noble } from "noble-agent";

const github = new Client({ name: "noble", version: "1.0" });
await github.connect(new StdioClientTransport({ command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] }));

const bot = noble
  .agent("You triage GitHub issues for the NobleAgent repo.")
  .mcp(github)                         // every MCP tool becomes a noble tool
  .budget("$0.10");

const r = await bot.ask("Summarise open issues labelled bug, oldest first", { sessionId: "triage" });
```

Three things carry over automatically:

- **Side-effect inference**: an MCP tool named `create_issue` or `delete_branch` pauses for
  [approval](/safety#human-in-the-loop-approvals) exactly like a local tool. Remote tools are
  not more trusted because they're remote.
- **The data channel**: MCP tool outputs are wrapped as untrusted data — a web-scraping MCP
  server can't inject instructions into your run.
- **Schemas**: the server's `inputSchema` is passed to the model as-is; `explain()` flags
  tools without one.

Mix freely with local tools:

```ts
bot.mcp(github).tools([lookupCustomer, escalateTool()]);
```

## Expose: serve your bot's tools over MCP

```ts
const server = await bot.toMCP({ port: 8808 });
console.log(`MCP endpoint on :${server.port}`);
```

This serves JSON-RPC over HTTP (`initialize`, `tools/list`, `tools/call`) with zod validation
on every call. Point an HTTP-capable MCP client at it and your `lookupOrder` / `search_docs`
tools are callable from Claude Desktop or another agent.

::: warning Scope
`toMCP()` exposes **tools**, not the conversation loop — callers get your functions with
validation, not your system prompt or memory. Side-effect tools exposed this way execute
without the approval pause (the approving human is assumed to be the MCP client's operator),
so expose read-only tools unless you trust the caller.
:::

## Agent-to-agent

Because both directions exist, two NobleAgents can share capabilities:

```ts
// billing service
await billingBot.toMCP({ port: 8810 });

// support service
const billing = connectMcpOverHttp("http://billing.internal:8810");  // your thin client
supportBot.mcp(billing);   // support can now look up invoices via billing's tools
```

Each service keeps its own access control (tools validate args; retrieval filters by the
*local* user), so the boundary stays clean.
