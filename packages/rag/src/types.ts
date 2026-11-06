import type { RunContext, SourceRef } from "@noble-agent/core";

export interface Chunk {
  id: string;
  docId: string;
  title: string;
  page?: number;
  text: string;
  /** Groups allowed to see this chunk; empty/undefined = public. */
  access?: string[];
  source: "corpus" | "web";
  embedding?: number[];
}

export interface ScoredChunk extends Chunk {
  score: number;
}

export interface Embedder {
  name: string;
  dims: number;
  embed(texts: string[]): Promise<number[][]>;
}

export interface WebResult {
  title: string;
  url: string;
  text: string;
}

export type WebSearchFn = (query: string) => Promise<WebResult[]>;

export interface RagState {
  query: string;
  originalQuery: string;
  chunks: ScoredChunk[];
  sources: SourceRef[];
  ctx: RunContext;
  /** Set by shouldRetrieve to skip retrieval entirely. */
  skip?: boolean;
  notes: string[];
}

export type RagStep = (state: RagState) => Promise<RagState>;
