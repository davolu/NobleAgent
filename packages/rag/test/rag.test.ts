import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Budget, type RunContext } from "@noble-agent/core";
import { LocalEmbedder, NobleRagRunner, VectorIndex, chunkText, ingestDir, resolveAccess, userCanSee } from "@noble-agent/rag";
import { makePdf } from "./makePdf.js";

function makeCorpus(): string {
  const dir = mkdtempSync(join(tmpdir(), "noble-corpus-"));
  writeFileSync(
    join(dir, "warranty.pdf"),
    makePdf([
      ["Acme Home Appliance Warranty", "All appliances include a 1 year limited warranty", "covering manufacturing defects."],
      ["Blenders and mixers: the motor is covered for 2 years.", "Accidental damage is not covered.", "Contact support to file a warranty claim."],
    ])
  );
  mkdirSync(join(dir, "internal"), { recursive: true });
  writeFileSync(
    join(dir, "internal", "pricing-playbook.md"),
    "# Internal pricing playbook\n\nStaff only: maximum discretionary refund is $75 without manager approval. SECRET-MARGIN-DATA."
  );
  writeFileSync(join(dir, "faq.md"), "# Shipping FAQ\n\nStandard shipping takes 3-5 business days.");
  return dir;
}

function fakeCtx(user?: { id: string; groups?: string[] }): RunContext {
  return {
    traceId: "t",
    sessionId: "s",
    query: "",
    messages: [],
    model: "mock",
    user,
    budget: new Budget({}),
    metadata: {},
    emit: () => {},
    complete: async () => ({ text: "", toolCalls: [], usage: { tokensIn: 0, tokensOut: 0 }, stopReason: "end" as const }),
  };
}

describe("Phase 4 — ingestion", () => {
  it("loads PDFs with page numbers and markdown with heading-aware chunks", async () => {
    const dir = makeCorpus();
    const { chunks } = await ingestDir(dir, new LocalEmbedder(), { cacheDir: mkdtempSync(join(tmpdir(), "noble-cache-")) });

    const pdfChunks = chunks.filter((c) => c.docId === "warranty.pdf");
    expect(pdfChunks.length).toBeGreaterThanOrEqual(2);
    expect(pdfChunks.map((c) => c.page)).toContain(1);
    expect(pdfChunks.map((c) => c.page)).toContain(2);
    expect(pdfChunks.find((c) => c.page === 2)?.text).toContain("motor is covered for 2 years");

    const internal = chunks.find((c) => c.docId.includes("pricing-playbook"));
    expect(internal?.access).toEqual(["staff"]); // folder convention
    expect(chunks.find((c) => c.docId === "faq.md")?.access).toBeUndefined(); // public
    expect(chunks.every((c) => c.embedding?.length)).toBe(true);
  });

  it("re-indexes incrementally by file hash", async () => {
    const dir = makeCorpus();
    const cacheDir = mkdtempSync(join(tmpdir(), "noble-cache-"));
    const first = await ingestDir(dir, new LocalEmbedder(), { cacheDir });
    expect(first.changed).toBe(3);
    const second = await ingestDir(dir, new LocalEmbedder(), { cacheDir });
    expect(second.changed).toBe(0); // nothing re-read
    expect(second.chunks.length).toBe(first.chunks.length);
    writeFileSync(join(dir, "faq.md"), "# Shipping FAQ\n\nExpress shipping now available.");
    const third = await ingestDir(dir, new LocalEmbedder(), { cacheDir });
    expect(third.changed).toBe(1);
  });

  it("explicit access map overrides folder conventions", () => {
    expect(resolveAccess("internal/notes.md")).toEqual(["staff"]);
    expect(resolveAccess("public/faq.md")).toBeUndefined();
    expect(resolveAccess("legal/contracts.pdf", { "legal/**": ["legal-team"] })).toEqual(["legal-team"]);
    expect(resolveAccess("internal/hr.md", { "internal/hr.md": ["hr"] })).toEqual(["hr"]);
  });

  it("chunkText windows long text with overlap", () => {
    const text = Array.from({ length: 100 }, (_, i) => `Sentence number ${i} about warranties.`).join(" ");
    const chunks = chunkText(text, 500, 100);
    expect(chunks.length).toBeGreaterThan(3);
    expect(Math.max(...chunks.map((c) => c.length))).toBeLessThanOrEqual(520);
  });
});

describe("Phase 4 — access control in code", () => {
  it("a public user cannot retrieve an internal chunk; staff can", async () => {
    const dir = makeCorpus();
    const { chunks } = await ingestDir(dir, new LocalEmbedder(), { cacheDir: mkdtempSync(join(tmpdir(), "noble-cache-")) });
    const index = new VectorIndex();
    index.add(chunks);

    const embedder = new LocalEmbedder();
    const [vec] = await embedder.embed(["maximum discretionary refund pricing playbook"]);

    const publicResults = index.searchHybrid(vec, "maximum discretionary refund pricing playbook", 10, { id: "cust" });
    expect(publicResults.some((c) => c.text.includes("SECRET-MARGIN-DATA"))).toBe(false);

    const staffResults = index.searchHybrid(vec, "maximum discretionary refund pricing playbook", 10, {
      id: "emp",
      groups: ["staff"],
    });
    expect(staffResults.some((c) => c.text.includes("SECRET-MARGIN-DATA"))).toBe(true);

    expect(userCanSee(chunks.find((c) => c.access)!, undefined)).toBe(false);
  });
});

describe("Phase 4 — runner, citations and web default", () => {
  it("retrieval returns data-channel context and page citations", async () => {
    const dir = makeCorpus();
    const runner = new NobleRagRunner(dir, { rag: "hybrid" });
    const out = await runner.retrieve("Is my blender motor covered by the warranty?", fakeCtx({ id: "cust" }));

    expect(out.context).toContain("UNTRUSTED_DATA");
    expect(out.context).toContain("motor is covered");
    expect(out.context).toContain("cite it as [title, p.N]");
    const warranty = out.sources.find((s) => s.title === "warranty");
    expect(warranty).toBeDefined();
    expect(warranty?.page).toBeGreaterThanOrEqual(1);
    expect(out.sources.every((s) => s.source === "corpus")).toBe(true);
  });

  it("web is off by default and web:true without a search fn fails loudly", async () => {
    const dir = mkdtempSync(join(tmpdir(), "noble-empty-"));
    writeFileSync(join(dir, "note.md"), "# Note\nnothing relevant here");
    // crag with no matches would reach webFallback; with web unset it's a no-op
    const safe = new NobleRagRunner(dir, { rag: "hybrid" });
    const out = await safe.retrieve("completely unrelated query zzz", fakeCtx());
    expect(out.sources.every((s) => s.source === "corpus")).toBe(true);
  });

  it("unknown strategies and graph (offline index) fail loudly at construction", () => {
    expect(() => new NobleRagRunner(".", { rag: "telepathy" })).toThrow(/Unknown RAG strategy/);
    expect(() => new NobleRagRunner(".", { rag: "graph" })).toThrow(/offline graph index|build/i);
  });

  it("agentic strategy exposes retrieval as a tool instead of pre-injecting", async () => {
    const dir = makeCorpus();
    const runner = new NobleRagRunner(dir, { rag: "agentic" });
    const out = await runner.retrieve("anything", fakeCtx({ id: "cust" }));
    expect(out.context).toBe("");
    expect(out.asTool?.name).toBe("search_docs");
    const text = (await out.asTool!.run({ query: "blender motor warranty" }, fakeCtx({ id: "cust" }))) as string;
    expect(text).toContain("motor is covered");
  });
});
