import { randomUUID } from "node:crypto";
import { z } from "zod";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Budget, parseBudget } from "./budget.js";
import { EventBus, consoleSink, makeEvent, type Redactor } from "./events.js";
import { renderExplain } from "./explain.js";
import {
  DATA_CHANNEL_SYSTEM_NOTE,
  resolveGuard,
  screenInput,
  wrapDataChannel,
} from "./guard.js";
import { getRegistry } from "./registry.js";
import { FileRunStore, InMemoryRunStore, type PendingRunState, type RunStore } from "./runstore.js";
import { normalizeTools, requiresApproval, toModelToolSpec, validateToolArgs } from "./tools.js";
import type {
  ApproveOptions,
  AskOptions,
  BudgetLimits,
  ConfigEntry,
  ConfigSource,
  Decider,
  DecisionPolicy,
  DocsOptions,
  GuardOptions,
  MemoryAdapter,
  Message,
  ModelAdapter,
  ModelRequest,
  ModelResponse,
  NobleEvent,
  RagRunner,
  RunContext,
  RunResult,
  Sink,
  SourceRef,
  StreamEvent,
  Strategy,
  ToolCall,
  ToolCallRecord,
  ToolDef,
} from "./types.js";

const quiet = () => process.env.NOBLE_QUIET === "1";

export interface ModelOptions {
  fallback?: string;
  candidates?: string[];
  optimiseFor?: "quality" | "cost" | "latency" | Record<string, number>;
  minQuality?: number;
  per?: "route";
  temperature?: number;
  maxTokens?: number;
}

export interface ToolsOptions {
  maxSteps?: number;
}

export interface OptimiseCostOptions {
  cache?: boolean | { ttlMs?: number };
  trimHistory?: number;
  routeEasy?: boolean;
}

export interface ObserveOptions {
  sinks?: Sink[];
  redact?: (string | RegExp)[];
}

interface LoopSeed {
  records: ToolCallRecord[];
  sources: SourceRef[];
  injectedToolResults?: Message[];
}

function isModelAdapter(v: unknown): v is ModelAdapter {
  return !!v && typeof v === "object" && typeof (v as ModelAdapter).complete === "function";
}

export class NobleAgent {
  private cfg = new Map<string, ConfigEntry>();
  private sourceStack: ConfigSource[] = ["user"];
  private bus = new EventBus([consoleSink]);
  private adapter?: ModelAdapter;
  private ragRunner?: RagRunner;
  private memoryAdapters: MemoryAdapter[] = [];
  private runStore: RunStore = new InMemoryRunStore();
  private readyPromise?: Promise<this>;
  private warnings: string[] = [];
  private warned = false;
  private responseCache = new Map<string, { at: number; result: RunResult }>();
  private schedules: { stop(): void }[] = [];

  // --- config plumbing ---------------------------------------------------

  /** Run `fn` with config writes attributed to `source` (used by presets/env). */
  _withSource(source: ConfigSource, fn: () => void): this {
    this.sourceStack.push(source);
    try {
      fn();
    } finally {
      this.sourceStack.pop();
    }
    return this;
  }

  private set(key: string, value: unknown): this {
    this.cfg.set(key, { value, source: this.sourceStack[this.sourceStack.length - 1] });
    return this;
  }

  private val<T>(key: string, fallback?: T): T {
    const e = this.cfg.get(key);
    return (e ? (e.value as T) : (fallback as T));
  }

  private setDefault(key: string, value: unknown, source: ConfigSource = "convention"): void {
    if (!this.cfg.has(key)) this.cfg.set(key, { value, source });
  }

  getConfig(): Map<string, ConfigEntry> {
    return new Map(this.cfg);
  }

  // --- fluent API (config only; never touches the network) ----------------

  system(prompt: string): this {
    return this.set("system", prompt);
  }

  goal(goal: string): this {
    return this.set("goal", goal);
  }

  model(id: string | ModelAdapter, opts: ModelOptions = {}): this {
    this.set("model", id);
    if (Object.keys(opts).length) this.set("modelOpts", opts);
    return this;
  }

  docs(pathOrStore: string | unknown, opts: DocsOptions = {}): this {
    return this.set("docs", { pathOrStore, opts });
  }

  promptEng(strategies: Strategy[]): this {
    return this.set("promptEng", strategies);
  }

  promptTune(opts: Record<string, unknown>): this {
    return this.set("promptTune", opts);
  }

  tools(fnsOrDefs: Parameters<typeof normalizeTools>[0], opts: ToolsOptions = {}): this {
    const existing = this.val<ToolDef[]>("tools", []);
    this.set("tools", [...existing, ...normalizeTools(fnsOrDefs)]);
    if (opts.maxSteps !== undefined) this.set("maxSteps", opts.maxSteps);
    return this;
  }

  mcp(client: unknown): this {
    return this.set("mcpClient", client);
  }

  memory(adapters: MemoryAdapter[]): this {
    return this.set("memory", adapters);
  }

  reflect(opts: Record<string, unknown> = {}): this {
    return this.set("reflect", opts);
  }

  debate(opts: Record<string, unknown> | false): this {
    return this.set("debate", opts);
  }

  decide(decider: Decider | DecisionPolicy): this {
    return this.set("decide", decider);
  }

  budget(input: string | BudgetLimits): this {
    return this.set("budget", parseBudget(input));
  }

  optimiseCost(opts: OptimiseCostOptions = {}): this {
    return this.set("optimiseCost", { cache: true, ...opts });
  }

