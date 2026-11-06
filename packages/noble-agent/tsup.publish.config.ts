import { defineConfig } from "tsup";

/**
 * Publish build: bundles every @noble-agent/* workspace package (and the CLI)
 * into one self-contained npm package, keeping real third-party deps external.
 * Regular dev builds use the plain tsup invocation in package.json.
 */
export default defineConfig({
  entry: { index: "src/index.ts", cli: "../cli/src/index.ts" },
  format: ["esm"],
  outDir: "dist-publish",
  clean: true,
  sourcemap: false,
  dts: { entry: { index: "src/index.ts" }, resolve: [/^@noble-agent\//] },
  noExternal: [/^@noble-agent\//, /^noble-agent$/],
  external: [
    "zod",
    "zod-to-json-schema",
    "better-sqlite3",
    "@anthropic-ai/sdk",
    "openai",
    "pdfjs-dist",
    "pdfjs-dist/*",
    "pg",
    "tesseract.js",
    "langfuse",
    "langsmith",
    "@opentelemetry/api",
  ],
});
