import type { MemoryAdapter, Message } from "@noble-agent/core";

export interface Embedder {
  dims: number;
  embed(texts: string[]): Promise<number[][]>;
}

/**
 * Pinecone vector memory (experimental). Stores turns as vectors and loads
 * the most relevant past turns for a query. Thin HTTP client — no SDK dep.
 * Use it composed behind a durable adapter, never as the source of truth.
 */
export class PineconeMemory implements MemoryAdapter {
  name = "pinecone";
  experimental = true;

  constructor(
    private opts: {
      indexHost: string; // e.g. https://my-index-xxxx.svc.us-east-1-aws.pinecone.io
      apiKey?: string;
      embedder: Embedder;
      namespace?: string;
      topK?: number;
    }
  ) {
    if (!(opts.apiKey ?? process.env.PINECONE_API_KEY)) {
      throw new Error("PineconeMemory needs an apiKey (or PINECONE_API_KEY).");
    }
  }

  private async call(path: string, body: unknown): Promise<any> {
    const res = await fetch(`${this.opts.indexHost}${path}`, {
      method: "POST",
      headers: {
        "Api-Key": this.opts.apiKey ?? process.env.PINECONE_API_KEY ?? "",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Pinecone ${path} failed: ${res.status} ${await res.text()}`);
    return res.json();
  }

  async load(sessionId: string, query?: string): Promise<Message[]> {
    if (!query) return [];
    const [vector] = await this.opts.embedder.embed([query]);
    const data = await this.call("/query", {
      vector,
      topK: this.opts.topK ?? 5,
      includeMetadata: true,
      namespace: this.opts.namespace ?? "noble",
      filter: { sessionId: { $eq: sessionId } }, // access control in code, not prompts
    });
    return (data.matches ?? [])
      .map((m: any) => m.metadata)
      .filter(Boolean)
      .map((md: any) => ({ role: md.role as Message["role"], content: String(md.content ?? "") }));
  }

  async save(sessionId: string, turn: Message[]): Promise<void> {
    const texts = turn.map((m) => m.content);
    const vectors = await this.opts.embedder.embed(texts);
    await this.call("/vectors/upsert", {
      namespace: this.opts.namespace ?? "noble",
      vectors: turn.map((m, i) => ({
        id: `${sessionId}:${Date.now()}:${i}`,
        values: vectors[i],
        metadata: { sessionId, role: m.role, content: m.content.slice(0, 2000) },
      })),
    });
  }
}