  guard(opts: GuardOptions = {}): this {
    return this.set("guard", opts);
  }

  approve(opts: ApproveOptions = {}): this {
    return this.set("approve", opts);
  }

  onEscalate(fn: (info: { reason: string; query: string; sessionId: string; traceId: string }) => void | Promise<void>): this {
    return this.set("onEscalate", fn);
  }

  onError(fn: (err: unknown, info: { traceId: string }) => void | Promise<void>): this {
    return this.set("onError", fn);
  }

  durable(opts: { checkpoint?: string } = {}): this {
    return this.set("durable", opts);
  }

  schedule(cron: string, fn: () => void | Promise<void>): this {
    const entries = this.val<{ cron: string; fn: () => void | Promise<void> }[]>("schedules", []);
    return this.set("schedules", [...entries, { cron, fn }]);
  }

  observe(opts: ObserveOptions): this {
    return this.set("observe", opts);
  }

  evaluate(opts: Record<string, unknown>): this {
    return this.set("evaluate", opts);
  }

  // --- readiness ----------------------------------------------------------

  async ready(): Promise<this> {
    this.readyPromise ??= this.init();
    return this.readyPromise;
  }

  private async init(): Promise<this> {
    // Conventions (lowest precedence, applied only when unset).
    this.setDefault("maxSteps", 8);
    this.setDefault("guard", {});
    this.setDefault("model", "auto");

    // Honest strategies: expensive ones require an explicit budget.
    const strategies = this.val<Strategy[]>("promptEng", []);
    const budget = this.cfg.get("budget")?.value as BudgetLimits | undefined;
    for (const s of strategies) {
      if ((s.costMultiplier ?? 1) >= 2 && !budget) {
        throw new Error(
          `Strategy "${s.name}" costs ~${s.costMultiplier}x a plain run. Set .budget() to opt in to expensive strategies.`
        );
      }
    }

    // Reflect / debate resolved via the registered strategy factory.
    const reg = getRegistry();
    for (const key of ["reflect", "debate"] as const) {
      const opts = this.cfg.get(key)?.value;
      if (opts && opts !== false) {
        if (!reg.strategyFactory) {
          this.warnings.push(`.${key}() configured but no strategy factory registered; ignored.`);
          continue;
        }
        const s = reg.strategyFactory(key, opts as Record<string, unknown>);
        if ((s.costMultiplier ?? 1) >= 2 && !budget) {
          throw new Error(`.${key}() costs ~${s.costMultiplier}x a plain run. Set .budget() to opt in.`);
        }
        this.set("promptEng", [...this.val<Strategy[]>("promptEng", []), s]);
      }
    }

    // Model resolution.
    const modelCfg = this.val<string | ModelAdapter>("model");
    if (isModelAdapter(modelCfg)) {
      this.adapter = modelCfg;
    } else {
      if (!reg.providerFactory) {
        throw new Error(
          'No model provider registered. Import from "noble-agent" (which wires providers) or pass a ModelAdapter to .model().'
        );
      }
      this.adapter = reg.providerFactory(this.resolveModelId(modelCfg));
    }

    // Fallback model: used when the primary adapter throws on complete().
    const fallbackId = this.val<ModelOptions>("modelOpts", {})?.fallback;
    if (fallbackId && reg.providerFactory) {
      this.adapter = withFallback(this.adapter, reg.providerFactory(fallbackId));
    } else if (fallbackId) {
      this.warnings.push(`model fallback "${fallbackId}" ignored: no provider factory registered.`);
    }

    // MCP client tools.
    const mcpClient = this.cfg.get("mcpClient")?.value as
      | { listTools(): Promise<{ name: string; description?: string; inputSchema?: Record<string, unknown> }[]>; callTool(name: string, args: unknown): Promise<unknown> }
      | undefined;
    if (mcpClient) {
      const defs = await mcpClient.listTools();
      const mcpTools: ToolDef[] = defs.map((d) => ({
        name: d.name,
        description: d.description ?? `MCP tool ${d.name}`,
        params: z.record(z.any()),
        jsonSchema: d.inputSchema,
        run: async (args: unknown) => mcpClient.callTool(d.name, args),
      }));
      this.set("tools", [...this.val<ToolDef[]>("tools", []), ...mcpTools]);
    }

    // RAG.
    const docs = this.cfg.get("docs")?.value as { pathOrStore: string | unknown; opts: DocsOptions } | undefined;
    if (docs) {
      if (!reg.ragFactory) {
        throw new Error('No RAG factory registered. Import from "noble-agent" to enable .docs().');
      }
      const resolved: Record<string, ConfigEntry> = Object.fromEntries(this.cfg.entries());
      this.ragRunner = reg.ragFactory(docs.pathOrStore, docs.opts ?? {}, resolved);
      await this.ragRunner.ready();
    }

    // Memory. Convention: a durable default from the registry when unset.
    const mem = this.cfg.get("memory")?.value as MemoryAdapter[] | undefined;
    if (mem) {
      this.memoryAdapters = mem;
    } else if (reg.memoryFactory) {
      const def = reg.memoryFactory("default");
      if (def) {
        this.memoryAdapters = [def];
        this.setDefault("memoryDefault", def.name);
        this.warnings.push(`memory: using ${def.name} by convention (set .memory() to choose explicitly).`);
      }
    } else {
      this.warnings.push("memory: none configured — conversations are stateless.");
    }

    // Durability for paused runs.
    if (this.cfg.get("durable")) this.runStore = new FileRunStore(this.val<{ checkpoint?: string }>("durable")?.checkpoint);

    // Observability.
    const observe = this.cfg.get("observe")?.value as ObserveOptions | undefined;
    const sinks = observe?.sinks ?? [consoleSink];
    this.bus.setSinks(sinks);
    if (observe?.redact?.length) this.bus.setRedactor(buildRedactor(observe.redact));

    // Permissive tool schema warning.
    for (const t of this.val<ToolDef[]>("tools", [])) {
      const desc = (t.params as { _def?: { typeName?: string } })._def?.typeName;
      if (desc === "ZodRecord") this.warnings.push(`tool "${t.name}": no zod schema — args are unvalidated.`);
    }

    // Schedules.
    for (const { cron, fn } of this.val<{ cron: string; fn: () => void | Promise<void> }[]>("schedules", [])) {
      this.schedules.push(startCron(cron, fn));
    }

    if (this.warnings.length && !this.warned && !quiet()) {
      this.warned = true;
      for (const w of this.warnings) console.warn(`[noble] ${w}`);
    }
    return this;
  }

