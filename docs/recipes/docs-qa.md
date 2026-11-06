# Recipe: internal docs Q&A (with access levels)

A company-knowledge bot over a folder of PDFs, markdown and text — where HR docs are visible
to HR, `internal/` to staff, and everything else to everyone. Slack-shaped, but the bot is
transport-agnostic.

## The bot

```ts
// bot.ts
import { noble } from "noble-agent";

export const bot = noble
  .docs({ company: "Acme" })                 // the "docs" preset: answer strictly from documents
  .docs("./knowledge", {
    rag: "self",                             // grade results, rewrite weak queries
    access: {
      "hr/**": ["hr"],
      "finance/**": ["finance", "exec"],
      // internal/** → ["staff"] by folder convention, no config needed
    },
  })
  .budget("$0.03")
  .observe({ redact: ["email", /\b[A-Z]{2}\d{6}\b/] });   // employee-id pattern
```

::: tip Why `rag: "self"`
Internal corpora are messy — acronyms, stale pages, near-duplicate policies. Self-RAG grades
what retrieval returned and rewrites the query when results are weak, at ~2× cost. Start with
the default `hybrid` and upgrade only if your eval says so. See [Strategies](/strategies).
:::

## Groups come from your directory, not the user

```ts
// slack.ts
import { bot } from "./bot.js";

app.event("app_mention", async ({ event, say }) => {
  const profile = await directory.lookup(event.user);        // your IdP / HRIS
  const r = await bot.ask(stripMention(event.text), {
    user: { id: event.user, groups: profile.groups },        // ["staff", "hr"] etc.
    sessionId: `${event.channel}:${event.thread_ts ?? event.ts}`,  // memory per thread
  });

  const cites = r.sources.map((s) => `• ${s.title}${s.page ? ` p.${s.page}` : ""}`).join("\n");
  await say({ thread_ts: event.ts, text: `${r.message}\n\n${cites}` });
});
```

Two things to notice:

- **`sessionId` per thread**, not per user — follow-up questions in a thread share memory,
  parallel threads don't bleed into each other.
- A user without the `hr` group asking about parental-leave specifics simply never retrieves
  the HR chunk — the model can't leak what it never saw, and the preset makes it say the
  documents don't cover it.

## Agentic variant: let the model search

For exploratory questions ("what do we have about vendor security reviews?") pre-injecting
one retrieval is limiting. The `agentic` strategy hands the model a `search_docs` tool so it
can search, read, and search again:

```ts
bot.docs("./knowledge", { rag: "agentic" }).tools([], { maxSteps: 6 });
```

Access filtering applies to every tool-driven search too — it's the same index code path.

## Operations

```ts
bot.schedule("0 3 * * *", () => bot.reindex());   // nightly; file hashes skip unchanged docs
```

```bash
noble explain --bot ./src/bot.ts    # audit what the bot is actually configured to do
```

Add an eval with `cites-source` + `faithfulness` asserts before you let it near the whole
company — the [support recipe](/recipes/support-bot#_5-keep-it-honest) shows the pattern.
