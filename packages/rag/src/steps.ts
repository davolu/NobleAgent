import type { Embedder, RagStep, ScoredChunk, WebSearchFn } from "./types.js";
import { VectorIndex, rrf } from "./store.js";

export interface StepDeps {
  index: VectorIndex;
  embedder: Embedder;
  topK: number;
  webSearch?: WebSearchFn;
  webEnabled: boolean;
}

export function makeSteps(deps: StepDeps) {
  const { index, embedder, topK } = deps;

  const retrieve =
    (mode: "vector" | "keyword" | "hybrid" = "hybrid"): RagStep =>
    async (s) => {
      const [vec] = await embedder.embed([s.query]);
      const chunks =
        mode === "vector"
          ? index.searchVector(vec, topK, s.ctx.user)
          : mode === "keyword"
            ? index.searchKeyword(s.query, topK, s.ctx.user)
            : index.searchHybrid(vec, s.query, topK, s.ctx.user);
      return { ...s, chunks };
    };

  /** Model grades retrieved chunks 0–10 for relevance; low scorers drop. */
  const grade: RagStep = async (s) => {
    if (!s.chunks.length) return s;
    const res = await s.ctx.complete({
      messages: [
        {
          role: "user",
          content: [
            `Query: ${s.originalQuery}`,
            `Rate each passage's relevance to the query from 0-10. Reply as JSON array of numbers only.`,
            ...s.chunks.map((c, i) => `[${i}] ${c.text.slice(0, 400)}`),
          ].join("\n\n"),
        },
      ],
      temperature: 0,
    });
    const scores = parseNumbers(res.text, s.chunks.length);
    const graded = s.chunks
      .map((c, i) => ({ ...c, score: scores[i] ?? 0 }))
      .filter((c) => c.score >= 4)
      .sort((a, b) => b.score - a.score);
    return { ...s, chunks: graded, notes: [...s.notes, `grade kept ${graded.length}/${s.chunks.length}`] };
  };

  /** Rewrite the query for retrieval (used when first-pass retrieval is weak). */
  const rewrite: RagStep = async (s) => {
    const res = await s.ctx.complete({
      messages: [
        {
          role: "user",
          content: `Rewrite this search query to retrieve better passages from a document corpus. Reply with the rewritten query only.\n\n${s.originalQuery}`,
        },
      ],
      temperature: 0,
    });
    return { ...s, query: res.text.trim() || s.query };
  };

  /**
   * Web fallback. Off by default (web: false) — requires explicit opt-in and
   * a configured search function. Results are marked source: "web".
   */
  const webFallback: RagStep = async (s) => {
    if (!deps.webEnabled) return { ...s, notes: [...s.notes, "webFallback skipped (web: false)"] };
    if (!deps.webSearch) {
      throw new Error('.docs({ web: true }) also needs a webSearch function: .docs(path, { web: true, store: { webSearch } }).');
    }
    const results = await deps.webSearch(s.query);
    const webChunks: ScoredChunk[] = results.slice(0, deps.topK).map((r, i) => ({
      id: `web:${i}:${r.url}`,
      docId: r.url,
      title: r.title,
      text: r.text,
      source: "web" as const,
      score: 0.5,
    }));
    return { ...s, chunks: [...s.chunks, ...webChunks] };
  };

  /** Second retrieval pass with the (possibly rewritten) query merged in. */
  const refine: RagStep = async (s) => {
    const [vec] = await embedder.embed([s.query]);
    const more = index.searchHybrid(vec, s.query, deps.topK, s.ctx.user);
    return { ...s, chunks: rrf([s.chunks, more]).slice(0, deps.topK) };
  };

  /** Adaptive gate: does this query need retrieval at all? */
  const shouldRetrieve: RagStep = async (s) => {
    const res = await s.ctx.complete({
      messages: [
        {
          role: "user",
          content: `Does answering this need looking up reference documents, or is it small talk / general chat? Reply RETRIEVE or SKIP only.\n\n${s.originalQuery}`,
        },
      ],
      temperature: 0,
    });
    return /SKIP/i.test(res.text) ? { ...s, skip: true } : s;
  };

  /** Critique the retrieved set; flags gaps in notes (used by self-RAG). */
  const critique: RagStep = async (s) => {
    if (!s.chunks.length) return { ...s, notes: [...s.notes, "critique: nothing retrieved"] };
    const res = await s.ctx.complete({
      messages: [
        {
          role: "user",
          content: `Query: ${s.originalQuery}\n\nPassages:\n${s.chunks.map((c) => c.text.slice(0, 200)).join("\n---\n")}\n\nDo these passages contain enough to answer? Reply YES or NO with one short reason.`,
        },
      ],
      temperature: 0,
    });
    return { ...s, notes: [...s.notes, `critique: ${res.text.slice(0, 120)}`] };
  };

  /** Route between retrieval modes based on query shape (code-only). */
  const route: RagStep = async (s) => {
    const kwHeavy = /"|\bexact\b|\berror code\b|\bmodel number\b/i.test(s.query);
    return retrieve(kwHeavy ? "keyword" : "hybrid")(s);
  };

  /** HyDE: embed a hypothetical answer instead of the query. */
  const hyde: RagStep = async (s) => {
    const res = await s.ctx.complete({
      messages: [{ role: "user", content: `Write a short plausible answer to: ${s.originalQuery}` }],
      temperature: 0.4,
    });
    const [vec] = await embedder.embed([res.text]);
    return { ...s, chunks: index.searchVector(vec, deps.topK, s.ctx.user) };
  };

  /** Multi-query fusion: model expands to variants, results merged via RRF. */
  const multiQuery: RagStep = async (s) => {
    const res = await s.ctx.complete({
      messages: [
        { role: "user", content: `Give 3 alternative phrasings of this search query, one per line, no numbering:\n${s.originalQuery}` },
      ],
      temperature: 0.5,
    });
    const variants = [s.originalQuery, ...res.text.split("\n").map((l) => l.trim()).filter(Boolean)].slice(0, 4);
    const lists: ScoredChunk[][] = [];
    for (const v of variants) {
      const [vec] = await embedder.embed([v]);
      lists.push(index.searchHybrid(vec, v, deps.topK, s.ctx.user));
    }
    return { ...s, chunks: rrf(lists).slice(0, deps.topK) };
  };

  return { retrieve, grade, rewrite, webFallback, refine, shouldRetrieve, critique, route, hyde, multiQuery };
}

function parseNumbers(text: string, n: number): number[] {
  const arr = text.match(/\[([\s\S]*?)\]/);
  const nums = (arr ? arr[1] : text).match(/\d+(\.\d+)?/g)?.map(Number) ?? [];
  return nums.slice(0, n);
}
