import type { MemoryAdapter, Message } from "@noble-agent/core";

/** In-process conversation history. Fast, non-durable; keyed per session. */
export class HistoryMemory implements MemoryAdapter {
  name = "history";
  private sessions = new Map<string, Message[]>();

  constructor(private opts: { maxMessages?: number } = {}) {}

  async load(sessionId: string): Promise<Message[]> {
    return [...(this.sessions.get(sessionId) ?? [])];
  }

  async save(sessionId: string, turn: Message[]): Promise<void> {
    const existing = this.sessions.get(sessionId) ?? [];
    const next = [...existing, ...turn];
    const max = this.opts.maxMessages ?? 200;
    this.sessions.set(sessionId, next.length > max ? next.slice(-max) : next);
  }
}
