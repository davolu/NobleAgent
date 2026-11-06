import { NobleAgent } from '@noble-agent/core';
export * from '@noble-agent/core';
export { NobleAgent } from '@noble-agent/core';
import { preset, definePreset, PresetConfig } from '@noble-agent/presets';
export { PresetConfig, definePreset, escalateTool, preset } from '@noble-agent/presets';
import { workflow } from '@noble-agent/workflow';
export { Workflow, workflow } from '@noble-agent/workflow';
export { AnthropicAdapter, DEFAULTS, MODELS, MockModelAdapter, OpenAIAdapter, cheapModelFor, createAdapter, defaultModelFromEnv, priceFor, providerFor } from '@noble-agent/providers';
export { HistoryMemory, PineconeMemory, PostgresMemory, SqliteMemory, composeMemory } from '@noble-agent/memory';
export { LocalEmbedder, OpenAIEmbedder, STRATEGY_COST, VectorIndex, branch, createRagRunner, ingestDir, pipe } from '@noble-agent/rag';
export * from '@noble-agent/strategies';
export { cheapModelDecider, confidenceRouter, jevDecider } from '@noble-agent/decide';
export { fileSink, langfuseSink, langsmithSink, otelSink } from '@noble-agent/observe';
export { acceptTune, generatePromptfooConfig, pickModel, tunePrompt } from '@noble-agent/eval';
export { mcpTools, serveMcp } from '@noble-agent/mcp';

/** The public entry point: `noble.preset(...)`, sugar methods and workflow(). */
declare const noble: {
    preset: typeof preset;
    definePreset: typeof definePreset;
    support: (cfg?: PresetConfig) => NobleAgent;
    docs: (cfg?: PresetConfig) => NobleAgent;
    sales: (cfg?: PresetConfig) => NobleAgent;
    research: (cfg?: PresetConfig) => NobleAgent;
    agent: (system: string) => NobleAgent;
    workflow: typeof workflow;
};

export { noble as default, noble };
