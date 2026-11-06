import type { MemoryAdapter, Message } from "@noble-agent/core";

const quiet = () => process.env.NOBLE_QUIET === "1";

/**
 * Compose multiple adapters: the first (durable) store is the source of
 * truth for load(); the rest receive async writes with retry. A vector
 * store's semantic recall is appended as extra context, never replacing
 * the durable history.
 */
export function composeMemory(adapters: MemoryAdapter[]): MemoryAdapter {
  if (adapters.length === 0) throw new Error("composeMemory needs at least one adapter.");
  if (adapters.length === 1) return adapters[0];
  const [primary, ...secondary] = adapters;

  return {
    name: `compose(${adapters.map((a) => a.name).join("+")})`,
    async load(sessionId: string, query?: string): Promise<Message[]> {
      const base = await primary.load(sessionId, query);
      if (!query) return base;
      const seen = new Set(base.map((m) => `${m.role}:${m.content}`));
      const recalled: Message[] = [];
      for (const adapter of secondary) {
        try {
          for (const m of await adapter.load(sessionId, query)) {
            if (!seen.has(`${m.role}:${m.content}`)) recalled.push(m);
          }
        } catch (err) {
          if (!quiet()) console.error(`[noble] memory "${adapter.name}" load failed (ignored):`, err);
        }
      }
      return recalled.length
        ? [{ role: "system" as const, content: `Relevant earlier context:\n${recalled.map((m) => `${m.role}: ${m.content}`).join("\n")}` }, ...base]
        : base;
    },
    async save(sessionId: string, turn: Message[]): Promise<void> {
      await primary.save(sessionId, turn); // durable write is awaited
      for (const adapter of secondary) {
        void retry(() => adapter.save(sessionId, turn), 3).catch((err) => {
          if (!quiet()) console.error(`[noble] memory "${adapter.name}" save failed after retries:`, err);
        });
      }
    },
  };
}

async function retry<T>(fn: () => Promise<T>, times: number): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < times; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 50 * 2 ** i));
    }
  }
  throw lastErr;
}