  private resolveModelId(id: string): string {
    if (id !== "auto") return id;
    // `pick-model` writes noble.lock; the runtime honours it.
    const lockPath = join(process.cwd(), "noble.lock");
    if (existsSync(lockPath)) {
      try {
        const lock = JSON.parse(readFileSync(lockPath, "utf8")) as { model?: string };
        if (lock.model) {
          this.cfg.set("model", { value: lock.model, source: "convention" });
          return lock.model;
        }
      } catch {
        this.warnings.push("noble.lock exists but could not be parsed; ignoring.");
      }
    }
    const reg = getRegistry();
    const fromEnv = reg.defaultModelId?.();
    if (!fromEnv) {
      throw new Error(
        'model "auto" could not be resolved: no noble.lock and no provider API key in the environment (ANTHROPIC_API_KEY / OPENAI_API_KEY).'
      );
    }
    this.cfg.set("model", { value: fromEnv, source: "env" });
    return fromEnv;
  }

  // --- inspection ----------------------------------------------------------

  explain(): string {
    const cfg = new Map(this.cfg);
    if (!cfg.has("maxSteps")) cfg.set("maxSteps", { value: 8, source: "convention" });
    if (!cfg.has("model")) cfg.set("model", { value: "auto", source: "convention" });
    if (!cfg.has("guard")) cfg.set("guard", { value: { dataChannel: true, input: false }, source: "convention" });
    if (!cfg.has("budget")) cfg.set("budget", { value: "(none — unbounded)", source: "convention" });
    if (!cfg.has("memory")) cfg.set("memory", { value: this.memoryAdapters.length ? this.memoryAdapters.map((m) => m.name) : "(default from env)", source: "convention" });
    const text = renderExplain(cfg, this.warnings);
    if (!quiet()) console.log(text);
    return text;
  }

  async history(opts: { user?: { id: string }; sessionId?: string }): Promise<Message[]> {
    await this.ready();
    const sessionId = opts.sessionId ?? opts.user?.id;
    if (!sessionId) throw new Error("history() needs a sessionId or user.id");
    const primary = this.memoryAdapters[0];
    return primary ? primary.load(sessionId) : [];
  }

  async reindex(): Promise<void> {
    await this.ready();
    if (!this.ragRunner) throw new Error("reindex(): no .docs() configured.");
    await this.ragRunner.reindex();
  }

  async toMCP(opts: { port?: number } = {}): Promise<{ close(): void; port: number }> {
    await this.ready();
    const reg = getRegistry();
    if (!reg.mcpServe) throw new Error('toMCP(): import from "noble-agent" to enable the MCP server.');
    return reg.mcpServe(this, opts);
  }

  /** Tools as resolved for the loop (used by toMCP and tests). */
  async resolvedTools(): Promise<ToolDef[]> {
    await this.ready();
    return this.val<ToolDef[]>("tools", []);
  }

  async classify(text: string, labels: string[]): Promise<string> {
    await this.ready();
    const decider = this.cfg.get("decide")?.value as Decider | undefined;
    if (decider && typeof (decider as Decider).choose === "function") {
      return (await (decider as Decider).choose({}, `Classify: ${text}`, labels)).choice;
    }
    const res = await this.adapter!.complete({
      messages: [
        { role: "user", content: `Classify the following text into exactly one of [${labels.join(", ")}]. Reply with the label only.\n\n${text}` },
      ],
    });
    const found = labels.find((l) => res.text.toLowerCase().includes(l.toLowerCase()));
    return found ?? res.text.trim();
  }

  async summarise(textOrOpts: string | { sessionId: string }): Promise<string> {
    await this.ready();
    let text: string;
    if (typeof textOrOpts === "string") text = textOrOpts;
    else {
      const msgs = await this.history({ sessionId: textOrOpts.sessionId });
      text = msgs.map((m) => `${m.role}: ${m.content}`).join("\n");
    }
    const res = await this.adapter!.complete({
      messages: [{ role: "user", content: `Summarise concisely:\n\n${text}` }],
    });
    return res.text;
  }

  stopSchedules(): void {
    for (const s of this.schedules) s.stop();
    this.schedules = [];
  }

  // --- execution -----------------------------------------------------------

