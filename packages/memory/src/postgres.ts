import type { MemoryAdapter, Message } from "@noble-agent/core";

/**
 * Postgres-backed memory. `pg` is an optional peer dependency, loaded lazily
 * so projects that don't use it never need it installed.
 */
export class PostgresMemory implements MemoryAdapter {
  name = "postgres";
  private pool?: { query(sql: string, params?: unknown[]): Promise<{ rows: any[] }> };
  private initPromise?: Promise<void>;

  constructor(private connectionString: string = process.env.DATABASE_URL ?? "") {
    if (!this.connectionString) {
      throw new Error("PostgresMemory needs a connection string (or DATABASE_URL in the environment).");
    }
  }

  private async init(): Promise<void> {
    this.initPromise ??= (async () => {
      let pg: any;
      try {
        pg = await import("pg");
      } catch {
        throw new Error('PostgresMemory requires the optional dependency "pg": pnpm add pg');
      }
      const Pool = pg.Pool ?? pg.default?.Pool;
      this.pool = new Pool({ connectionString: this.connectionString });
      await this.pool!.query(`
        CREATE TABLE IF NOT EXISTS noble_messages (
          id BIGSERIAL PRIMARY KEY,
          session_id TEXT NOT NULL,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          tool_call_id TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS idx_noble_messages_session ON noble_messages(session_id, id);
      `);
    })();
    return this.initPromise;
  }

  async load(sessionId: string): Promise<Message[]> {
    await this.init();
    const res = await this.pool!.query(
      "SELECT role, content, tool_call_id FROM noble_messages WHERE session_id = $1 ORDER BY id ASC",
      [sessionId]
    );
    return res.rows.map((r) => ({
      role: r.role,
      content: r.content,
      ...(r.tool_call_id ? { toolCallId: r.tool_call_id } : {}),
    }));
  }

  async save(sessionId: string, turn: Message[]): Promise<void> {
    await this.init();
    for (const m of turn) {
      await this.pool!.query(
        "INSERT INTO noble_messages (session_id, role, content, tool_call_id) VALUES ($1, $2, $3, $4)",
        [sessionId, m.role, m.content, m.toolCallId ?? null]
      );
    }
  }
}
