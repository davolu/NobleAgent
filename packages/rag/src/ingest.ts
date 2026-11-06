import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";
import type { Chunk, Embedder } from "./types.js";

const require = createRequire(import.meta.url);
const quiet = () => process.env.NOBLE_QUIET === "1";

export interface IngestOptions {
  ocr?: boolean | "auto";
  /** Explicit access map: glob-ish pattern (relative path) → allowed groups. */
  access?: Record<string, string[]>;
  chunkSize?: number;
  chunkOverlap?: number;
  cacheDir?: string;
}

interface Manifest {
  files: Record<string, { hash: string }>;
  embedder: string;
  chunks: Chunk[];
}

const SUPPORTED = new Set([".pdf", ".md", ".txt"]);

/**
 * Loads a folder of documents into chunks with page numbers, heading-aware
 * splitting and incremental re-indexing by file hash. Folder conventions
 * (anything under internal/ → staff) plus the explicit access map decide who
 * can retrieve each chunk.
 */
export async function ingestDir(
  dir: string,
  embedder: Embedder,
  opts: IngestOptions = {}
): Promise<{ chunks: Chunk[]; changed: number; total: number }> {
  if (!existsSync(dir)) throw new Error(`.docs(): path "${dir}" does not exist.`);
  const cacheDir = opts.cacheDir ?? join(process.cwd(), ".noble", "rag");
  mkdirSync(cacheDir, { recursive: true });
  const manifestPath = join(cacheDir, `${createHash("sha1").update(dir).digest("hex").slice(0, 12)}.json`);

  let manifest: Manifest = { files: {}, embedder: embedder.name, chunks: [] };
  if (existsSync(manifestPath)) {
    try {
      const prev = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
      if (prev.embedder === embedder.name) manifest = prev;
    } catch {}
  }

  const files = walk(dir).filter((f) => SUPPORTED.has(extname(f).toLowerCase()));
  const nextFiles: Manifest["files"] = {};
  const keptChunks: Chunk[] = [];
  const toProcess: string[] = [];

  for (const file of files) {
    const rel = relative(dir, file);
    const hash = createHash("sha256").update(readFileSync(file)).digest("hex");
    nextFiles[rel] = { hash };
    if (manifest.files[rel]?.hash === hash) {
      keptChunks.push(...manifest.chunks.filter((c) => c.docId === rel));
    } else {
      toProcess.push(file);
    }
  }

  const newChunks: Chunk[] = [];
  for (const file of toProcess) {
    const rel = relative(dir, file);
    const access = resolveAccess(rel, opts.access);
    const pages = await loadFile(file, opts);
    const title = basename(file, extname(file));
    for (const { page, text } of pages) {
      for (const [i, piece] of chunkText(text, opts.chunkSize ?? 1200, opts.chunkOverlap ?? 150).entries()) {
        newChunks.push({
          id: `${rel}#${page ?? 0}.${i}`,
          docId: rel,
          title,
          page,
          text: piece,
          access,
          source: "corpus",
        });
      }
    }
  }

  if (newChunks.length) {
    const vectors = await embedder.embed(newChunks.map((c) => c.text));
    newChunks.forEach((c, i) => (c.embedding = vectors[i]));
  }

  // Drop chunks of deleted files.
  const liveDocs = new Set(Object.keys(nextFiles));
  const chunks = [...keptChunks.filter((c) => liveDocs.has(c.docId)), ...newChunks];
  writeFileSync(manifestPath, JSON.stringify({ files: nextFiles, embedder: embedder.name, chunks }));
  return { chunks, changed: toProcess.length, total: files.length };
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

/** Folder conventions (internal/ → staff) merged with the explicit access map. */
export function resolveAccess(relPath: string, map?: Record<string, string[]>): string[] | undefined {
  const norm = relPath.split("\\").join("/");
  let access: string[] | undefined;
  if (/(^|\/)internal\//.test(norm) || norm.startsWith("internal/")) access = ["staff"];
  for (const [pattern, groups] of Object.entries(map ?? {})) {
    if (globMatch(pattern, norm)) access = groups;
  }
  return access;
}

function globMatch(pattern: string, path: string): boolean {
  const norm = pattern.split("\\").join("/");
  let re = "";
  for (let i = 0; i < norm.length; i++) {
    const ch = norm[i];
    if (ch === "*") {
      if (norm[i + 1] === "*") {
        re += ".*";
        i++;
      } else {
        re += "[^/]*";
      }
    } else if (/[a-zA-Z0-9_\-/]/.test(ch)) {
      re += ch;
    } else {
      re += "\\" + ch;
    }
  }
  return new RegExp(`^${re}$`).test(path);
}

async function loadFile(file: string, opts: IngestOptions): Promise<{ page?: number; text: string }[]> {
  const ext = extname(file).toLowerCase();
  if (ext === ".pdf") return loadPdf(file, opts);
  const text = readFileSync(file, "utf8");
  if (ext === ".md") return splitByHeadings(text).map((t) => ({ text: t }));
  return [{ text }];
}

async function loadPdf(file: string, opts: IngestOptions): Promise<{ page?: number; text: string }[]> {
  // pdf-parse is CJS; the lib entry avoids its index.js self-test.
  const pdfParse = require("pdf-parse/lib/pdf-parse.js") as (
    buf: Buffer,
    opts?: Record<string, unknown>
  ) => Promise<{ text: string }>;
  const pages: string[] = [];
  await pdfParse(readFileSync(file), {
    pagerender: async (pageData: any) => {
      const tc = await pageData.getTextContent();
      const text = tc.items.map((it: any) => it.str).join(" ");
      pages.push(text);
      return text;
    },
  });
  const totalText = pages.join("").trim();
  if (totalText.length < 20 && opts.ocr !== false) {
    const ocrText = await tryOcr(file);
    if (ocrText) return [{ page: 1, text: ocrText }];
    if (!quiet())
      console.warn(`[noble] "${basename(file)}" has no extractable text (scanned?). Install tesseract.js for OCR.`);
  }
  return pages.map((text, i) => ({ page: i + 1, text }));
}

async function tryOcr(file: string): Promise<string | undefined> {
  try {
    const t: any = await import("tesseract.js");
    const createWorker = t.createWorker ?? t.default?.createWorker;
    if (!createWorker) return undefined;
    const worker = await createWorker("eng");
    const { data } = await worker.recognize(file);
    await worker.terminate();
    return data.text as string;
  } catch {
    return undefined;
  }
}

/** Heading-aware splitting for markdown; falls back to the whole text. */
export function splitByHeadings(text: string): string[] {
  const parts = text.split(/^(?=#{1,4}\s)/m).filter((p) => p.trim().length > 0);
  return parts.length ? parts : [text];
}

export function chunkText(text: string, size: number, overlap: number): string[] {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return [];
  if (clean.length <= size) return [clean];
  const chunks: string[] = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(start + size, clean.length);
    if (end < clean.length) {
      const lastBreak = clean.lastIndexOf(". ", end);
      if (lastBreak > start + size / 2) end = lastBreak + 1;
    }
    chunks.push(clean.slice(start, end).trim());
    if (end >= clean.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks;
}