  async ask(text: string, opts: AskOptions = {}): Promise<RunResult> {
    await this.ready();
    const sessionId = opts.sessionId ?? opts.user?.id;
    if (!sessionId) throw new Error("ask() needs { sessionId } or { user: { id } }.");

    const oc = this.val<OptimiseCostOptions | undefined>("optimiseCost", undefined);
    const cacheKey = `${sessionId}::${this.adapter!.id}::${text.trim().toLowerCase()}`;
    if (oc?.cache) {
      const hit = this.responseCache.get(cacheKey);
      const ttl = typeof oc.cache === "object" ? (oc.cache.ttlMs ?? 300_000) : 300_000;
      if (hit && Date.now() - hit.at < ttl) return { ...hit.result, runId: randomUUID() };
    }

    const traceId = randomUUID();
    const runId = randomUUID();
    const budget = new Budget(this.val<BudgetLimits>("budget", {}));
    const emit = (e: NobleEvent) => this.bus.emit(e);
    emit(makeEvent("run.start", traceId, { runId, sessionId, query: text.slice(0, 200), user: opts.user?.id }));

    try {
      const guard = resolveGuard(this.val<GuardOptions | undefined>("guard", undefined));
      if (guard.input) {
        const screen = screenInput(text);
        if (!screen.ok) {
          emit(makeEvent("escalation", traceId, { reason: "input screen", flags: screen.flags }));
          const result = this.makeResult(runId, traceId, budget, {
            message: "I can't help with that request.",
            outcome: "escalated",
            sources: [],
            toolCalls: [],
          });
          emit(makeEvent("run.end", traceId, { outcome: result.outcome }));
          return result;
        }
      }

      // Memory read.
      let history: Message[] = [];
      const primary = this.memoryAdapters[0];
      if (primary) {
        history = await primary.load(sessionId, text);
        emit(makeEvent("memory.read", traceId, { adapter: primary.name, messages: history.length }));
      }

      const ctx = this.makeContext({ traceId, sessionId, query: text, user: opts.user, budget, emit, metadata: opts.metadata ?? {} });

      // RAG retrieval.
      let sources: SourceRef[] = [];
      let contextBlock = "";
      let ragTool: ToolDef | undefined;
      if (this.ragRunner) {
        const r = await this.ragRunner.retrieve(text, ctx);
        sources = r.sources;
        contextBlock = r.context;
        ragTool = r.asTool;
      }

      const tools = [...this.val<ToolDef[]>("tools", []), ...(ragTool ? [ragTool] : [])];
      const system = this.buildSystem(guard.dataChannel && (tools.length > 0 || !!contextBlock));

      let messages: Message[] = [...history];
      if (contextBlock) messages.push({ role: "system", content: `Reference material for this question:\n${contextBlock}` });
      messages.push({ role: "user", content: text });

      // Prompt-level strategies.
      const strategies = this.val<Strategy[]>("promptEng", []);
      for (const s of strategies) if (s.transformPrompt) messages = s.transformPrompt(messages, ctx);
      ctx.messages = messages;

      // Decision policy routing — hard budget check happens inside the loop
      // before every model call, so a runaway policy cannot exceed the budget.
      await this.routeModel(ctx);

      const run = (c: RunContext) =>
        this.executeLoop(c, { system, tools, runId, sessionId, guard, seed: { records: [], sources } });
      const wrapped = strategies
        .filter((s) => s.wrapRun)
        .reduceRight<(c: RunContext) => Promise<RunResult>>((next, s) => (c) => s.wrapRun!(c, next), run);

      const result = await wrapped(ctx);

      if (result.outcome !== "pending") {
        await this.saveTurn(sessionId, text, result.message, traceId, emit);
        if (oc?.cache && result.outcome === "resolved") this.responseCache.set(cacheKey, { at: Date.now(), result });
      }
      emit(makeEvent("run.end", traceId, { outcome: result.outcome, usd: result.cost.usd, steps: budget.steps }));
      return result;
    } catch (err) {
      const onError = this.val<((e: unknown, i: { traceId: string }) => void) | undefined>("onError", undefined);
      try {
        await onError?.(err, { traceId });
      } catch {}
      emit(makeEvent("run.end", traceId, { outcome: "error", error: String(err) }));
      return this.makeResult(runId, traceId, budget, {
        message: `Something went wrong handling this request.`,
        outcome: "error",
        sources: [],
        toolCalls: [{ tool: "(run)", args: null, error: String(err) }],
      });
    }
  }

  /** Alias for ask(). */
  run(text: string, opts: AskOptions = {}): Promise<RunResult> {
    return this.ask(text, opts);
  }

