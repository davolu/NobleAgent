# Recipe: scheduled weekly digest (workflow + summarise)

A Monday-morning digest that pulls last week's support conversations, summarises them with
the model, and emails the team — durable, so a crash mid-run resumes instead of restarting.

## The workflow

```ts
// digest.ts
import { noble, fileSink } from "noble-agent";

const analyst = noble
  .agent("You write crisp internal reports. Bullet points, numbers first, no fluff.")
  .budget("$0.50")
  .observe({ sinks: [fileSink(".noble/digest-events.ndjson")] });

export const digest = noble.workflow("weekly-digest")
  .durable()                                              // checkpoint after every step
  // independent fetches run in parallel
  .step("tickets", async () => zendesk.closedSince(lastMonday()))
  .step("chats", async () => db.conversations.since(lastMonday()))
  .step("escalations", async () => db.escalations.since(lastMonday()))
  // joins wait for their needs
  .step("report", { needs: ["tickets", "chats", "escalations"] }, async ({ results }) => {
    const r = await analyst.ask(
      `Write the weekly support digest from this data. Include: volume vs last week, ` +
      `top 3 themes, notable escalations, one recommendation.\n\n${JSON.stringify(results)}`,
      { sessionId: `digest-${lastMonday()}` }
    );
    return r.message;
  })
  .step("send", { needs: ["report"] }, async ({ results }) =>
    mailer.send("support-team@acme.dev", "Weekly support digest", results.report as string))
  .step("archive", { needs: ["report"] }, async ({ results, runId }) =>
    s3.put(`digests/${runId}.md`, results.report as string));
```

`send` and `archive` both need only `report` — they run **in parallel** once it exists.

## Schedule it

```ts
digest.schedule("0 8 * * 1");          // every Monday 08:00
```

Or from your own scheduler / a cron container:

```ts
await digest.run({ week: isoWeek() });
```

## Crash-resume

Every completed step is checkpointed to `.noble/workflows/`. If the process dies while
`send` is in flight:

```ts
await digest.resume(runId);
// tickets/chats/escalations/report come from the checkpoint — the model is NOT re-queried,
// only the unfinished steps run.
```

That matters here: the expensive step (the model call in `report`) never re-runs, and the
email never goes out twice for the same completed `send`.

## Why an agent inside a workflow?

The workflow owns *orchestration* (order, parallelism, durability, retries-by-resume); the
agent owns *one well-budgeted model task*. Composing them keeps each simple — and the agent's
budget means a malformed data dump can't turn the digest into a $40 model bill. For
conversation summaries specifically, `analyst.summarise(...)` is the one-line alternative.
