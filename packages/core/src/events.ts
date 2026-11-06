import type { NobleEvent, NobleEventType, Sink } from "./types.js";

export type Redactor = (e: NobleEvent) => NobleEvent;

const quiet = () => process.env.NOBLE_QUIET === "1";

/**
 * Fans events out to sinks. Redaction runs once, before fan-out.
 * Observability never breaks a reply: sink failures are swallowed and
 * logged locally (once per sink per bus to avoid log storms).
 */
export class EventBus {
  private warned = new Set<string>();

  constructor(
    private sinks: Sink[] = [],
    private redactor: Redactor = (e) => e
  ) {}

  setSinks(sinks: Sink[]): void {
    this.sinks = sinks;
  }

  setRedactor(r: Redactor): void {
    this.redactor = r;
  }

  emit(e: NobleEvent): void {
    let redacted: NobleEvent;
    try {
      redacted = this.redactor(e);
    } catch (err) {
      this.warnOnce("redactor", err);
      redacted = { type: e.type, traceId: e.traceId, ts: e.ts, data: { redactionError: true } };
    }
    for (const sink of this.sinks) {
      try {
        const out = sink.emit(redacted);
        if (out && typeof (out as Promise<void>).catch === "function") {
          (out as Promise<void>).catch((err) => this.warnOnce(sink.name, err));
        }
      } catch (err) {
        this.warnOnce(sink.name, err);
      }
    }
  }

  private warnOnce(name: string, err: unknown): void {
    if (this.warned.has(name)) return;
    this.warned.add(name);
    if (!quiet()) console.error(`[noble] sink "${name}" failed (further failures suppressed):`, err);
  }
}

export function makeEvent(type: NobleEventType, traceId: string, data: Record<string, unknown>): NobleEvent {
  return { type, traceId, ts: Date.now(), data };
}

/** Default console sink: compact one-line-per-event logging. */
export const consoleSink: Sink = {
  name: "console",
  emit(e) {
    if (quiet()) return;
    const summary = Object.entries(e.data)
      .slice(0, 6)
      .map(([k, v]) => `${k}=${typeof v === "string" ? v.slice(0, 80) : JSON.stringify(v)?.slice(0, 80)}`)
      .join(" ");
    console.log(`[noble] ${e.type} trace=${e.traceId.slice(0, 8)} ${summary}`);
  },
};