  async resume(runId: string, input: { approved: boolean; note?: string }): Promise<RunResult> {
    await this.ready();
    const state = await this.runStore.load(runId);
    if (!state) throw new Error(`resume(): unknown or already-completed runId "${runId}".`);
    await this.runStore.delete(runId);

    const budget = new Budget(this.val<BudgetLimits>("budget", {}));
    budget.usd = state.budget.usd;
    budget.tokensIn = state.budget.tokensIn;
    budget.tokensOut = state.budget.tokensOut;
    budget.steps = state.budget.steps;

    const emit = (e: NobleEvent) => this.bus.emit(e);
    const guard = resolveGuard(this.val<GuardOptions | undefined>("guard", undefined));
    const ctx = this.makeContext({
      traceId: state.traceId,
      sessionId: state.sessionId,
      query: state.query,
      user: state.userId ? { id: state.userId, groups: state.userGroups } : undefined,
      budget,
      emit,
      metadata: {},
    });
    ctx.messages = state.messages;

    const tools = this.val<ToolDef[]>("tools", []);
    const seed: LoopSeed = { records: state.toolCallRecords, sources: state.sources, injectedToolResults: [] };

    // Handle the pending call, then any remaining calls from the same turn.
    const pendingResult = input.approved
      ? await this.runToolDirect(state.pendingToolCall, tools, ctx, seed.records, guard)
      : `Approval denied by reviewer${input.note ? `: ${input.note}` : "."}`;
    ctx.messages.push({ role: "tool", content: String(pendingResult), toolCallId: state.pendingToolCall.id });
    if (!input.approved) {
      seed.records.push({ tool: state.pendingToolCall.name, args: state.pendingToolCall.args, error: "approval denied" });
    }

    for (let i = 0; i < state.remainingToolCalls.length; i++) {
      const tc = state.remainingToolCalls[i];
      const handled = await this.handleToolCall(tc, tools, ctx, seed.records, guard, {
        runId,
        sessionId: state.sessionId,
        remaining: state.remainingToolCalls.slice(i + 1),
        sources: seed.sources,
      });
      if (handled === "paused") {
        return this.makeResult(runId, state.traceId, budget, {
          message: `Awaiting approval to run "${tc.name}".`,
          outcome: "pending",
          sources: seed.sources,
          toolCalls: seed.records,
        });
      }
    }

    const system = this.buildSystem(guard.dataChannel);
    const result = await this.executeLoop(ctx, { system, tools, runId, sessionId: state.sessionId, guard, seed, skipFirstBudgetStep: false });
    if (result.outcome !== "pending") {
      await this.saveTurn(state.sessionId, state.query, result.message, state.traceId, emit);
    }
    emit(makeEvent("run.end", state.traceId, { outcome: result.outcome, resumed: true }));
    return result;
  }

  async *stream(text: string, opts: AskOptions = {}): AsyncGenerator<StreamEvent> {
    await this.ready();
    const sessionId = opts.sessionId ?? opts.user?.id;
    if (!sessionId) throw new Error("stream() needs { sessionId } or { user: { id } }.");

    const traceId = randomUUID();
    const runId = randomUUID();
    const budget = new Budget(this.val<BudgetLimits>("budget", {}));
    const emit = (e: NobleEvent) => this.bus.emit(e);
    emit(makeEvent("run.start", traceId, { runId, sessionId, query: text.slice(0, 200), stream: true }));

    const guard = resolveGuard(this.val<GuardOptions | undefined>("guard", undefined));
    const primary = this.memoryAdapters[0];
    const history = primary ? await primary.load(sessionId, text) : [];
    const ctx = this.makeContext({ traceId, sessionId, query: text, user: opts.user, budget, emit, metadata: {} });

    let sources: SourceRef[] = [];
    let contextBlock = "";
    if (this.ragRunner) {
      const r = await this.ragRunner.retrieve(text, ctx);
      sources = r.sources;
      contextBlock = r.context;
      for (const s of sources) yield { type: "source", source: s };
    }

    const tools = this.val<ToolDef[]>("tools", []);
    const system = this.buildSystem(guard.dataChannel && (tools.length > 0 || !!contextBlock));
    const messages: Message[] = [...history];
    if (contextBlock) messages.push({ role: "system", content: `Reference material for this question:\n${contextBlock}` });
    messages.push({ role: "user", content: text });
    ctx.messages = messages;

    const records: ToolCallRecord[] = [];
    const maxSteps = this.val<number>("maxSteps", 8);
    let finalText = "";
    let outcome: RunResult["outcome"] = "resolved";

    loop: while (true) {
      if (ctx.budget.exceeded() || ctx.budget.steps >= maxSteps) {
        outcome = "escalated";
        finalText = finalText || "This request needs a human to take a look — escalating.";
        break;
      }
      budget.addStep();
      emit(makeEvent("model.call", traceId, { model: ctx.model, step: ctx.budget.steps, stream: true }));
      let toolCalls: ToolCall[] = [];
      let turnText = "";
      for await (const chunk of this.adapter!.stream({ model: ctx.model, system, messages: ctx.messages, tools: tools.map(toModelToolSpec), temperature: this.val<ModelOptions>("modelOpts", {})?.temperature })) {
        if (chunk.type === "token") {
          turnText += chunk.text;
          yield { type: "token", text: chunk.text };
        } else if (chunk.type === "toolCalls") {
          toolCalls = chunk.toolCalls;
        } else if (chunk.type === "usage") {
          budget.addUsage(chunk.usage.tokensIn, chunk.usage.tokensOut, this.adapter!.price);
        }
      }
      if (toolCalls.length === 0) {
        finalText += turnText;
        ctx.messages.push({ role: "assistant", content: turnText });
        break;
      }
      ctx.messages.push({ role: "assistant", content: turnText, toolCalls });
      for (let i = 0; i < toolCalls.length; i++) {
        const tc = toolCalls[i];
        yield { type: "tool", tool: tc.name, args: tc.args };
        const handled = await this.handleToolCall(tc, tools, ctx, records, guard, {
          runId,
          sessionId,
          remaining: toolCalls.slice(i + 1),
          sources,
        });
        if (handled === "paused") {
          outcome = "pending";
          finalText = `Awaiting approval to run "${tc.name}".`;
          break loop;
        }
        if (handled === "escalated") {
          outcome = "escalated";
          finalText = String(records[records.length - 1]?.result ?? "Escalated to a human agent.");
          break loop;
        }
      }
    }

    const result = this.makeResult(runId, traceId, budget, { message: finalText, outcome, sources, toolCalls: records });
    if (outcome !== "pending") await this.saveTurn(sessionId, text, finalText, traceId, emit);
    emit(makeEvent("run.end", traceId, { outcome, usd: budget.usd }));
    yield { type: "done", result };
  }

