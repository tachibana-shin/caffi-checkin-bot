/**
 * A key/value record store with three interchangeable backends.
 *
 * The bot keeps all of its state in two records — the sealed store under
 * `["caffi", "store"]` and a handful of `meta` markers — so nothing here needs
 * more than get/set. Which backend is in play depends on where the bot runs:
 *
 * - **Cloudflare Workers** (`worker`): D1, a strongly consistent SQL store, so
 *   a write the cron just made is visible to the next Telegram webhook instead
 *   of lagging behind it. Eventual KV would be cheaper but would race with the
 *   nightly run.
 * - **Deno Deploy** (`webhook`): the platform's own Deno KV.
 * - **local** (`polling`): a Deno KV file inside `DATA_DIR`, so
 *   `deno task start` keeps working with no service attached.
 */
export interface RecordStore {
  get<T>(key: string[]): Promise<T | null>;
  set<T>(key: string[], value: T): Promise<void>;
  /** Every key sharing the prefix — used by the backup script. */
  list(prefix: string[]): Promise<Array<[string[], unknown]>>;
}

const join = (key: string[]) => key.join(" ");

// ── Cloudflare D1 ───────────────────────────────────────────────────────────

/** The shape wrangler hands the handler; only the statement API is used. */
export interface D1Like {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      first<T>(): Promise<T | null>;
      all<T>(): Promise<{ results: T[] }>;
      run(): Promise<unknown>;
    };
  };
}

const D1_SCHEMA = `
CREATE TABLE IF NOT EXISTS records (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/** D1 stores JSON as text; the extra `v` column is future-proofing, nothing reads it. */
export function d1Store(db: D1Like): RecordStore {
  return {
    async get<T>(key: string[]) {
      const row = await db.prepare("SELECT value FROM records WHERE key = ?")
        .bind(join(key))
        .first<{ value: string }>();
      return row ? (JSON.parse(row.value) as T) : null;
    },
    async set(key: string[], value: unknown) {
      await db.prepare(
        "INSERT INTO records (key, value) VALUES (?, ?) " +
          "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
        .bind(join(key), JSON.stringify(value))
        .run();
    },
    async list(prefix: string[]) {
      const p = join(prefix);
      const rows = await db.prepare("SELECT key, value FROM records WHERE key = ? OR key LIKE ?")
        .bind(p, `${p}/%`)
        .all<{ key: string; value: string }>();
      return rows.results.map((r) =>
        [r.key.split(" "), JSON.parse(r.value)] as [string[], unknown]
      );
    },
  };
}

/** Create the table — a migration step, run once by `scripts/d1-init.ts`. */
export async function d1Init(db: D1Like): Promise<void> {
  // D1's own statement type is wider than the surface this app uses.
  await (db.prepare(D1_SCHEMA) as unknown as { run(): Promise<unknown> }).run();
}

// ── Deno KV ─────────────────────────────────────────────────────────────────

/** Wraps a `Deno.Kv` behind the same two-method surface. */
export function kvStore(kv: Deno.Kv): RecordStore {
  return {
    async get<T>(key: string[]) {
      return (await kv.get<T>(key)).value;
    },
    async set(key: string[], value: unknown) {
      await kv.set(key, value);
    },
    async list(prefix: string[]) {
      const out: Array<[string[], unknown]> = [];
      for await (const entry of kv.list({ prefix })) {
        out.push([entry.key as string[], entry.value]);
      }
      return out;
    },
  };
}
