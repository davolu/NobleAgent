import { z, type ZodSchema } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ModelToolSpec, RunContext, ToolDef } from "./types.js";

const SIDE_EFFECT_RE = /^(create|delete|remove|refund|send|update|write|post|cancel|charge|transfer)/i;

/** Names like createOrder / refund_payment imply side effects. */
export function inferSideEffect(name: string): boolean {
  return SIDE_EFFECT_RE.test(name);
}

/**
 * Whether a tool call must pause for human approval.
 * Explicit `sideEffect: false` opts out. Explicit `sideEffect: true` and
 * name-inferred side effects both require approval unless the tool is
 * explicitly allow-listed via `.approve({ tools })` auto rules — inference is
 * never auto-approved (design principle 4).
 */
export function requiresApproval(tool: ToolDef): boolean {
  if (tool.sideEffect === false) return false;
  if (tool.sideEffect === true) return true;
  return inferSideEffect(tool.name);
}

export interface DefineToolOpts<A> {
  name?: string;
  description?: string;
  params?: ZodSchema<A>;
  sideEffect?: boolean;
}

/** Explicit tool constructor with a zod schema. */
export function defineTool<A>(
  opts: DefineToolOpts<A> & { name: string; description: string; params: ZodSchema<A> },
  run: (args: A, ctx: RunContext) => Promise<unknown>
): ToolDef<A> {
  return { name: opts.name, description: opts.description, params: opts.params, run, sideEffect: opts.sideEffect };
}

type ToolInput = ToolDef | ((args: any, ctx?: RunContext) => unknown | Promise<unknown>);

/**
 * `.tools()` accepts plain functions or full ToolDefs.
 * Plain functions: name inferred from the function name; description from a
 * leading comment in the source if present. Without a zod schema the params
 * default to a permissive object — `explain()` flags this.
 */
export function normalizeTools(input: ToolInput[] | Record<string, ToolInput>): ToolDef[] {
  const entries: [string | null, ToolInput][] = Array.isArray(input)
    ? input.map((t) => [null, t])
    : Object.entries(input);

  return entries.map(([key, t]) => {
    if (typeof t === "function") {
      const name = key ?? t.name;
      if (!name) throw new Error("Plain-function tools need a name (named function or object key).");
      return {
        name,
        description: extractDescription(t) ?? `Tool ${name}`,
        params: z.record(z.any()) as ZodSchema<any>,
        run: async (args: any, ctx: RunContext) => t(args, ctx),
      } satisfies ToolDef;
    }
    if (!t.name || !t.params || typeof t.run !== "function") {
      throw new Error(`Invalid tool definition${t.name ? ` for "${t.name}"` : ""}: needs name, params (zod) and run().`);
    }
    return t;
  });
}

function extractDescription(fn: (...a: any[]) => unknown): string | undefined {
  const src = fn.toString();
  const m = src.match(/\/\*\*?([\s\S]*?)\*\//);
  if (m) return m[1].replace(/^\s*\*\s?/gm, "").trim().split("\n")[0];
  return undefined;
}

export function toModelToolSpec(tool: ToolDef): ModelToolSpec {
  const inputSchema =
    tool.jsonSchema ??
    (zodToJsonSchema(tool.params, { target: "openApi3" }) as Record<string, unknown>);
  // Model APIs want a top-level object schema.
  if (inputSchema.type === undefined) inputSchema.type = "object";
  return { name: tool.name, description: tool.description, inputSchema };
}

/** Validate args with zod; validation errors go back to the model, not the user. */
export function validateToolArgs(tool: ToolDef, args: unknown): { ok: true; args: any } | { ok: false; error: string } {
  const parsed = tool.params.safeParse(args ?? {});
  if (parsed.success) return { ok: true, args: parsed.data };
  const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
  return { ok: false, error: `Invalid arguments for tool "${tool.name}": ${issues}` };
}