  // --- internals -----------------------------------------------------------

  private makeContext(init: {
    traceId: string;
    sessionId: string;
    query: string;
    user?: AskOptions["user"];
    budget: Budget;
    emit: (e: NobleEvent) => void;
    metadata: Record<string, unknown>;
  }): RunContext {
    const self = this;
    const ctx: RunContext = {
      traceId: init.traceId,
      sessionId: init.sessionId,
      query: init.query,
      messages: [],
      model: this.adapter!.id,
      user: init.user,
      budget: init.budget,
      metadata: init.metadata,
      emit: init.emit,
      async complete(req) {
        init.emit(makeEvent("model.call", init.traceId, { model: req.model ?? ctx.model, purpose: "aux" }));
        const res = await self.adapter!.complete({ ...req, model: req.model ?? ctx.model } as ModelRequest);
        init.budget.addUsage(res.usage.tokensIn, res.usage.tokensOut, self.adapter!.price);
        return res;
      },
    };
    return ctx;
  }

  private buildSystem(withDataChannelNote: boolean): string {
    const parts: string[] = [];
    const system = this.val<string | undefined>("system", undefined);
    const goal = this.val<string | undefined>("goal", undefined);
    if (system) parts.push(system);
    if (goal) parts.push(`Your goal: ${goal}`);
    if (withDataChannelNote) parts.push(DATA_CHANNEL_SYSTEM_NOTE);
    return parts.join("\n\n");
  }

  private async routeModel(ctx: RunContext): Promise<void> {
    const d = this.cfg.get("decide")?.value as Decider | DecisionPolicy | undefined;
    if (!d) return;
    const policy: DecisionPolicy | undefined =
      typeof (d as DecisionPolicy).route === "function"
        ? (d as DecisionPolicy)
        : typeof (d as Decider).policy === "function"
          ? (d as Decider).policy({})
          : undefined;
    if (!policy) return;
    if (ctx.budget.exceeded()) return; // hard limit beats policy
    try {
      const { model, decision } = await policy.route(ctx);
      ctx.emit(makeEvent("decision", ctx.traceId, { policy: policy.name, choice: decision.choice, p: decision.p, probs: decision.probs }));
      if (model) ctx.model = model;
    } catch (err) {
      this.warnings.push(`decision policy failed (${String(err)}); continuing with default model.`);
    }
  }

  private async executeLoop(
    ctx: RunContext,
    opts: {
      system: string;
      tools: ToolDef[];
      runId: string;
      sessionId: string;
      guard: ReturnType<typeof resolveGuard>;
      seed: LoopSeed;
      skipFirstBudgetStep?: boolean;
    }
  ): Promise<RunResult> {
    const { system, tools, runId, sessionId, guard, seed } = opts;
    const records = seed.records;
    const sources = seed.sources;
    const maxSteps = this.val<number>("maxSteps", 8);
    const modelOpts = this.val<ModelOptions>("modelOpts", {});
    const oc = this.val<OptimiseCostOptions | undefined>("optimiseCost", undefined);
    const budget = ctx.budget as Budget;

    while (true) {
      // Hard limits beat smart policies: checked before every model call.
      const reason = budget.reason();
      if (reason) return this.exhaust(ctx, runId, sources, records, reason);
      if (budget.steps >= maxSteps) return this.exhaust(ctx, runId, sources, records, `step limit (${maxSteps}) reached`);

      budget.addStep();
      ctx.emit(makeEvent("model.call", ctx.traceId, { model: ctx.model, step: budget.steps }));
      const res: ModelResponse = await this.adapter!.complete({
        model: ctx.model,
        system,
        messages: trimHistory(ctx.messages, oc?.trimHistory),
        tools: tools.length ? tools.map(toModelToolSpec) : undefined,
        temperature: modelOpts.temperature,
        maxTokens: modelOpts.maxTokens,
      });
      budget.addUsage(res.usage.tokensIn, res.usage.tokensOut, this.adapter!.price);

      if (res.toolCalls.length === 0) {
        ctx.messages.push({ role: "assistant", content: res.text });
        return this.makeResult(runId, ctx.traceId, budget, {
          message: res.text,
          outcome: "resolved",
          sources,
          toolCalls: records,
        });
      }

      ctx.messages.push({ role: "assistant", content: res.text, toolCalls: res.toolCalls });
      for (let i = 0; i < res.toolCalls.length; i++) {
        const tc = res.toolCalls[i];
        const handled = await this.handleToolCall(tc, tools, ctx, records, guard, {
          runId,
          sessionId,
          remaining: res.toolCalls.slice(i + 1),
          sources,
        });
        if (handled === "paused") {
          return this.makeResult(runId, ctx.traceId, budget, {
            message: `Awaiting approval to run "${tc.name}".`,
            outcome: "pending",
            sources,
            toolCalls: records,
          });
        }
        if (handled === "escalated") {
          const msg = String(records[records.length - 1]?.result ?? "Escalated to a human agent.");
          ctx.emit(makeEvent("escalation", ctx.traceId, { via: "tool", tool: tc.name }));
          await this.fireEscalate(ctx, "escalate tool called");
          return this.makeResult(runId, ctx.traceId, budget, { message: msg, outcome: "escalated", sources, toolCalls: records });
        }
      }
    }
  }

