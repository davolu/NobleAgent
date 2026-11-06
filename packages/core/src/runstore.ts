import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Message, ToolCall, ToolCallRecord, SourceRef } from "./types.js";

/** Serialized state of a paused run (awaiting approval). */
export interface PendingRunState {
  runId: string;
  traceId: string;
  sessionId: string;
  query: string;
  userId?: string;
  userGroups?: string[];
  messages: Message[];
  pendingToolCall: ToolCall;
  /** Remaining tool calls from the same assistant turn, not yet executed. */
  remainingToolCalls: ToolCall[];
  toolCallRecords: ToolCallRecord[];
  sources: SourceRef[];
  budget: { usd: number; tokensIn: number; tokensOut: number; steps: number };
  createdAt: number;
}

export interface RunStore {
  save(state: PendingRunState): Promise<void>;
  load(runId: string): Promise<PendingRunState | undefined>;
  delete(runId: string): Promise<void>;
}

export class InMemoryRunStore implements RunStore {
  private runs = new Map<string, PendingRunState>();
  async save(state: PendingRunState): Promise<void> {
    this.runs.set(state.runId, state);
  }
  async load(runId: string): Promise<PendingRunState | undefined> {
    return this.runs.get(runId);
  }
  async delete(runId: string): Promise<void> {
    this.runs.delete(runId);
  }
}

/** File-backed store so paused runs survive a process restart. */
export class FileRunStore implements RunStore {
  constructor(private dir: string = join(process.cwd(), ".noble", "runs")) {}

  private file(runId: string): string {
    return join(this.dir, `${runId.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`);
  }

  async save(state: PendingRunState): Promise<void> {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.file(state.runId), JSON.stringify(state, null, 2));
  }

  async load(runId: string): Promise<PendingRunState | undefined> {
    const f = this.file(runId);
    if (!existsSync(f)) return undefined;
    return JSON.parse(readFileSync(f, "utf8")) as PendingRunState;
  }

  async delete(runId: string): Promise<void> {
    const f = this.file(runId);
    if (existsSync(f)) rmSync(f);
  }
}
