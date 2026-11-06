# `.durable()`, `.schedule()`, workflows

## `.durable({ checkpoint? })` {#durable}

Persists **approval-paused runs** to disk (default `.noble/runs/`) so a pending refund
survives a deploy or crash:

```ts
bot.durable();                                  // .noble/runs/
bot.durable({ checkpoint: "/var/noble/runs" });

const r = await bot.ask("refund order A-1001", { user });   // outcome: "pending"
// … process restarts …
await bot.resume(r.runId, { approved: true });               // state loaded from disk
```

## `.schedule(cron, fn)`

Five-field cron (`* */n` and fixed values) running inside the agent process:

```ts
bot.schedule("0 3 * * *", () => bot.reindex());          // nightly re-ingest
bot.schedule("*/15 * * * *", async () => healthPing());
// …
bot.stopSchedules();                                      // on shutdown
```

Handler errors are caught and logged — a failing job never kills the process. Timers are
`unref`'d so they don't keep a finished process alive.

## `noble.workflow(name)` — DAG workflows

Steps declare what they need; everything whose needs are met runs **in parallel**:

```ts
const wf = noble.workflow("weekly-digest")
  .step("fetchTickets", async () => zendesk.lastWeek())
  .step("fetchChats",  async () => intercom.lastWeek())
  .step("summarise", { needs: ["fetchTickets", "fetchChats"] }, async ({ results }) =>
    bot.summarise(JSON.stringify(results)))
  .step("send", { needs: ["summarise"] }, async ({ results }) =>
    mailer.send("team@acme.dev", results.summarise as string));

const { runId, results } = await wf.run();
```

Step context: `{ runId, input, results }` — `input` is whatever you passed to `run(input)`,
`results` holds completed steps by name.

### Durability & resume

```ts
const wf = noble.workflow("deploy").durable()        // checkpoint after every step
  .step("build", build)
  .step("upload", { needs: ["build"] }, upload)
  .step("announce", { needs: ["upload"] }, announce);

await wf.run(input, { runId: "deploy-42" });
// 💥 process killed during upload …

// on restart: completed steps are skipped, their results come from the checkpoint
await noble.workflow("deploy").durable()
  .step("build", build).step("upload", { needs: ["build"] }, upload)
  .step("announce", { needs: ["upload"] }, announce)
  .resume("deploy-42");
```

Checkpoints are JSON files under `.noble/workflows/` (or your `durable({ checkpoint })` dir).
Resuming a finished run returns its results without re-running anything.

### Scheduling workflows

```ts
wf.schedule("0 8 * * 1", { week: "current" });   // every Monday 08:00
wf.stopSchedules();
```

### Failure semantics

A throwing step fails the run (checkpointed as `failed` with the step name in the error);
unknown `needs` and dependency cycles are detected and reported as `deadlock` before anything
runs.

Full worked example: [Scheduled digest recipe](/recipes/scheduled-digest).
