import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { BACKEND_ROOT } from "./config.js";

// bigint columns (seq, rev, counts) stay far below 2^53, so plain numbers are safe.
pg.types.setTypeParser(pg.types.builtins.INT8, Number);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

/** Anything that can run a query: the pool, or a client inside a transaction. */
export interface Queryable {
  query<R extends Row = Row>(text: string, params?: unknown[]): Promise<pg.QueryResult<R>>;
}

export class Db implements Queryable {
  readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 10 });
    this.pool.on("error", (err) => console.error("[db] idle client error:", err.message));
  }

  query<R extends Row = Row>(text: string, params?: unknown[]): Promise<pg.QueryResult<R>> {
    return this.pool.query<R>(text, params);
  }

  /** Run `fn` in a transaction. Commits on return, rolls back on throw. */
  async tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  close(): Promise<void> {
    return this.pool.end();
  }
}

export const MIGRATIONS_DIR = path.join(BACKEND_ROOT, "migrations");

/** Apply any migrations/NNN_*.sql files that have not run yet, in name order. */
export async function migrate(db: Db, log: (msg: string) => void = () => {}): Promise<string[]> {
  const client = await db.pool.connect();
  const applied: string[] = [];
  try {
    // One migrator at a time, even if several processes boot together.
    await client.query("SELECT pg_advisory_lock(727274)");
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const done = new Set((await client.query("SELECT name FROM schema_migrations")).rows.map((r) => r.name as string));
    const files = (await fs.readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await fs.readFile(path.join(MIGRATIONS_DIR, file), "utf8");
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
      applied.push(file);
      log(`applied ${file}`);
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(727274)").catch(() => {});
    client.release();
  }
  return applied;
}

export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const e = err as { code?: string; constraint?: string };
  return e?.code === "23505" && (constraint === undefined || e.constraint === constraint);
}
