# `.docs()` — knowledge & RAG

```ts
bot.docs("./company-pdfs");                       // all defaults: hybrid retrieval, citations on
bot.docs("./company-pdfs", {
  rag: "hybrid",                                  // naive | hybrid | self | crag | adaptive | agentic | hyde | fusion
  topK: 6,                                        // chunks injected per query
  cite: true,                                     // ask the model to cite [title, p.N]
  ocr: "auto",                                    // OCR scanned PDFs if tesseract.js is installed
  web: false,                                     // web fallback is NEVER inferred
  access: { "legal/**": ["legal-team"] },         // glob → allowed groups
});
```

## Ingestion

Supported files: `.pdf` (with page numbers), `.md` (heading-aware splitting), `.txt`.

- **Page citations**: every chunk from a PDF carries its page; `RunResult.sources` returns
  `{ title, page, id, source }` and the context asks the model to cite `[title, p.N]`.
- **Chunking**: ~1200 chars with 150 overlap, cut at sentence boundaries; markdown splits on
  headings first.
- **Incremental re-index**: files are hashed (SHA-256); unchanged files are never re-read or
  re-embedded. The manifest lives under `.noble/rag/`. Force a full pass with
  [`bot.reindex()`](/reference/execution#reindex) or `noble reindex`.
- **OCR**: when a PDF has no extractable text and `ocr` isn't `false`, the optional
  `tesseract.js` dependency is tried; absent, you get a one-time warning naming the file.

## Access control

Enforced **in code at query time**, before the model sees anything:

- Folder convention: anything under `internal/` → `["staff"]`.
- Explicit map wins: `access: { "internal/hr.md": ["hr"], "legal/**": ["legal-team"] }`.
- A chunk with no groups is public. A user matches when `user.groups` intersects the chunk's
  groups. Set `groups` server-side from your auth system.

```ts
await bot.ask(q, { user: { id: "cust-1" } });                   // internal chunks invisible
await bot.ask(q, { user: { id: "emp-7", groups: ["staff"] } }); // visible
```

## Strategies

| `rag:` | What happens | Extra model calls |
|---|---|---|
| `naive` | vector search only | none |
| `hybrid` *(default)* | vector + keyword, reciprocal-rank fusion | none |
| `self` | retrieve → grade → rewrite weak queries → critique | 2–4 |
| `crag` | retrieve → grade → web fallback *(only if `web: true`)* | 1–2 |
| `adaptive` | should-retrieve gate, skips RAG for small talk | 1 |
| `agentic` | exposes a `search_docs` **tool** — the model retrieves on demand | model-driven |
| `hyde` | embeds a hypothetical answer instead of the query | 1 |
| `fusion` | multi-query expansion + RRF merge | 1 |
| `graph` | **throws** until you build the offline graph index — the error states the build cost | — |

Costs and when-to-use guidance: [Strategies & costs](/strategies).

## Web fallback

Off by default and never inferred (design principle 4). Enabling it needs both the flag and a
provider — there is no built-in web search:

```ts
bot.docs("./kb", {
  rag: "crag",
  web: true,
  webSearch: async (q) => mysearch(q), // → [{ title, url, text }]
});
```

Web results are marked `source: "web"` in `RunResult.sources` so your UI can badge them.

## Embeddings

- `OPENAI_API_KEY` present → OpenAI `text-embedding-3-small`.
- Otherwise a deterministic **local hash embedder** (fine for small corpora and tests, weak
  recall in production — a one-time startup warning says so).
- Bring your own: `.docs(path, { embedder: myEmbedder })` where
  `embedder = { name, dims, embed(texts): Promise<number[][]> }`.

## Bring your own store

`.docs()` also accepts a prebuilt `VectorIndex` instead of a path:

```ts
import { VectorIndex, ingestDir, LocalEmbedder } from "noble-agent";
const { chunks } = await ingestDir("./kb", new LocalEmbedder());
const index = new VectorIndex();
index.add(chunks);
bot.docs(index);
```
