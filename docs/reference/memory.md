# `.memory()`

```ts
import { SqliteMemory, PostgresMemory, PineconeMemory, HistoryMemory } from "noble-agent";

bot.memory([new SqliteMemory()]);                            // explicit durable store
bot.memory([new SqliteMemory(), new PineconeMemory({...})]); // durable + semantic recall
bot.memory([]);                                              // stateless (explicitly)
```

**Convention:** if you never call `.memory()`, the umbrella package gives you a durable
`SqliteMemory` at `.noble/memory.db` and `explain()` notes it came from `convention`.

Memory is keyed **per session** — `sessionId` defaults to `user.id` (and `ask()` throws if
neither is present). Two users can never see each other's turns; the repo's cross-session leak
test is the contract.

## Adapters

### `HistoryMemory({ maxMessages? })`
In-process, non-durable. Good for tests and ephemeral bots. Caps at 200 messages per session
by default.

### `SqliteMemory(path?)`
The default durable store (better-sqlite3, WAL mode). One row per message. Conversations
survive restarts:

```ts
const mem = new SqliteMemory("./data/memory.db");
```

### `PostgresMemory(connectionString?)`
Reads `DATABASE_URL` when the argument is omitted. `pg` is an optional peer dependency,
loaded lazily — install it only if you use this.

### `PineconeMemory({ indexHost, embedder, apiKey?, namespace?, topK? })` <Badge type="warning" text="experimental" />
Vector memory: turns are embedded on save; `load(sessionId, query)` returns the most relevant
past turns for the current query, filtered by `sessionId` **in the Pinecone query filter** —
access control in code, not prompts. Never use it as the source of truth; compose it behind a
durable store.

## `composeMemory([durable, ...semantic])`

```ts
import { composeMemory } from "noble-agent";

bot.memory([composeMemory([
  new SqliteMemory(),                     // source of truth — writes are awaited
  new PineconeMemory({ indexHost, embedder }),  // async writes with retry; failures logged, never thrown
])]);
```

- `load()` returns the durable history, plus anything the semantic stores recall for the
  current query as a prefixed `Relevant earlier context:` system message (deduped).
- `save()` awaits the durable write; secondary writes are fire-and-forget with 3 retries.
  A down vector store can never break a reply.

## Reading history

```ts
const messages = await bot.history({ user });            // or { sessionId }
const summary  = await bot.summarise({ sessionId });     // model-written summary of a session
```

## Writing your own adapter

```ts
interface MemoryAdapter {
  name: string;
  load(sessionId: string, query?: string): Promise<Message[]>;
  save(sessionId: string, turn: Message[]): Promise<void>;
}
```

Rules and a Redis example: [Writing adapters](/adapters#memory-adapter).
