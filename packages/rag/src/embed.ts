import { createHash } from "node:crypto";
import type { Embedder } from "./types.js";

/**
 * Deterministic local embedder: hashed bag of words + character trigrams.
 * No network, no model — good enough for small corpora and tests, and the
 * default fallback when no embedding provider is configured (a one-time
 * startup warning says so). Swap in a real embedder for production recall.
 */
export class LocalEmbedder implements Embedder {
  name = "local-hash";
  dims: number;

  constructor(dims = 384) {
    this.dims = dims;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.one(t));
  }

  private one(text: string): number[] {
    const v = new Array<number>(this.dims).fill(0);
    const tokens = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
    const feats: string[] = [...tokens];
    for (const tok of tokens) {
      for (let i = 0; i + 3 <= tok.length; i++) feats.push(`#${tok.slice(i, i + 3)}`);
    }
    for (const f of feats) {
      const h = createHash("sha1").update(f).digest();
      const idx = h.readUInt32BE(0) % this.dims;
      const sign = h[4] % 2 === 0 ? 1 : -1;
      v[idx] += sign;
    }
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / norm);
  }
}

/** OpenAI embeddings via plain HTTP (used when OPENAI_API_KEY is present). */
export class OpenAIEmbedder implements Embedder {
  name = "openai-embeddings";
  dims = 1536;

  constructor(
    private model = "text-embedding-3-small",
    private apiKey = process.env.OPENAI_API_KEY
  ) {
    if (!this.apiKey) throw new Error("OpenAIEmbedder needs OPENAI_API_KEY.");
  }

  async embed(texts: string[]): Promise<number[][]> {
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.model, input: texts }),
    });
    if (!res.ok) throw new Error(`Embedding call failed: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as { data: { embedding: number[] }[] };
    return data.data.map((d) => d.embedding);
  }
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  return dot; // vectors are normalised
}
