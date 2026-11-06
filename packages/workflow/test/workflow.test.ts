import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { workflow } from "@noble-agent/workflow";

describe("Phase 10 — workflows", () => {
  it("runs ready steps in parallel and respects needs", async () => {
    const order: string[] = [];
    const wf = workflow("etl")
      .step("extractA", async () => {
        await new Promise((r) => setTimeout(r, 30));
        order.push("extractA");
        return "A";
      })
      .step("extractB", async () => {
        order.push("extractB");
        return "B";
      })
      .step("combine", { needs: ["extractA", "extractB"] }, async ({ results }) => {
        order.push("combine");
        return `${results.extractA}+${results.extractB}`;
      });

    const t0 = Date.now();
    const { results } = await wf.run();
    expect(results.combine).toBe("A+B");
    expect(order[order.length - 1]).toBe("combine");
    expect(order.slice(0, 2)).toContain("extractB"); // B didn't wait for A
    expect(Date.now() - t0).toBeLessThan(90); // parallel, not serial
  });

  it("detects unknown needs and deadlocks loudly", async () => {
    expect(() => workflow("w").step("a", { needs: ["a"] }, () => 1)).not.toThrow();
    await expect(workflow("w").step("a", { needs: ["missing"] }, () => 1).run()).rejects.toThrow(/unknown step/);
    await expect(workflow("w").step("a", { needs: ["a"] }, () => 1).run()).rejects.toThrow(/deadlock/);
  });

  it("a killed process resumes a durable workflow mid-run", async () => {
    const checkpoint = mkdtempSync(join(tmpdir(), "noble-wf-"));
    const runs: string[] = [];
    let crash = true;

    const build = () =>
      workflow("deploy")
        .durable({ checkpoint })
        .step("build", async () => {
          runs.push("build");
          return "artifact-1";
        })
        .step("upload", { needs: ["build"] }, async ({ results }) => {
          if (crash) throw new Error("process killed");
          runs.push("upload");
          return `${results.build}-uploaded`;
        })
        .step("announce", { needs: ["upload"] }, async () => {
          runs.push("announce");
          return "done";
        });

    const wf1 = build();
    const firstRun = await wf1.run(undefined, { runId: "run-1" }).catch((e) => e as Error);
    expect(firstRun).toBeInstanceOf(Error);
    expect(runs).toEqual(["build"]); // checkpointed up to the crash

    // "restart": a fresh workflow instance resumes from the checkpoint
    crash = false;
    const wf2 = build();
    const { results } = await wf2.resume("run-1");
    expect(results.announce).toBe("done");
    expect(results.upload).toBe("artifact-1-uploaded"); // build's result came from the checkpoint
    expect(runs).toEqual(["build", "upload", "announce"]); // build never re-ran
  });

  it("resume on a finished run returns its results without re-running", async () => {
    const checkpoint = mkdtempSync(join(tmpdir(), "noble-wf-"));
    let count = 0;
    const wf = workflow("once")
      .durable({ checkpoint })
      .step("only", async () => ++count);
    const { runId } = await wf.run();
    const again = await wf.resume(runId);
    expect(again.results.only).toBe(1);
    expect(count).toBe(1);
  });
});
