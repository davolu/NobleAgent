// Stages and publishes the self-contained `noble-agent` package.
//
//   pnpm build
//   pnpm --filter noble-agent exec tsup --config tsup.publish.config.ts
//   node scripts/release-npm.mjs [--publish]
//
// Without --publish it stages + packs only (dry run). The published package
// bundles every @noble-agent/* workspace package; third-party deps stay real.
import { execSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const staging = join(root, ".noble", "npm-staging");
const version = JSON.parse(readFileSync(join(root, "packages/noble-agent/package.json"), "utf8")).version;

rmSync(staging, { recursive: true, force: true });
mkdirSync(join(staging, "dist", "types"), { recursive: true });

// bundled JS from the publish build
const publishDist = join(root, "packages/noble-agent/dist-publish");
for (const f of readdirSync(publishDist)) {
  if (f.endsWith(".js")) copyFileSync(join(publishDist, f), join(staging, "dist", f));
}

// per-package type declarations with workspace specifiers rewritten to relative paths
const pkgs = ["core", "providers", "memory", "rag", "strategies", "decide", "observe", "eval", "workflow", "mcp", "presets"];
for (const p of pkgs) {
  const dts = readFileSync(join(root, `packages/${p}/dist/index.d.ts`), "utf8").replace(/@noble-agent\/([a-z-]+)/g, "./$1.js");
  writeFileSync(join(staging, "dist", "types", `${p}.d.ts`), dts);
}
const indexDts = readFileSync(join(publishDist, "index.d.ts"), "utf8").replace(/@noble-agent\/([a-z-]+)/g, "./types/$1.js");
writeFileSync(join(staging, "dist", "index.d.ts"), indexDts);

const manifest = {
  name: "noble-agent",
  version,
  description:
    "Customer-safe chat agents in a few chained lines — cited RAG, durable memory, hard budgets, human-in-the-loop approvals built in.",
  keywords: ["ai", "agents", "llm", "chatbot", "rag", "anthropic", "claude", "openai", "typescript", "mcp", "customer-support"],
  license: "MIT",
  author: "David Oluyalegbenga (davolu)",
  homepage: "https://davolu.github.io/NobleAgent/",
  repository: { type: "git", url: "git+https://github.com/davolu/NobleAgent.git" },
  bugs: { url: "https://github.com/davolu/NobleAgent/issues" },
  type: "module",
  engines: { node: ">=20" },
  main: "./dist/index.js",
  types: "./dist/index.d.ts",
  exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } },
  bin: { noble: "./dist/cli.js" },
  files: ["dist"],
  dependencies: {
    zod: "^3.23.8",
    "zod-to-json-schema": "^3.23.5",
    "better-sqlite3": "^11.5.0",
    "@anthropic-ai/sdk": "^0.39.0",
    openai: "^4.77.0",
    "pdfjs-dist": "^4.10.38",
  },
  peerDependencies: { pg: ">=8", "tesseract.js": ">=5", langfuse: ">=3", langsmith: ">=0.1", "@opentelemetry/api": ">=1.8" },
  peerDependenciesMeta: {
    pg: { optional: true },
    "tesseract.js": { optional: true },
    langfuse: { optional: true },
    langsmith: { optional: true },
    "@opentelemetry/api": { optional: true },
  },
};
writeFileSync(join(staging, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
copyFileSync(join(root, "README.md"), join(staging, "README.md"));
copyFileSync(join(root, "LICENSE"), join(staging, "LICENSE"));

const publish = process.argv.includes("--publish");
execSync(publish ? "npm publish --access public" : "npm pack", { cwd: staging, stdio: "inherit" });
console.log(publish ? `published noble-agent@${version}` : `staged + packed noble-agent@${version} in ${staging}`);
