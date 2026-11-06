import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { NobleEvent, Sink } from "@noble-agent/core";

export { consoleSink } from "@noble-agent/core";

/** NDJSON file sink — one event per line. */
export function fileSink(path: string): Sink {
  mkdirSync(dirname(path), { recursive: true });
  return {
    name: `file(${path})`,
    emit(e: NobleEvent) {
      appendFileSync(path, JSON.stringify(e) + "\n");
    },
  };
}

/**
 * OpenTelemetry sink: run.start/run.end become a span per trace; other events
 * are span events. Needs the optional peer @opentelemetry/api plus a
 * configured SDK in the host app.
 */
export async function otelSink(opts: { tracerName?: string } = {}): Promise<Sink> {
  let api: any;
  try {
    api = await import("@opentelemetry/api");
  } catch {
    throw new Error('otelSink requires the optional dependency "@opentelemetry/api".');
  }
  const tracer = api.trace.getTracer(opts.tracerName ?? "noble-agent");
  const spans = new Map<string, any>();
  return {
    name: "otel",
    emit(e: NobleEvent) {
      if (e.type === "run.start") {
        spans.set(e.traceId, tracer.startSpan("noble.run", { attributes: flatten(e.data) }));
      } else if (e.type === "run.end") {
        const span = spans.get(e.traceId);
        span?.setAttributes(flatten(e.data));
        span?.end();
        spans.delete(e.traceId);
      } else {
        spans.get(e.traceId)?.addEvent(e.type, flatten(e.data));
      }
    },
  };
}

/** Langfuse sink using their batched SDK. Nested: trace → spans per event. */
export async function langfuseSink(opts: Record<string, unknown> = {}): Promise<Sink> {
  let Langfuse: any;
  try {
    Langfuse = (await import("langfuse")).Langfuse;
  } catch {
    throw new Error('langfuseSink requires the optional dependency "langfuse".');
  }
  const client = new Langfuse(opts); // reads LANGFUSE_* env vars by default
  const traces = new Map<string, any>();
  return {
    name: "langfuse",
    emit(e: NobleEvent) {
      if (e.type === "run.start") {
        traces.set(e.traceId, client.trace({ id: e.traceId, name: "noble.run", input: e.data.query, metadata: e.data }));
      } else if (e.type === "run.end") {
        traces.get(e.traceId)?.update({ output: e.data.outcome, metadata: e.data });
        traces.delete(e.traceId);
        void client.flushAsync?.();
      } else {
        const trace = traces.get(e.traceId) ?? client.trace({ id: e.traceId, name: "noble.run" });
        if (e.type === "model.call") trace.generation({ name: "model.call", metadata: e.data, model: e.data.model });
        else trace.span({ name: e.type, metadata: e.data });
      }
    },
  };
}

/** LangSmith sink using their batched RunTree API. */
export async function langsmithSink(opts: { projectName?: string } = {}): Promise<Sink> {
  let RunTree: any;
  try {
    RunTree = (await import("langsmith")).RunTree;
  } catch {
    throw new Error('langsmithSink requires the optional dependency "langsmith".');
  }
  const roots = new Map<string, any>();
  return {
    name: "langsmith",
    async emit(e: NobleEvent) {
      if (e.type === "run.start") {
        const root = new RunTree({
          name: "noble.run",
          run_type: "chain",
          project_name: opts.projectName ?? process.env.LANGSMITH_PROJECT ?? "noble-agent",
          inputs: { query: e.data.query },
        });
        roots.set(e.traceId, root);
        await root.postRun();
      } else if (e.type === "run.end") {
        const root = roots.get(e.traceId);
        if (root) {
          await root.end({ outputs: e.data });
          await root.patchRun();
          roots.delete(e.traceId);
        }
      } else {
        const root = roots.get(e.traceId);
        if (root) {
          const child = await root.createChild({
            name: e.type,
            run_type: e.type === "model.call" ? "llm" : "tool",
            inputs: e.data,
          });
          await child.postRun();
          await child.end({ outputs: {} });
          await child.patchRun();
        }
      }
    },
  };
}

function flatten(data: Record<string, unknown>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(data)) {
    if (v === null || v === undefined) continue;
    out[k] = typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? v : JSON.stringify(v);
  }
  return out;
}
