import { randomUUID } from 'node:crypto';
import type { Db } from '../db.ts';
import type { SyncRunRow, SyncRunStatus, SyncWindow } from '../domain/types.ts';

export interface Finish {
  status: Exclude<SyncRunStatus, 'running'>;
  errorCode?: string;
  error?: string;
  retryAt?: string;
}

export class SyncRunsRepo {
  constructor(private readonly db: Db) {}

  get(id: string): SyncRunRow | undefined {
    return this.db.get<SyncRunRow>('SELECT * FROM sync_runs WHERE id = ?', id);
  }

  listByConnection(connectionId: string): SyncRunRow[] {
    return this.db.all<SyncRunRow>(
      'SELECT * FROM sync_runs WHERE connection_id = ? ORDER BY started_at DESC, rowid DESC',
      connectionId,
    );
  }

  /** Throws a UNIQUE violation if the connection already has a running run. */
  create(connectionId: string, window: SyncWindow, now: string): SyncRunRow {
    const id = `run_${randomUUID()}`;
    this.db.run(
      `INSERT INTO sync_runs (id, connection_id, window_from, window_to, status, started_at)
       VALUES (?, ?, ?, ?, 'running', ?)`,
      id,
      connectionId,
      window.from,
      window.to,
      now,
    );
    return this.get(id)!;
  }

  /** Puts a rate_limited or failed run back to running; it keeps its cursor and counters. */
  reopen(id: string): void {
    this.db.run(
      `UPDATE sync_runs SET status = 'running', retry_at = NULL, error_code = NULL, error = NULL, finished_at = NULL
       WHERE id = ?`,
      id,
    );
  }

  addAttempt(id: string): void {
    this.db.run('UPDATE sync_runs SET attempts = attempts + 1 WHERE id = ?', id);
  }

  /** Called inside the page transaction, so counters and cursor move together with the data. */
  recordPage(id: string, page: { nextCursor: string | null; inserted: number; duplicates: number }): void {
    this.db.run(
      `UPDATE sync_runs SET
         pages = pages + 1,
         snapshots_inserted = snapshots_inserted + ?,
         duplicates_skipped = duplicates_skipped + ?,
         next_cursor = ?,
         posts_upserted = (SELECT COUNT(*) FROM posts WHERE last_sync_run_id = ?)
       WHERE id = ?`,
      page.inserted,
      page.duplicates,
      page.nextCursor,
      id,
      id,
    );
  }

  finish(id: string, outcome: Finish, now: string): void {
    this.db.run(
      `UPDATE sync_runs SET status = ?, error_code = ?, error = ?, retry_at = ?, finished_at = ? WHERE id = ?`,
      outcome.status,
      outcome.errorCode ?? null,
      outcome.error ?? null,
      outcome.retryAt ?? null,
      now,
      id,
    );
  }

  lastSucceededAt(connectionId: string): string | null {
    const row = this.db.get<{ at: string | null }>(
      `SELECT MAX(finished_at) AS at FROM sync_runs WHERE connection_id = ? AND status = 'succeeded'`,
      connectionId,
    );
    return row?.at ?? null;
  }

  /** A crash leaves runs in 'running'; they would block the connection forever. */
  failInterrupted(now: string): number {
    return this.db.run(
      `UPDATE sync_runs SET status = 'failed', error_code = 'interrupted',
         error = 'process stopped while the run was in progress', finished_at = ?
       WHERE status = 'running'`,
      now,
    ).changes;
  }
}
