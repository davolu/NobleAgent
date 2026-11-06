import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { MemoryAdapter, Message } from "@noble-agent/core";

/**
 * Default durable memory. One row per message, keyed per session so two
 * users never see each other's turns.
 */
export class SqliteMemory implements MemoryAdapter {
  name = "sqlite";
  private db: Database.Database;

  constructor(path: string = join(process.cwd(), ".noble", "memory.db")) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        tool_call_id TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id);
    `);
  }

  async load(sessionId: string): Promise<Message[]> {
    const rows = this.db
      .prepare<[string], { role: Message["role"]; content: string; tool_call_id: string | null }>(
        "SELECT role, content, tool_call_id FROM messages WHERE session_id = ? ORDER BY id ASC"
      )
      .all(sessionId);
    return rows.map((r) => ({
      role: r.role,
      content: r.content,
      ...(r.tool_call_id ? { toolCallId: r.tool_call_id } : {}),
    }));
  }

  async save(sessionId: string, turn: Message[]): Promise<void> {
    const insert = this.db.prepare(
      "INSERT INTO messages (session_id, role, content, tool_call_id, created_at) VALUES (?, ?, ?, ?, ?)"
    );
    const tx = this.db.transaction((msgs: Message[]) => {
      for (const m of msgs) insert.run(sessionId, m.role, m.content, m.toolCallId ?? null, Date.now());
    });
    tx(turn);
  }

  close(): void {
    this.db.close();
  }
}
