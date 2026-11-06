import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@noble-agent/core": r("./packages/core/src/index.ts"),
      "@noble-agent/providers": r("./packages/providers/src/index.ts"),
      "@noble-agent/memory": r("./packages/memory/src/index.ts"),
      "@noble-agent/rag": r("./packages/rag/src/index.ts"),
      "@noble-agent/strategies": r("./packages/strategies/src/index.ts"),
      "@noble-agent/decide": r("./packages/decide/src/index.ts"),
      "@noble-agent/observe": r("./packages/observe/src/index.ts"),
      "@noble-agent/eval": r("./packages/eval/src/index.ts"),
      "@noble-agent/workflow": r("./packages/workflow/src/index.ts"),
      "@noble-agent/mcp": r("./packages/mcp/src/index.ts"),
      "@noble-agent/presets": r("./packages/presets/src/index.ts"),
      "noble-agent": r("./packages/noble-agent/src/index.ts"),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts", "examples/*/test/**/*.test.ts"],
    testTimeout: 20000,
    env: { NOBLE_QUIET: "1" },
  },
});
