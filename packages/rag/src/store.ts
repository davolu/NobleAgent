import type { NobleUser } from "@noble-agent/core";
import { cosine } from "./embed.js";
import type { Chunk, ScoredChunk } from "./types.js";

/** Access control lives in code: filtering happens here, never in the prompt. */
export function userCanSee(chunk: Chunk, user?: NobleUser): boolean {
  if (!chunk.access || chunk.access.length === 0) return true;
  return (user?.groups ?? []).some((g) => chunk.access!.includes(g));
}

/**
 * In-process index for small corpora: cosine over normalised embeddings plus
 * a tf keyword score for hybrid retrieval.
 */
export class VectorIndex {
  private chunks: Chunk[] = [];

  add(chunks: Chunk[]): void {
    this.chunks.push(...chunks);
  }

  clear(): void {
    this.chunks = [];
  }

  all(): Chunk[] {
    return this.chunks;
  }

  size(): number {
    return this.chunks.length;
  }

  searchVector(queryVec: number[], k: number, user?: NobleUser): ScoredChunk[] {
    return this.chunks
      .filter((c) => userCanSee(c, user))
      .map((c) => ({ ...c, score: c.embedding ? cosine(queryVec, c.embedding) : 0 }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }

  searchKeyword(query: string, k: number, user?: NobleUser): ScoredChunk[] {
    const terms = (query.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length > 2);
    if (!terms.length) return [];
    const n = this.chunks.length || 1;
    const df = new Map<string, number>();
    for (const t of terms) {
      df.set(t, this.chunks.filter((c) => c.text.toLowerCase().includes(t)).length);
    }
    return this.chunks
      .filter((c) => userCanSee(c, user))
      .map((c) => {
        const lower = c.text.toLowerCase();
        let score = 0;
        for (const t of terms) {
          const tf = lower.split(t).length - 1;
          if (tf > 0) score += (1 + Math.log(tf)) * Math.log(1 + n / (1 + (df.get(t) ?? 0)));
        }
        return { ...c, score };
      })
      .filter((c) => c.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }

  /** Weighted blend of vector and keyword rankings (reciprocal rank fusion). */
  searchHybrid(queryVec: number[], query: string, k: number, user?: NobleUser): ScoredChunk[] {
    const vec = this.searchVector(queryVec, k * 2, user);
    const kw = this.searchKeyword(query, k * 2, user);
    return rrf([vec, kw]).slice(0, k);
  }
}

/** Reciprocal rank fusion across ranked lists. */
export function rrf(lists: ScoredChunk[][], c = 60): ScoredChunk[] {
  const byId = new Map<string, ScoredChunk>();
  for (const list of lists) {
    list.forEach((chunk, rank) => {
      const existing = byId.get(chunk.id);
      const score = 1 / (c + rank + 1);
      if (existing) existing.score += score;
      else byId.set(chunk.id, { ...chunk, score });
    });
  }
  return [...byId.values()].sort((a, b) => b.score - a.score);
}
