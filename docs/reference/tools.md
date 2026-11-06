# `.tools()` & `.mcp()`

## `.tools(fnsOrDefs, { maxSteps })`

```ts
import { defineTool } from "noble-agent";
import { z } from "zod";

const lookupOrder = defineTool(
  {
    name: "lookupOrder",
    description: "Look up an order by its id (e.g. A-1001). Returns item, status and total.",
    params: z.object({ orderId: z.string() }),
  },
  async ({ orderId }, ctx) => db.orders.get(orderId)   // ctx = RunContext (user, traceId, emit, …)
);

bot.tools([lookupOrder, refundOrder], { maxSteps: 6 });
bot.tools({ getHours: async () => "9–17 CET" });        // add more later — tools accumulate
```

### Plain functions

Named functions work without a schema — name inferred from the function, description from a
leading comment:

```ts
bot.tools([
  /** Returns the current subscription plan. */
  async function currentPlan() { return "pro"; },
]);
```

Schemaless tools accept any object args and `explain()` flags them:
`tool "currentPlan": no zod schema — args are unvalidated.` Use `defineTool` for anything
that takes input.

### Validation

Args are validated with zod **before** the tool runs. Validation errors go back to the model
(which retries with corrected args), never to the user:

```
tool → Invalid arguments for tool "add": a: Expected number, received string
```

### Side effects & approvals

| Tool | Behaviour |
|---|---|
| `sideEffect: true` | pauses for approval |
| name matches `create* delete* remove* refund* send* update* write* post* cancel* charge* transfer*` | **inferred** side effect — pauses, never auto-approved |
| listed in `.approve({ tools })` | pauses, side effect or not |
| `sideEffect: false` | explicit opt-out — runs immediately |

A paused run returns `outcome: "pending"` + `runId`; continue with
[`bot.resume(runId, { approved })`](/reference/execution#resume). Details:
[Safety model](/safety).

### `maxSteps`

Hard cap on model-call iterations per run (default 8, convention). A looping model hits the
cap and the run escalates. The [budget](/reference/decisions#budget)'s `steps` limit, if lower,
wins — it's checked first.

### Tool outputs are untrusted

Results are wrapped in the [untrusted data channel](/safety#the-untrusted-data-channel) before
the model sees them — a tool that returns scraped or user-generated content can't inject
instructions.

## `.mcp(client)` — consume MCP tools

Any connected MCP client with `listTools()` / `callTool()` (the official SDK's `Client`
qualifies):

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
// … connect client …
bot.mcp(client);   // every MCP tool becomes a noble tool, schema passed through
```

MCP tool names go through the same side-effect inference — an MCP tool named `send_message`
pauses for approval like a local one.

## `bot.toMCP({ port })` — expose your tools

The reverse direction: serve this agent's tools over MCP (JSON-RPC over HTTP — `initialize`,
`tools/list`, `tools/call`):

```ts
const server = await bot.toMCP({ port: 8808 });
// … later
server.close();
```

Full walkthrough: [MCP recipe](/recipes/mcp).
