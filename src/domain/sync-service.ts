import type { Clock, Sleeper } from '../clock.ts';
import type { SyncConfig } from '../config.ts';
import { isUniqueViolation, type Db } from '../db.ts';
import { AppError } from '../errors.ts';
import { ProviderError, type MetricsProviders } from '../providers/provider.ts';
import type { ConnectionsRepo } from '../storage/connections.ts';
import type { PostsRepo } from '../storage/posts.ts';
import type { SyncRunsRepo } from '../storage/sync-runs.ts';
import type { ConnectionRow, MetricsPage, SyncRunRow, SyncWindow } from './types.ts';
import { backoffDelayMs } from './retry.ts';

export interface SyncDeps {
  db: Db;
  connections: ConnectionsRepo;
  posts: PostsRepo;
  runs: SyncRunsRepo;
  providers: MetricsProviders;
  clock: Clock;
  sleeper: Sleeper;
  config: SyncConfig;
  random?: () => number;
}

type Fetched =
  | { ok: true; page: MetricsPage; fetchedAt: string }
  | { ok: false; stop: Stop };

interface Stop {
  status: 'failed' | 'rate_limited';
  code: string;
  message: string;
  retryAt?: string;
  needsReauth?: boolean;
}

export interface StartedSync {
  run: SyncRunRow;
  /** Resolves with the final run. Never rejects: failures end up in the run row. */
  done: Promise<SyncRunRow>;
}

export class SyncService {
  readonly #random: () => number;

  constructor(private readonly deps: SyncDeps) {
    this.#random = deps.random ?? Math.random;
  }

  start(connectionId: string, window: SyncWindow): StartedSync {
    const connection = this.#activeConnection(connectionId);
    this.#assertNotCoolingDown(connection.id);
    const run = this.#guardRunning(() =>
      this.deps.runs.create(connection.id, window, this.#now()),
    );
    return { run, done: this.#execute(run.id) };
  }

  /** Continues a rate_limited or failed run from its stored cursor. */
  resume(runId: string): StartedSync {
    const run = this.deps.runs.get(runId);
    if (!run) throw new AppError(404, 'sync_run_not_found', 'sync run not found');
    if (run.status !== 'rate_limited' && run.status !== 'failed') {
      throw new AppError(409, 'not_resumable', `a ${run.status} run cannot be resumed`);
    }
    this.#activeConnection(run.connection_id);
    this.#assertNotCoolingDown(run.connection_id);
    this.#guardRunning(() => this.deps.runs.reopen(run.id));
    return { run: this.deps.runs.get(run.id)!, done: this.#execute(run.id) };
  }

  /** A provider that said "wait until X" is asked nothing before X, by a new run or a resumed one. */
  #assertNotCoolingDown(connectionId: string): void {
    const retryAt = this.deps.runs.rateLimitedUntil(connectionId);
    if (retryAt !== null && retryAt > this.#now()) {
      throw new AppError(409, 'too_early', 'the provider asked to wait until retry_at', { retry_at: retryAt });
    }
  }

  #activeConnection(id: string): ConnectionRow {
    const connection = this.deps.connections.get(id);
    if (!connection) throw new AppError(404, 'connection_not_found', 'connection not found');
    if (connection.status !== 'active') {
      throw new AppError(409, 'needs_reauth', 'the connection token was rejected; reconnect before syncing');
    }
    return connection;
  }