  private async exhaust(
    ctx: RunContext,
    runId: string,
    sources: SourceRef[],
    records: ToolCallRecord[],
    reason: string
  ): Promise<RunResult> {
    const budget = ctx.budget as Budget;
    const onExhausted = this.val<BudgetLimits>("budget", {})?.onExhausted ?? "escalate";
    const escalate = onExhausted === "escalate";
    ctx.emit(makeEvent("escalation", ctx.traceId, { reason }));
    if (escalate) await this.fireEscalate(ctx, reason);
    return this.makeResult(runId, ctx.traceId, budget, {
      message: escalate
        ? "I wasn't able to finish this within my limits — passing you to a human agent."
        : `Stopped: ${reason}.`,
      outcome: escalate ? "escalated" : "error",
      sources,
      toolCalls: records,
    });
  }

  private async fireEscalate(ctx: RunContext, reason: string): Promise<void> {
    const fn = this.val<((info: { reason: string; query: string; sessionId: string; traceId: string }) => void | Promise<void>) | undefined>("onEscalate", undefined);
    try {
      await fn?.({ reason, query: ctx.query, sessionId: ctx.sessionId, traceId: ctx.traceId });
    } catch (err) {
      if (!quiet()) console.error("[noble] onEscalate handler failed:", err);
    }
  }

  /**
   * Returns "done" (result appended), "paused" (approval pending, state saved)
   * or "escalated" (escalate tool ran).
   */
  private async handleToolCall(
    tc: ToolCall,
    tools: ToolDef[],
    ctx: RunContext,
    records: ToolCallRecord[],
    guard: ReturnType<typeof resolveGuard>,
    pauseInfo: { runId: string; sessionId: string; remaining: ToolCall[]; sources: SourceRef[] }
  ): Promise<"done" | "paused" | "escalated"> {
    const tool = tools.find((t) => t.name === tc.name);
    ctx.emit(makeEvent("tool.call", ctx.traceId, { tool: tc.name, args: JSON.stringify(tc.args)?.slice(0, 200) }));

    if (!tool) {
      ctx.messages.push({ role: "tool", content: `Unknown tool "${tc.name}".`, toolCallId: tc.id });
      records.push({ tool: tc.name, args: tc.args, error: "unknown tool" });
      return "done";
    }

    // Tool gate (code-enforced; the model never decides access).
    if (guard.toolGate) {
      const verdict = await guard.toolGate.check({ tool: tc.name, args: tc.args }, ctx);
      ctx.emit(makeEvent("decision", ctx.traceId, { gate: guard.toolGate.name, tool: tc.name, verdict }));
      if (verdict === "block") {
        ctx.messages.push({
          role: "tool",
          content: `Tool call "${tc.name}" was blocked by safety policy. Do not retry it; answer without this tool.`,
          toolCallId: tc.id,
        });
        records.push({ tool: tc.name, args: tc.args, error: "blocked by tool gate" });
        return "done";
      }
      if (verdict === "review") {
        await this.pauseForApproval(tc, ctx, records, pauseInfo);
        return "paused";
      }
    }

    // Approval: explicit list, explicit sideEffect, or name-inferred.
    const approve = this.val<ApproveOptions | undefined>("approve", undefined);
    const listed = approve?.tools?.includes(tc.name) ?? false;
    if (listed || requiresApproval(tool)) {
      await this.pauseForApproval(tc, ctx, records, pauseInfo);
      return "paused";
    }

    const result = await this.runToolDirect(tc, tools, ctx, records, guard);
    ctx.messages.push({ role: "tool", content: String(result), toolCallId: tc.id });
    if (ctx.metadata.escalated) return "escalated";
    return "done";
  }

  private async runToolDirect(
    tc: ToolCall,
    tools: ToolDef[],
    ctx: RunContext,
    records: ToolCallRecord[],
    guard: ReturnType<typeof resolveGuard>
  ): Promise<string> {
    const tool = tools.find((t) => t.name === tc.name)!;
    const validated = validateToolArgs(tool, tc.args);
    if (!validated.ok) {
      records.push({ tool: tc.name, args: tc.args, error: validated.error });
      return validated.error;
    }
    try {
      const out = await tool.run(validated.args, ctx);
      const text = typeof out === "string" ? out : JSON.stringify(out);
      records.push({ tool: tc.name, args: validated.args, result: out });
      // Tool outputs are untrusted: keep them in the data channel.
      return guard.dataChannel && tool.name !== "escalate" ? wrapDataChannel(text ?? "null") : (text ?? "null");
    } catch (err) {
      records.push({ tool: tc.name, args: validated.args, error: String(err) });
      return `Tool "${tc.name}" failed: ${String(err)}`;
    }
  }

  private async pauseForApproval(
    tc: ToolCall,
    ctx: RunContext,
    records: ToolCallRecord[],
    info: { runId: string; sessionId: string; remaining: ToolCall[]; sources: SourceRef[] }
  ): Promise<void> {
    const budget = ctx.budget as Budget;
    const state: PendingRunState = {
      runId: info.runId,
      traceId: ctx.traceId,
      sessionId: info.sessionId,
      query: ctx.query,
      userId: ctx.user?.id,
      userGroups: ctx.user?.groups,
      messages: ctx.messages,
      pendingToolCall: tc,
      remainingToolCalls: info.remaining,
      toolCallRecords: records,
      sources: info.sources,
      budget: { usd: budget.usd, tokensIn: budget.tokensIn, tokensOut: budget.tokensOut, steps: budget.steps },
      createdAt: Date.now(),
    };
    await this.runStore.save(state);
    ctx.emit(makeEvent("approval.pending", ctx.traceId, { runId: info.runId, tool: tc.name, args: JSON.stringify(tc.args)?.slice(0, 200) }));
    const approve = this.val<ApproveOptions | undefined>("approve", undefined);
    try {
      await approve?.via?.({ runId: info.runId, tool: tc.name, args: tc.args });
    } catch (err) {
      if (!quiet()) console.error("[noble] approve.via handler failed:", err);
    }
  }

