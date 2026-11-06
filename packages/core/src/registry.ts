import type { MemoryAdapter, ModelAdapter, RagFactory, Strategy } from "./types.js";

/**
 * Cross-package wiring without circular dependencies. The umbrella package
 * (`noble-agent`) registers providers, RAG, memory and preset factories here
 * on import; core stays dependency-free.
 */
export type PresetFn = (agent: any, cfg: Record<string, any>) => void;

export interface NobleRegistry {
  providerFactory?: (modelId: string) => ModelAdapter;
  /** Picks a default model id from the environment (provider API keys). */
  defaultModelId?: () => string | undefined;
  ragFactory?: RagFactory;
  memoryFactory?: (name: string, opts?: any) => MemoryAdapter | undefined;
  strategyFactory?: (name: string, opts?: any) => Strategy;
  mcpServe?: (agent: any, opts: { port?: number }) => Promise<{ close(): void; port: number }>;
  presets: Map<string, PresetFn>;
}

const registry: NobleRegistry = { presets: new Map() };

export function getRegistry(): NobleRegistry {
  return registry;
}

export function registerProviderFactory(fn: NobleRegistry["providerFactory"], defaultId?: NobleRegistry["defaultModelId"]): void {
  registry.providerFactory = fn;
  if (defaultId) registry.defaultModelId = defaultId;
}

export function registerRagFactory(fn: RagFactory): void {
  registry.ragFactory = fn;
}

export function registerMemoryFactory(fn: NobleRegistry["memoryFactory"]): void {
  registry.memoryFactory = fn;
}

export function registerStrategyFactory(fn: NobleRegistry["strategyFactory"]): void {
  registry.strategyFactory = fn;
}

export function registerMcpServe(fn: NobleRegistry["mcpServe"]): void {
  registry.mcpServe = fn;
}

export function registerPreset(name: string, fn: PresetFn): void {
  registry.presets.set(name, fn);
}
