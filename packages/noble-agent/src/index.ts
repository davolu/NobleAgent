import {
  NobleAgent,
  registerMcpServe,
  registerMemoryFactory,
  registerProviderFactory,
  registerRagFactory,
  registerStrategyFactory,
} from "@noble-agent/core";
import { createAdapter, defaultModelFromEnv } from "@noble-agent/providers";
import { HistoryMemory, SqliteMemory } from "@noble-agent/memory";
import { createRagRunner } from "@noble-agent/rag";
import { strategyFactory } from "@noble-agent/strategies";
import { serveMcp } from "@noble-agent/mcp";
import { preset, definePreset, sugar, type PresetConfig } from "@noble-agent/presets";
import { workflow, Workflow } from "@noble-agent/workflow";

// Wire the registry once on import: core stays dependency-free, the umbrella
// provides providers, RAG, memory conventions, strategies and the MCP server.
registerProviderFactory(createAdapter, defaultModelFromEnv);
registerRagFactory((pathOrStore, opts) => createRagRunner(pathOrStore, opts));
registerStrategyFactory(strategyFactory);
registerMcpServe((agent, opts) => serveMcp(agent as NobleAgent, opts));
registerMemoryFactory((name) => {
  if (name !== "default") return undefined;
  // Convention: durable sqlite; in-process history if better-sqlite3 is unusable.
  try {
    return new SqliteMemory();
  } catch {
    return new HistoryMemory();
  }
});

/** The public entry point: `noble.preset(...)`, sugar methods and workflow(). */
export const noble = {
  preset,
  definePreset,
  support: sugar.support,
  docs: sugar.docs,
  sales: sugar.sales,
  research: sugar.research,
  agent: sugar.agent,
  workflow,
};

export type { PresetConfig };
export { NobleAgent, Workflow };

// Re-export the toolkit so one import serves most apps.
export * from "@noble-agent/core";
export {
  AnthropicAdapter,
  OpenAIAdapter,
  MockModelAdapter,
  MODELS,
  DEFAULTS,
  priceFor,
  providerFor,
  defaultModelFromEnv,
  cheapModelFor,
  createAdapter,
} from "@noble-agent/providers";
export { HistoryMemory, SqliteMemory, PostgresMemory, PineconeMemory, composeMemory } from "@noble-agent/memory";
export {
  LocalEmbedder,
  OpenAIEmbedder,
  VectorIndex,
  ingestDir,
  createRagRunner,
  pipe,
  branch,
  STRATEGY_COST,
} from "@noble-agent/rag";
export * from "@noble-agent/strategies";
export { confidenceRouter, cheapModelDecider, jevDecider } from "@noble-agent/decide";
export { fileSink, otelSink, langfuseSink, langsmithSink } from "@noble-agent/observe";
export { generatePromptfooConfig, pickModel, tunePrompt, acceptTune } from "@noble-agent/eval";
export { mcpTools, serveMcp } from "@noble-agent/mcp";
export { escalateTool, preset, definePreset } from "@noble-agent/presets";
export { workflow } from "@noble-agent/workflow";

export default noble;
