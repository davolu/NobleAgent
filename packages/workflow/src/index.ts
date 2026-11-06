import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startCron } from "@noble-agent/core";

export interface StepCtx {
  runId: string;
  input: unknown;
  /** Results of completed steps, by name. */
  results: Record<string, unknown>;
}

type StepFn = (ctx: StepCtx) => Promise<unknown> | unknown;

interface StepDef {
  name: string;
  needs: string[];
  fn: StepFn;
}

interface Checkpoint {
  runId: string;
  workflow: string;
  input: unknown;
  completed: Record<string, unknown>;
  status: "running" | "done" | "failed";
  error?: string;
}

/**
 * DAG workflow: steps declare dependencies; every step whose needs are met
 * runs in parallel. With .durable(), a checkpoint is written after each step
 * so a killed process resumes mid-run.
 */
export class Workflow {
  private steps = new Map<string, StepDef>();
  private durableOpts?: { checkpoint?: string };
  private schedules: { stop(): void }[] = [];

  constructor(public name: string) {}

  step(name: string, needsOrFn: { needs?: string[] } | StepFn, maybeFn?: StepFn): this {
    const fn = typeof needsOrFn === "function" ? needsOrFn : maybeFn!;
    const needs = typeof needsOrFn === "function" ? [] : (needsOrFn.needs ?? []);
    if (this.steps.has(name)) throw new Error(`workflow "${this.name}": duplicate step "${name}".`);
    this.steps.set(name, { name, needs, fn });
    return this;
  }

  durable(opts: { checkpoint?: string } = {}): this {
    this.durableOpts = opts;
    return this;
  }

  schedule(cron: string, input?: unknown): this {
    this.schedules.push(startCron(cron, () => void this.run(input)));
    return this;
  }

  stopSchedules(): void {
    for (const s of this.schedules) s.stop();
  }

  private checkpointPath(runId: string): string {
    const dir = this.durableOpts?.checkpoint ?? join(process.cwd(), ".noble", "workflows");
    mkdirSync(dir, { recursive: true });
    return join(dir, `${this.name}-${runId}.json`);
  }

  private saveCheckpoint(cp: Checkpoint): void {
    if (!this.durableOpts) return;
    writeFileSync(this.checkpointPath(cp.runId), JSON.stringify(cp, null, 2));
  }

  async run(input?: unknown, opts: { runId?: string } = {}): Promise<{ runId: string; results: Record<string, unknown> }> {
    this.validate();
    const runId = opts.runId ?? randomUUID();
    const completed: Record<string, unknown> = {};
    const cp: Checkpoint = { runId, workflow: this.name, input, completed, status: "running" };

    const pending = new Set(this.steps.keys());
    while (pending.size) {
      const ready = [...pending].filter((name) => this.steps.get(name)!.needs.every((n) => n in completed));
      if (!ready.length) throw new Error(`workflow "${this.name}": deadlock — remaining steps ${[...pending].join(", ")} have unmet needs.`);
      // Parallel execution of all ready steps.
      const results = await Promise.all(
        ready.map(async (name) => {
          const step = this.steps.get(name)!;
          try {
            return { name, value: await step.fn({ runId, input, results: { ...completed } }) };
          } catch (err) {
            cp.status = "failed";
            cp.error = `step "${name}": ${String(err)}`;
            this.saveCheckpoint(cp);
            throw new Error(cp.error);
          }
        })
      );
      for (const { name, value } of results) {
        completed[name] = value ?? null;
        pending.delete(name);
        this.saveCheckpoint(cp); // checkpoint after each step
      }
    }
    cp.status = "done";
    this.saveCheckpoint(cp);
    return { runId, results: completed };
  }

  /** Resume a durable run after a crash: completed steps are skipped. */
  async resume(runId: string): Promise<{ runId: string; results: Record<string, unknown> }> {
    const path = this.checkpointPath(runId);
    if (!existsSync(path)) throw new Error(`workflow resume: no checkpoint for run "${runId}".`);
    const cp = JSON.parse(readFileSync(path, "utf8")) as Checkpoint;
    if (cp.status === "done") return { runId, results: cp.completed };

    this.validate();
    const completed = { ...cp.completed };
    const liveCp: Checkpoint = { ...cp, completed, status: "running", error: undefined };
    const pending = new Set([...this.steps.keys()].filter((n) => !(n in completed)));
    while (pending.size) {
      const ready = [...pending].filter((name) => this.steps.get(name)!.needs.every((n) => n in completed));
      if (!ready.length) throw new Error(`workflow "${this.name}": deadlock on resume.`);
      const results = await Promise.all(
        ready.map(async (name) => ({ name, value: await this.steps.get(name)!.fn({ runId, input: cp.input, results: { ...completed } }) }))
      );
      for (const { name, value } of results) {
        completed[name] = value ?? null;
        pending.delete(name);
        this.saveCheckpoint(liveCp);
      }
    }
    liveCp.status = "done";
    this.saveCheckpoint(liveCp);
    return { runId, results: completed };
  }

  private validate(): void {
    for (const step of this.steps.values()) {
      for (const need of step.needs) {
        if (!this.steps.has(need)) throw new Error(`workflow "${this.name}": step "${step.name}" needs unknown step "${need}".`);
      }
    }
  }
}

export function workflow(name: string): Workflow {
  return new Workflow(name);
}
