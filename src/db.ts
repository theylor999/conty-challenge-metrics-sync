import { DatabaseSync, type StatementSync } from 'node:sqlite';

export type Param = string | number | null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS connections (
  id            TEXT PRIMARY KEY,
  creator_id    TEXT NOT NULL,
  platform      TEXT NOT NULL CHECK (platform IN ('instagram', 'tiktok', 'youtube', 'x')),
  account_id    TEXT NOT NULL,
  access_token  TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('active', 'needs_reauth')),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (platform, account_id)
);

CREATE TABLE IF NOT EXISTS sync_runs (
  id                  TEXT PRIMARY KEY,
  connection_id       TEXT NOT NULL REFERENCES connections(id),
  window_from         TEXT NOT NULL,
  window_to           TEXT NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'rate_limited')),
  attempts            INTEGER NOT NULL DEFAULT 0,
  pages               INTEGER NOT NULL DEFAULT 0,
  posts_upserted      INTEGER NOT NULL DEFAULT 0,
  snapshots_inserted  INTEGER NOT NULL DEFAULT 0,
  duplicates_skipped  INTEGER NOT NULL DEFAULT 0,
  next_cursor         TEXT,
  retry_at            TEXT,
  error_code          TEXT,
  error               TEXT,
  started_at          TEXT NOT NULL,
  finished_at         TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS sync_runs_one_running
  ON sync_runs (connection_id) WHERE status = 'running';

CREATE TABLE IF NOT EXISTS posts (
  id                TEXT PRIMARY KEY,
  connection_id     TEXT NOT NULL REFERENCES connections(id),
  platform_post_id  TEXT NOT NULL,
  published_at      TEXT NOT NULL,
  url               TEXT,
  first_seen_at     TEXT NOT NULL,
  last_seen_at      TEXT NOT NULL,
  last_sync_run_id  TEXT NOT NULL REFERENCES sync_runs(id),
  UNIQUE (connection_id, platform_post_id)
);

-- Append-only. provider_observed_at is NULL when the provider gives no timestamp
-- for the counters; effective_observed_at then falls back to fetched_at.
CREATE TABLE IF NOT EXISTS snapshots (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id                TEXT NOT NULL REFERENCES posts(id),
  sync_run_id            TEXT NOT NULL REFERENCES sync_runs(id),
  provider_observed_at   TEXT,
  effective_observed_at  TEXT NOT NULL,
  fetched_at             TEXT NOT NULL,
  views                  INTEGER CHECK (views IS NULL OR views >= 0),
  likes                  INTEGER CHECK (likes IS NULL OR likes >= 0),
  comments               INTEGER CHECK (comments IS NULL OR comments >= 0),
  shares                 INTEGER CHECK (shares IS NULL OR shares >= 0),
  UNIQUE (post_id, provider_observed_at)
);
CREATE INDEX IF NOT EXISTS snapshots_latest
  ON snapshots (post_id, effective_observed_at DESC, id DESC);

CREATE TRIGGER IF NOT EXISTS snapshots_no_update BEFORE UPDATE ON snapshots
BEGIN SELECT RAISE(ABORT, 'snapshots are append-only'); END;
CREATE TRIGGER IF NOT EXISTS snapshots_no_delete BEFORE DELETE ON snapshots
BEGIN SELECT RAISE(ABORT, 'snapshots are append-only'); END;

-- The current value of a post is its latest snapshot by provider time,
-- never a sum of snapshots.
CREATE VIEW IF NOT EXISTS current_metrics AS
SELECT p.id AS post_id, p.connection_id, c.creator_id, c.platform, p.platform_post_id,
       p.url, p.published_at, p.last_seen_at,
       s.views, s.likes, s.comments, s.shares, s.provider_observed_at, s.fetched_at
FROM posts p
JOIN connections c ON c.id = p.connection_id
JOIN snapshots s ON s.id = (
  SELECT s2.id FROM snapshots s2 WHERE s2.post_id = p.id
  ORDER BY s2.effective_observed_at DESC, s2.id DESC LIMIT 1
);
`;

/** The only module that talks to node:sqlite. */
export class Db {
  readonly #db: DatabaseSync;
  readonly #statements = new Map<string, StatementSync>();
  #inTransaction = false;

  constructor(path = ':memory:') {
    this.#db = new DatabaseSync(path);
    this.#db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    if (path !== ':memory:') this.#db.exec('PRAGMA journal_mode = WAL;');
    this.#db.exec(SCHEMA);
  }

  run(sql: string, ...params: Param[]): { changes: number } {
    const result = this.#prepare(sql).run(...params);
    return { changes: Number(result.changes) };
  }

  get<T>(sql: string, ...params: Param[]): T | undefined {
    return this.#prepare(sql).get(...params) as T | undefined;
  }

  all<T>(sql: string, ...params: Param[]): T[] {
    return this.#prepare(sql).all(...params) as T[];
  }

  /** Synchronous and not reentrant: everything inside commits or rolls back together. */
  transaction<T>(fn: () => T): T {
    if (this.#inTransaction) throw new Error('nested transactions are not supported');
    this.#db.exec('BEGIN IMMEDIATE');
    this.#inTransaction = true;
    try {
      const result = fn();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    } finally {
      this.#inTransaction = false;
    }
  }

  close(): void {
    this.#db.close();
  }

  #prepare(sql: string): StatementSync {
    let statement = this.#statements.get(sql);
    if (!statement) {
      statement = this.#db.prepare(sql);
      this.#statements.set(sql, statement);
    }
    return statement;
  }
}

export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/.test(error.message);
}