  #guardRunning<T>(fn: () => T): T {
    try {
      return fn();
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new AppError(409, 'sync_in_progress', 'this connection already has a sync running');
      }
      throw error;
    }
  }

  #now(): string {
    return this.deps.clock.now().toISOString();
  }

  async #execute(runId: string): Promise<SyncRunRow> {
    const { runs, connections } = this.deps;
    try {
      const run = runs.get(runId)!;
      const connection = connections.get(run.connection_id)!;
      const outcome = await this.#walkPages(run, connection);
      if (outcome === 'succeeded') {
        runs.finish(runId, { status: 'succeeded' }, this.#now());
      } else {
        this.deps.db.transaction(() => {
          // A 401 for an old token must not revoke a token the user has just renewed.
          const tokenUnchanged = connections.get(connection.id)?.access_token === connection.access_token;
          if (outcome.needsReauth && tokenUnchanged) connections.setStatus(connection.id, 'needs_reauth', this.#now());
          runs.finish(
            runId,
            { status: outcome.status, errorCode: outcome.code, error: outcome.message, retryAt: outcome.retryAt },
            this.#now(),
          );
        });
      }
    } catch (error) {
      runs.finish(
        runId,
        { status: 'failed', errorCode: 'internal', error: error instanceof Error ? error.message : String(error) },
        this.#now(),
      );
    }
    return runs.get(runId)!;
  }

  async #walkPages(run: SyncRunRow, connection: ConnectionRow): Promise<'succeeded' | Stop> {
    const { config, runs } = this.deps;
    const usedCursors = new Set<string>(run.next_cursor ? [run.next_cursor] : []);
    let cursor = run.next_cursor;

    for (let pages = run.pages; ; pages++) {
      if (pages >= config.maxPages) {
        return { status: 'failed', code: 'too_many_pages', message: `provider returned more than ${config.maxPages} pages` };
      }
      // The attempt ceiling is per page; run.attempts counts every request of the run.
      const fetched = await this.#fetchPage(run, connection, cursor, { attempts: 0 });
      if (!fetched.ok) return fetched.stop;

      const { page, fetchedAt } = fetched;
      this.deps.db.transaction(() => {
        let inserted = 0;
        let duplicates = 0;
        for (const item of page.posts.filter((p) => p.publishedAt >= run.window_from && p.publishedAt < run.window_to)) {
          const postId = this.deps.posts.upsertPost(connection.id, item, fetchedAt, run.id);
          if (this.deps.posts.insertSnapshot(postId, item, fetchedAt, run.id)) inserted++;
          else duplicates++;
        }
        runs.recordPage(run.id, { nextCursor: page.nextCursor, inserted, duplicates });
      });

      if (page.nextCursor === null) return 'succeeded';
      if (usedCursors.has(page.nextCursor)) {
        return { status: 'failed', code: 'cursor_loop', message: `provider repeated cursor ${page.nextCursor}` };
      }
      usedCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
  }

  /**
   * One page, with retries. A retry repeats this page's cursor only; earlier pages are not fetched again.
   * `budget.attempts` counts the requests made for this page, whatever the failure kind.
   */
  async #fetchPage(
    run: SyncRunRow,
    connection: ConnectionRow,
    cursor: string | null,
    budget: { attempts: number },
  ): Promise<Fetched> {
    const { config, clock, sleeper, providers, runs } = this.deps;
    const provider = providers[connection.platform];

    for (;;) {
      budget.attempts++;
      runs.addAttempt(run.id);
      const exhausted = budget.attempts >= config.maxAttempts;

      try {
        const page = await provider.fetchPage({
          accountId: connection.account_id,
          accessToken: connection.access_token,
          from: run.window_from,
          to: run.window_to,
          cursor,
          signal: AbortSignal.timeout(config.requestTimeoutMs),
        });
        const fetchedAt = this.#now();
        this.#rejectFutureTimestamps(page, fetchedAt);
        return { ok: true, page, fetchedAt };
      } catch (error) {
        if (!(error instanceof ProviderError)) throw error;

        switch (error.kind) {
          case 'unauthorized':
            return stop('failed', 'unauthorized', error.message, { needsReauth: true });
          case 'rejected':
          case 'invalid_payload':
            return stop('failed', error.kind, error.message);

          case 'rate_limited': {
            const waitMs = error.retryAfterMs ?? backoffDelayMs(budget.attempts, config, this.#random);
            const retryAt = new Date(clock.now().getTime() + waitMs).toISOString();
            if (waitMs > config.maxRetryAfterMs) {
              return stop('rate_limited', 'rate_limited', `${error.message}; Retry-After ${waitMs}ms is above the ${config.maxRetryAfterMs}ms ceiling`, { retryAt });
            }
            if (exhausted) {
              return stop('rate_limited', 'rate_limited', `${error.message}; gave up after ${budget.attempts} attempts`, { retryAt });
            }
            runs.setRetryAt(run.id, retryAt);
            await sleeper.sleep(waitMs);
            break;
          }

          default: {
            if (exhausted) {
              return stop('failed', 'unavailable', `${error.message}; gave up after ${budget.attempts} attempts`);
            }
            await sleeper.sleep(backoffDelayMs(budget.attempts, config, this.#random));
          }
        }
      }
    }
  }

  /** A timestamp from the future would stay "latest" and freeze the post's metrics. */
  #rejectFutureTimestamps(page: MetricsPage, fetchedAt: string): void {
    const limit = Date.parse(fetchedAt) + this.deps.config.maxClockSkewMs;
    for (const post of page.posts) {
      if (post.observedAt !== null && Date.parse(post.observedAt) > limit) {
        throw new ProviderError('invalid_payload', `post ${post.platformPostId}: observed_at ${post.observedAt} is in the future`);
      }
    }
  }
}

function stop(
  status: Stop['status'],
  code: string,
  message: string,
  extra: Partial<Pick<Stop, 'retryAt' | 'needsReauth'>> = {},
): Fetched {
  return { ok: false, stop: { status, code, message, ...extra } };
}
