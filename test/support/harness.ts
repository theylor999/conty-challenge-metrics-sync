import { createApp } from '../../src/app.ts';
import type { Clock, Sleeper } from '../../src/clock.ts';
import { defaultSyncConfig, type SyncConfig } from '../../src/config.ts';
import { Db } from '../../src/db.ts';
import { SyncService } from '../../src/domain/sync-service.ts';
import type { ConnectionRow, Counters, Platform, SyncRunRow, SyncWindow } from '../../src/domain/types.ts';
import { createProviders } from '../../src/providers/adapters/index.ts';
import type { FakePost } from '../../src/providers/fake/dialects.ts';
import { FakeProvider } from '../../src/providers/fake/fake-provider.ts';
import { ConnectionsRepo } from '../../src/storage/connections.ts';
import { PostsRepo } from '../../src/storage/posts.ts';
import { SyncRunsRepo } from '../../src/storage/sync-runs.ts';

export class FakeClock implements Clock {
  #ms: number;
  constructor(iso: string) {
    this.#ms = Date.parse(iso);
  }
  now(): Date {
    return new Date(this.#ms);
  }
  advance(ms: number): void {
    this.#ms += ms;
  }
}

/** Records every wait and moves the fake clock instead of sleeping. */
export class FakeSleeper implements Sleeper {
  readonly waits: number[] = [];
  constructor(private readonly clock: FakeClock) {}
  async sleep(ms: number): Promise<void> {
    this.waits.push(ms);
    this.clock.advance(ms);
  }
}

export const NOW = '2026-10-01T00:00:00.000Z';
export const OBSERVED = '2026-09-30T00:00:00.000Z';
export const SEPTEMBER: SyncWindow = { from: '2026-09-01T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z' };

export const testConfig: SyncConfig = {
  ...defaultSyncConfig,
  jitterRatio: 0,
  requestTimeoutMs: 5_000,
  maxAttempts: 5,
  baseBackoffMs: 500,
  maxBackoffMs: 8_000,
  maxRetryAfterMs: 60_000,
};

export function createHarness(options: { config?: Partial<SyncConfig>; pageSize?: number; random?: () => number; sleeper?: Sleeper } = {}) {
  const db = new Db(':memory:');
  const clock = new FakeClock(NOW);
  const sleeper = new FakeSleeper(clock);
  const usedSleeper = options.sleeper ?? sleeper;
  const fake = new FakeProvider({ pageSize: options.pageSize ?? 2 });
  const connections = new ConnectionsRepo(db);
  const posts = new PostsRepo(db);
  const runs = new SyncRunsRepo(db);
  const sync = new SyncService({
    db,
    connections,
    posts,
    runs,
    providers: createProviders({ fetch: fake.fetch, clock }),
    clock,
    sleeper: usedSleeper,
    config: { ...testConfig, ...options.config },
    random: options.random ?? (() => 0),
  });
  const app = createApp({ connections, posts, runs, sync, clock });

  function connect(platform: Platform = 'instagram', token = 'tok', account = 'acct', creator = 'creator_1'): ConnectionRow {
    return connections.create({ creatorId: creator, platform, accountId: account, accessToken: token }, clock.now().toISOString());
  }

  async function runSync(connection: ConnectionRow, window: SyncWindow = SEPTEMBER): Promise<SyncRunRow> {
    return sync.start(connection.id, window).done;
  }

  const json = async (path: string, init?: RequestInit) => {
    const res = await app.request(path, init);
    return { status: res.status, body: (await res.json()) as any };
  };
  const post = (path: string, body: unknown) =>
    json(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  return { db, clock, sleeper, fake, connections, posts, runs, sync, app, connect, runSync, json, post };
}

export function fakePost(id: string, day: number, views: number, observedAt = OBSERVED, extra: Partial<Counters> = {}): FakePost {
  return {
    id,
    publishedAt: `2026-09-${String(day).padStart(2, '0')}T12:00:00.000Z`,
    counters: { views, likes: views / 10, comments: 1, shares: 2, ...extra },
    observedAt,
  };
}
