import { z } from "zod";
import { wrapDataChannel } from "@noble-agent/core";
import type { DocsOptions, RagRetrieval, RagRunner, RunContext, SourceRef, ToolDef } from "@noble-agent/core";
import { LocalEmbedder, OpenAIEmbedder } from "./embed.js";
import { ingestDir } from "./ingest.js";
import { branch, pipe } from "./pipe.js";
import { makeSteps, type StepDeps } from "./steps.js";
import { VectorIndex } from "./store.js";
import type { Embedder, RagState, RagStep, ScoredChunk, WebSearchFn } from "./types.js";

const quiet = () => process.env.NOBLE_QUIET === "1";

const STRATEGY_COST: Record<string, number> = {
  naive: 1,
  hybrid: 1,
  self: 2,
  crag: 2,
  adaptive: 1.5,
  agentic: 1.5,
  hyde: 1.5,
  fusion: 2,
  graph: 3,
};

export interface RagRunnerOptions extends DocsOptions {
  topK?: number;
  webSearch?: WebSearchFn;
}

export class NobleRagRunner implements RagRunner {
  private index = new VectorIndex();
  private embedder: Embedder;
  private readyPromise?: Promise<void>;
  private strategy: string;
  private deps!: StepDeps;
  private steps!: ReturnType<typeof makeSteps>;

  constructor(
    private pathOrStore: string | unknown,
    private opts: RagRunnerOptions
  ) {
    this.strategy = opts.rag ?? "hybrid";
    if (!(this.strategy in STRATEGY_COST)) {
      throw new Error(`Unknown RAG strategy "${this.strategy}". Known: ${Object.keys(STRATEGY_COST).join(", ")}`);
    }
    if (this.strategy === "graph") {
      throw new Error(
        'RAG strategy "graph" needs an offline graph index built first (entity extraction over the whole corpus — roughly one model call per chunk, so corpus-size × ~$0.002 up front). Run `noble reindex --graph` to build it before enabling. Not available in v1 defaults.'
      );
    }
    const custom = opts.embedder as Embedder | undefined;
    if (custom && typeof custom.embed === "function") {
      this.embedder = custom;
    } else if (process.env.OPENAI_API_KEY) {
      this.embedder = new OpenAIEmbedder();
    } else {
      this.embedder = new LocalEmbedder();
      if (!quiet())
        console.warn(
          "[noble] no embedding provider configured — using the local hash embedder (fine for small corpora/tests, weak recall in production)."
        );
    }
  }

  async ready(): Promise<void> {
    this.readyPromise ??= this.init();
    return this.readyPromise;
  }

  private async init(): Promise<void> {
    if (typeof this.pathOrStore === "string") {
      const { chunks, changed, total } = await ingestDir(this.pathOrStore, this.embedder, {
        ocr: this.opts.ocr,
        access: this.opts.access,
      });
      this.index.clear();
      this.index.add(chunks);
      if (!quiet()) console.log(`[noble] rag: indexed ${chunks.length} chunks from ${total} files (${changed} re-read).`);
    } else if (this.pathOrStore && typeof (this.pathOrStore as VectorIndex).searchHybrid === "function") {
      this.index = this.pathOrStore as VectorIndex;
    } else {
      throw new Error(".docs(): pass a folder path or a VectorIndex store.");
    }
    this.deps = {
      index: this.index,
      embedder: this.embedder,
      topK: this.opts.topK ?? 6,
      webSearch: this.opts.webSearch ?? (this.opts.store as { webSearch?: WebSearchFn } | undefined)?.webSearch,
      webEnabled: this.opts.web === true, // web is never inferred
    };
    this.steps = makeSteps(this.deps);
  }

  async reindex(): Promise<void> {
    this.readyPromise = undefined;
    await this.ready();
  }

  private pipeline(): RagStep {
    const s = this.steps;
    switch (this.strategy) {
      case "naive":
        return pipe(["retrieve", s.retrieve("vector")]);
      case "hybrid":
        return pipe(["retrieve", s.retrieve("hybrid")]);
      case "self":
        return pipe(
          ["retrieve", s.retrieve("hybrid")],
          ["grade", s.grade],
          ["maybe-rewrite", branch((st) => st.chunks.length < 2, pipe(["rewrite", s.rewrite], ["refine", s.refine]))],
          ["critique", s.critique]
        );
      case "crag":
        return pipe(
          ["retrieve", s.retrieve("hybrid")],
          ["grade", s.grade],
          ["maybe-web", branch((st) => st.chunks.length === 0, pipe(["webFallback", s.webFallback]))]
        );
      case "adaptive":
        return pipe(["shouldRetrieve", s.shouldRetrieve], ["route", s.route]);
      case "hyde":
        return pipe(["hyde", s.hyde]);
      case "fusion":
        return pipe(["multiQuery", s.multiQuery]);
      default:
        return pipe(["retrieve", s.retrieve("hybrid")]);
    }
  }

  async retrieve(query: string, ctx: RunContext): Promise<RagRetrieval> {
    await this.ready();

    if (this.strategy === "agentic") {
      return { context: "", sources: [], asTool: this.searchTool(ctx) };
    }

    const state: RagState = { query, originalQuery: query, chunks: [], sources: [], ctx, notes: [] };
    const out = await this.pipeline()(state);
    if (out.skip || out.chunks.length === 0) return { context: "", sources: [] };
    return this.format(out.chunks);
  }

  private format(chunks: ScoredChunk[]): RagRetrieval {
    const cite = this.opts.cite !== false;
    const body = chunks
      .map((c) => `[${c.title}${c.page ? `, p.${c.page}` : ""}${c.source === "web" ? ", web" : ""}]\n${c.text}`)
      .join("\n\n---\n\n");
    const sources: SourceRef[] = [];
    const seen = new Set<string>();
    for (const c of chunks) {
      const key = `${c.docId}:${c.page ?? 0}`;
      if (seen.has(key)) continue;
      seen.add(key);
      sources.push({ title: c.title, page: c.page, id: c.id, source: c.source });
    }
    const context =
      wrapDataChannel(body) +
      (cite ? "\n\nWhen you use the reference material, cite it as [title, p.N]." : "");
    return { context, sources };
  }

  /** Agentic RAG: retrieval exposed as a tool the model calls on demand. */
  private searchTool(ctx: RunContext): ToolDef {
    const runner = this;
    return {
      name: "search_docs",
      description: "Search the document corpus for passages relevant to a query. Returns excerpts with titles and page numbers.",
      params: z.object({ query: z.string().describe("search query") }),
      sideEffect: false,
      run: async (args: { query: string }) => {
        const [vec] = await runner.embedder.embed([args.query]);
        const chunks = runner.index.searchHybrid(vec, args.query, runner.deps.topK, ctx.user);
        const { sources } = runner.format(chunks);
        (ctx.metadata.ragSources as SourceRef[] | undefined)?.push(...sources);
        return chunks.map((c) => `[${c.title}${c.page ? `, p.${c.page}` : ""}] ${c.text}`).join("\n---\n") || "No matches.";
      },
    };
  }
}

export function createRagRunner(pathOrStore: string | unknown, opts: DocsOptions): RagRunner {
  return new NobleRagRunner(pathOrStore, opts as RagRunnerOptions);
}

export { STRATEGY_COST };