  private async saveTurn(
    sessionId: string,
    userText: string,
    assistantText: string,
    traceId: string,
    emit: (e: NobleEvent) => void
  ): Promise<void> {
    const turn: Message[] = [
      { role: "user", content: userText },
      { role: "assistant", content: assistantText },
    ];
    const [primary, ...rest] = this.memoryAdapters;
    if (!primary) return;
    await primary.save(sessionId, turn);
    emit(makeEvent("memory.write", traceId, { adapter: primary.name, messages: turn.length }));
    // Secondary (vector) writes are async with retry; failures never break a reply.
    for (const adapter of rest) {
      void retry(() => adapter.save(sessionId, turn), 3).catch((err) => {
        if (!quiet()) console.error(`[noble] memory adapter "${adapter.name}" save failed after retries:`, err);
      });
    }
  }

  private makeResult(
    runId: string,
    traceId: string,
    budget: Budget,
    partial: Pick<RunResult, "message" | "outcome" | "sources" | "toolCalls">
  ): RunResult {
    return {
      ...partial,
      traceId,
      runId,
      cost: { usd: round6(budget.usd), tokensIn: budget.tokensIn, tokensOut: budget.tokensOut },
    };
  }
}

// --- helpers ----------------------------------------------------------------

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/** Try the primary adapter; on a thrown complete(), retry once on the fallback.
 * Streaming does not fall back mid-stream. Cost is accounted at the price of
 * the adapter that actually answered. */
function withFallback(primary: ModelAdapter, fallback: ModelAdapter): ModelAdapter {
  const wrapped: ModelAdapter = {
    id: primary.id,
    price: primary.price,
    async complete(req: ModelRequest): Promise<ModelResponse> {
      try {
        const res = await primary.complete(req);
        wrapped.price = primary.price;
        return res;
      } catch (err) {
        if (!quiet()) console.warn(`[noble] model "${primary.id}" failed (${String(err)}); falling back to "${fallback.id}".`);
        wrapped.price = fallback.price;
        return fallback.complete({ ...req, model: fallback.id });
      }
    },
    stream(req: ModelRequest) {
      return primary.stream(req);
    },
  };
  return wrapped;
}

async function retry<T>(fn: () => Promise<T>, times: number): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < times; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 50 * 2 ** i));
    }
  }
  throw lastErr;
}

/** Trim to the last N messages, cutting only at a user-message boundary so
 * assistant tool calls and their results are never separated. */
export function trimHistory(messages: Message[], keep?: number): Message[] {
  if (!keep || messages.length <= keep) return messages;
  let start = messages.length - keep;
  while (start < messages.length && messages[start].role !== "user") start++;
  if (start >= messages.length) return messages.slice(-keep);
  const head = messages.filter((m, i) => i < start && m.role === "system");
  return [...head, ...messages.slice(start)];
}

// Minimal 5-field cron: supports "*", "*/n" and fixed values for min hour dom mon dow.
export function startCron(expr: string, fn: () => void | Promise<void>): { stop(): void } {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`Invalid cron expression "${expr}" (need 5 fields).`);
  const matches = (field: string, value: number): boolean => {
    if (field === "*") return true;
    const step = field.match(/^\*\/(\d+)$/);
    if (step) return value % Number(step[1]) === 0;
    return field.split(",").some((part) => Number(part) === value);
  };
  let last = -1;
  const timer = setInterval(() => {
    const now = new Date();
    const minuteKey = Math.floor(now.getTime() / 60_000);
    if (minuteKey === last) return;
    const [min, hour, dom, mon, dow] = fields;
    if (
      matches(min, now.getMinutes()) &&
      matches(hour, now.getHours()) &&
      matches(dom, now.getDate()) &&
      matches(mon, now.getMonth() + 1) &&
      matches(dow, now.getDay())
    ) {
      last = minuteKey;
      Promise.resolve(fn()).catch((err) => {
        if (!quiet()) console.error("[noble] scheduled job failed:", err);
      });
    }
  }, 1_000);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}

function buildRedactor(rules: (string | RegExp)[]): Redactor {
  const keyRules = rules.filter((r): r is string => typeof r === "string").map((s) => s.toLowerCase());
  const patterns = rules.filter((r): r is RegExp => r instanceof RegExp);
  const scrub = (value: unknown, key?: string): unknown => {
    if (key && keyRules.includes(key.toLowerCase())) return "[redacted]";
    if (typeof value === "string") {
      let out = value;
      for (const p of patterns) out = out.replace(new RegExp(p.source, p.flags.includes("g") ? p.flags : p.flags + "g"), "[redacted]");
      return out;
    }
    if (Array.isArray(value)) return value.map((v) => scrub(v));
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, scrub(v, k)]));
    }
    return value;
  };
  return (e) => ({ ...e, data: scrub(e.data) as Record<string, unknown> });
}
