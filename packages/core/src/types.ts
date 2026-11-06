import type { ZodSchema } from "zod";

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  name: string;
  args: unknown;
}

export interface Message {
  role: Role;
  content: string;
  /** Set on `tool` messages: which call this result answers. */
  toolCallId?: string;
  /** Set on `assistant` messages that requested tool calls. */
  toolCalls?: ToolCall[];
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export interface ToolDef<A = any> {
  name: string;
  description: string;
  params: ZodSchema<A>;
  run: (args: A, ctx: RunContext) => Promise<unknown>;
  /**
   * Explicitly mark a tool as having side effects (or not). When undefined,
   * the side effect is inferred from the name (create*, delete*, refund*,
   * send*, ...) and inferred side-effect tools always require approval.
   */
  sideEffect?: boolean;
  /** Raw JSON schema override (used by MCP tools where no zod schema exists). */
  jsonSchema?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Model adapters
// ---------------------------------------------------------------------------

export interface ModelToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ModelRequest {
  model?: string;
  system?: string;
  messages: Message[];
  tools?: ModelToolSpec[];
  maxTokens?: number;
  temperature?: number;
}

export interface ModelUsage {
  tokensIn: number;
  tokensOut: number;
}

export interface ModelResponse {
  text: string;
  toolCalls: ToolCall[];
  usage: ModelUsage;
  stopReason: "end" | "tool_use" | "max_tokens" | "other";
}

export type ModelChunk =
  | { type: "token"; text: string }
  | { type: "toolCalls"; toolCalls: ToolCall[] }
  | { type: "usage"; usage: ModelUsage };

export interface ModelAdapter {
  id: string;
  /** Handles tool calls: returns either final text or requested tool calls. */
  complete(req: ModelRequest): Promise<ModelResponse>;
  stream(req: ModelRequest): AsyncIterable<ModelChunk>;
  /** USD per million tokens. Used for budget accounting. */
  price: { inPerMTok: number; outPerMTok: number };
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

export interface MemoryAdapter {
  name: string;
  load(sessionId: string, query?: string): Promise<Message[]>;
  save(sessionId: string, turn: Message[]): Promise<void>;
}

// ---------------------------------------------------------------------------
// Strategies (prompting / reasoning)
// ---------------------------------------------------------------------------

export interface Strategy {
  name: string;
  transformPrompt?(messages: Message[], ctx: RunContext): Message[];
  wrapRun?(ctx: RunContext, next: (c: RunContext) => Promise<RunResult>): Promise<RunResult>;
  /** Honest cost declaration: roughly how many base-runs this strategy costs. */
  costMultiplier?: number;
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

export interface Decision {
  choice: string;
  p: number;
  probs: Record<string, number>;
}

export interface PolicyOpts {
  /** Confidence below which the policy escalates to the stronger option. */
  threshold?: number;
  cheap?: string;
  strong?: string;
  [key: string]: unknown;
}

export interface DecisionPolicy {
  name: string;
  /** Returns the model id to use for this query (or null to keep current). */
  route(ctx: RunContext): Promise<{ model: string | null; decision: Decision }>;
}

export type GateVerdict = "safe" | "review" | "block";

export interface ToolCallGate {
  name: string;
  check(call: { tool: string; args: unknown }, ctx: RunContext): Promise<GateVerdict>;
}

export interface Decider {
  name: string;
  choose(state: unknown, question: string, options: string[]): Promise<Decision>;
  filter(query: string, items: string[]): Promise<number[]>;
  policy(opts: PolicyOpts): DecisionPolicy;
  toolGate(): ToolCallGate;
  experimental?: boolean;
}

// ---------------------------------------------------------------------------
// Events (neutral schema — public, documented contract)
// ---------------------------------------------------------------------------

export type NobleEventType =
  | "run.start"
  | "model.call"
  | "tool.call"
  | "memory.read"
  | "memory.write"
  | "rag.step"
  | "decision"
  | "approval.pending"
  | "escalation"
  | "run.end";

export interface NobleEvent {
  type: NobleEventType;
  traceId: string;
  ts: number;
  data: Record<string, unknown>;
}

export interface Sink {
  name: string;
  emit(e: NobleEvent): void | Promise<void>;
}

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

export interface BudgetLimits {
  usd?: number;
  steps?: number;
  tokens?: number;
  onExhausted?: "escalate" | "stop";
}

export interface BudgetState {
  usd: number;
  tokensIn: number;
  tokensOut: number;
  steps: number;
  limits: BudgetLimits;
  exceeded(): boolean;
  /** Human explanation of which limit tripped (empty when not exceeded). */
  reason(): string;
}

// ---------------------------------------------------------------------------
// Run context / result
// ---------------------------------------------------------------------------

export interface NobleUser {
  id: string;
  groups?: string[];
  [key: string]: unknown;
}

export interface RunContext {
  traceId: string;
  sessionId: string;
  query: string;
  messages: Message[];
  model: string;
  user?: NobleUser;
  budget: BudgetState;
  metadata: Record<string, unknown>;
  emit(e: NobleEvent): void;
  /** Low-level completion against the resolved adapter (used by strategies/steps). */
  complete(req: Omit<ModelRequest, "model"> & { model?: string }): Promise<ModelResponse>;
}

export interface SourceRef {
  title: string;
  page?: number;
  id: string;
  source: "corpus" | "web";
}

export interface ToolCallRecord {
  tool: string;
  args: unknown;
  result?: unknown;
  error?: string;
}

export type RunOutcome = "resolved" | "escalated" | "pending" | "error";

export interface RunResult {
  message: string;
  outcome: RunOutcome;
  sources: SourceRef[];
  toolCalls: ToolCallRecord[];
  traceId: string;
  runId: string;
  cost: { usd: number; tokensIn: number; tokensOut: number };
}

export type StreamEvent =
  | { type: "token"; text: string }
  | { type: "tool"; tool: string; args: unknown }
  | { type: "source"; source: SourceRef }
  | { type: "done"; result: RunResult };

// ---------------------------------------------------------------------------
// RAG runner (implemented by @noble-agent/rag; core only knows the interface)
// ---------------------------------------------------------------------------

export interface RagRetrieval {
  /** Context block to inject (already wrapped in the data channel). */
  context: string;
  sources: SourceRef[];
  /** When set, retrieval is exposed as a tool instead of pre-injected (agentic RAG). */
  asTool?: ToolDef;
}

export interface RagRunner {
  ready(): Promise<void>;
  retrieve(query: string, ctx: RunContext): Promise<RagRetrieval>;
  reindex(): Promise<void>;
}

export interface DocsOptions {
  rag?: string;
  store?: unknown;
  ocr?: boolean | "auto";
  cite?: boolean;
  web?: boolean;
  access?: Record<string, string[]>;
  embedder?: unknown;
  /** Chunks injected per query (default 6). */
  topK?: number;
  /** Required when web: true — there is no default web search provider. */
  webSearch?: (query: string) => Promise<{ title: string; url: string; text: string }[]>;
}

export type RagFactory = (pathOrStore: string | unknown, opts: DocsOptions, agentCfg: ResolvedConfig) => RagRunner;

// ---------------------------------------------------------------------------
// Config resolution / explain
// ---------------------------------------------------------------------------

export type ConfigSource = "preset" | "env" | "convention" | "user";

export interface ConfigEntry {
  value: unknown;
  source: ConfigSource;
}

export type ResolvedConfig = Record<string, ConfigEntry>;

export interface GuardOptions {
  /** Screen user input for prompt-injection / policy patterns before the run. */
  input?: boolean;
  /** Wrap retrieved docs and tool outputs in an untrusted data channel. Default true. */
  dataChannel?: boolean;
  /** Optional tool-call gate (Jev or cheap model). */
  toolGate?: ToolCallGate;
}

export interface ApproveOptions {
  tools?: string[];
  via?: (info: { runId: string; tool: string; args: unknown }) => void | Promise<void>;
  timeoutMs?: number;
}

export interface AskOptions {
  user?: NobleUser;
  sessionId?: string;
  metadata?: Record<string, unknown>;
  signal?: AbortSignal;
}
