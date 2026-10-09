import { describe, expect, it } from 'vitest';
import { syncConfigFromEnv } from '../src/config.ts';
import { rateLimited } from '../src/providers/fake/fake-provider.ts';
import { createHarness, fakePost, SEPTEMBER } from './support/harness.ts';

const posts3 = () => [fakePost('p1', 3, 100), fakePost('p2', 6, 200), fakePost('p3', 9, 300)];

function setup(options: Parameters<typeof createHarness>[0] = {}) {
  const h = createHarness(options);
  h.fake.seed('instagram', 'acct', posts3());
  return { ...h, connection: h.connect('instagram', 'tok') };
}

describe('attempt ceiling is per page', () => {
  it('a long listing is not cut by the ceiling when every request succeeds', async () => {
    const t = setup({ config: { maxAttempts: 2 }, pageSize: 1 });

    const run = await t.runSync(t.connection);

    expect(run).toMatchObject({ status: 'succeeded', pages: 3, attempts: 3 });
  });

  it('each page gets its own budget', async () => {
    const t = setup({ config: { maxAttempts: 2 }, pageSize: 1 });
    t.fake.script('tok', { kind: 'timeout' }, { kind: 'serve' }, { kind: 'timeout' }, { kind: 'serve' }, { kind: 'timeout' }, { kind: 'serve' });

    const run = await t.runSync(t.connection);

    expect(run).toMatchObject({ status: 'succeeded', pages: 3, attempts: 6 });
  });

  it('a page that fails twice with maxAttempts 2 ends the run', async () => {
    const t = setup({ config: { maxAttempts: 2 }, pageSize: 1 });
    t.fake.script('tok', { kind: 'serve' }, { kind: 'timeout' }, { kind: 'timeout' });

    const run = await t.runSync(t.connection);

    expect(run).toMatchObject({ status: 'failed', pages: 1, attempts: 3 });
  });

  it('maxPages counts pages of the whole run, also after a resume', async () => {
    const t = setup({ config: { maxPages: 2 }, pageSize: 1 });

    const first = await t.runSync(t.connection);
    expect(first).toMatchObject({ status: 'failed', error_code: 'too_many_pages', pages: 2 });

    const again = await t.sync.resume(first.id).done;
    expect(again).toMatchObject({ status: 'failed', error_code: 'too_many_pages', pages: 2 });
  });
});

describe('rate limit cooldown', () => {
  it('a new sync during the Retry-After window is refused, and allowed after it', async () => {
    const t = setup();
    t.fake.script('tok', rateLimited('3600'));
    const limited = await t.runSync(t.connection);
    expect(limited.status).toBe('rate_limited');

    expect(() => t.sync.start(t.connection.id, SEPTEMBER)).toThrow(/retry_at/);
    expect(t.fake.calls).toHaveLength(1);

    t.clock.advance(3_600_000);
    expect((await t.runSync(t.connection)).status).toBe('succeeded');
  });

  it('a Retry-After far beyond any date ends as rate_limited, not as an internal error', async () => {
    const t = setup();
    t.fake.script('tok', rateLimited('9999999999999999'));

    const run = await t.runSync(t.connection);

    expect(run).toMatchObject({ status: 'rate_limited', error_code: 'rate_limited' });
    expect(run.retry_at).not.toBeNull();
    expect(t.sleeper.waits).toEqual([]);
  });
});

describe('credentials', () => {
  it('a 401 for the old token does not revoke a token renewed meanwhile', async () => {
    const t = setup();
    let release!: () => void;
    t.fake.script('tok', { kind: 'gate', until: new Promise<void>((r) => (release = r)) }, { kind: 'status', status: 401 });
    t.fake.always('tok', { kind: 'status', status: 401 });

    const { done } = t.sync.start(t.connection.id, SEPTEMBER);
    t.connections.renewToken(t.connection.id, 'fresh', t.clock.now().toISOString());
    release();
    await done;

    expect(t.connections.get(t.connection.id)!.status).toBe('active');
  });
});

describe('windows', () => {
  it('sub-second windows still find the post and respect both bounds', async () => {
    const h = createHarness();
    h.fake.seed('instagram', 'acct', [
      { ...fakePost('inside', 3, 100), publishedAt: '2026-09-03T12:00:00.000Z' },
      { ...fakePost('before', 3, 200), publishedAt: '2026-09-03T11:59:59.000Z' },
      { ...fakePost('after', 3, 300), publishedAt: '2026-09-03T12:00:01.000Z' },
    ]);
    const connection = h.connect();

    const run = await h.runSync(connection, { from: '2026-09-03T11:59:59.900Z', to: '2026-09-03T12:00:00.100Z' });

    expect(run.status).toBe('succeeded');
    expect(h.posts.listCurrentByConnection(connection.id).map((p) => p.platform_post_id)).toEqual(['inside']);
  });

  it('drops items the provider returns outside the window', async () => {
    const h = createHarness();
    const connection = h.connect('instagram', 'wide');
    h.fake.script('wide', { kind: 'page', posts: [fakePost('in', 5, 100), fakePost('out', 25, 200)] });

    await h.runSync(connection, { from: '2026-09-01', to: '2026-09-10' });

    expect(h.posts.listCurrentByConnection(connection.id).map((p) => p.platform_post_id)).toEqual(['in']);
  });

  it('rejects dates that do not exist', async () => {
    const t = setup();
    for (const from of ['2026-02-30', '2026-13-01', '2026-09-31', '2026-09-01T24:00:00Z']) {
      const res = await t.post(`/connections/${t.connection.id}/sync`, { from, to: '2026-12-01' });
      expect(res.status, from).toBe(400);
    }
    expect((await t.post(`/connections/${t.connection.id}/sync`, { from: '2028-02-29', to: '2028-03-01' })).status).toBe(200);
  });
});

describe('payload validation', () => {
  const tokenCases = [
    ['youtube', { items: [], nextPageToken: 123 }],
    ['x', { data: [], meta: { next_token: 123 } }],
    ['tiktok', { data: { videos: [], cursor: 1 } }],
  ] as const;

  it.each(tokenCases)('%s: a malformed continuation is a broken page, not the end of the list', async (platform, body) => {
    const h = createHarness();
    const connection = h.connect(platform, 'bad', 'acct');
    h.fake.script('bad', { kind: 'raw', status: 200, body });

    const run = await h.runSync(connection);

    expect(run).toMatchObject({ status: 'failed', error_code: 'invalid_payload' });
  });

  it('rejects counters above the supported range and unrepresentable timestamps', async () => {
    const h = createHarness();
    const ig = h.connect('instagram', 'huge', 'a1');
    h.fake.script('huge', { kind: 'page', posts: [fakePost('p1', 3, 2e12)] });
    expect(await h.runSync(ig)).toMatchObject({ status: 'failed', error_code: 'invalid_payload' });

    const tt = h.connect('tiktok', 'far', 'a2');
    h.fake.script('far', {
      kind: 'raw',
      status: 200,
      body: { data: { videos: [{ id: '1', create_time: 1e100, stats_time: 1, view_count: 1 }], has_more: false } },
    });
    expect(await h.runSync(tt)).toMatchObject({ status: 'failed', error_code: 'invalid_payload' });
  });
});

describe('storage', () => {
  it('a storage failure on the second item rolls back the whole page', async () => {
    const h = createHarness();
    const connection = h.connect('instagram', 'boom');
    h.db.run(
      `CREATE TRIGGER boom BEFORE INSERT ON snapshots WHEN NEW.views = 660
       BEGIN SELECT RAISE(ABORT, 'boom'); END`,
    );
    h.fake.script('boom', { kind: 'page', posts: [fakePost('p1', 3, 100), fakePost('p2', 6, 660)] });

    const run = await h.runSync(connection);

    expect(run).toMatchObject({ status: 'failed', error_code: 'internal', pages: 0, snapshots_inserted: 0, next_cursor: null });
    expect(h.posts.totalsForCreator('creator_1').posts).toBe(0);
    expect(h.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM sync_run_posts')!.n).toBe(0);
  });

  it('posts_upserted of a resumed run survives another run touching the same posts', async () => {
    const t = setup({ config: { maxAttempts: 2 }, pageSize: 2 });
    t.fake.script('tok', { kind: 'serve' }, { kind: 'status', status: 500 }, { kind: 'status', status: 500 });
    const failed = await t.runSync(t.connection);
    expect(failed).toMatchObject({ status: 'failed', pages: 1, posts_upserted: 2 });

    await t.runSync(t.connection);
    const resumed = await t.sync.resume(failed.id).done;

    expect(resumed).toMatchObject({ status: 'succeeded', pages: 2, posts_upserted: 3 });
  });
});

describe('config from env', () => {
  it('accepts valid values', () => {
    expect(syncConfigFromEnv({ SYNC_MAX_ATTEMPTS: '3', SYNC_REQUEST_TIMEOUT_MS: '2000', SYNC_MAX_RETRY_AFTER_MS: '15000' })).toMatchObject({
      maxAttempts: 3,
      requestTimeoutMs: 2000,
      maxRetryAfterMs: 15000,
    });
  });

  it('rejects values the runtime would mishandle', () => {
    expect(() => syncConfigFromEnv({ SYNC_REQUEST_TIMEOUT_MS: '0.5' })).toThrow(/SYNC_REQUEST_TIMEOUT_MS/);
    expect(() => syncConfigFromEnv({ SYNC_MAX_RETRY_AFTER_MS: '3000000000' })).toThrow(/SYNC_MAX_RETRY_AFTER_MS/);
    expect(() => syncConfigFromEnv({ SYNC_MAX_ATTEMPTS: '0' })).toThrow(/SYNC_MAX_ATTEMPTS/);
    expect(() => syncConfigFromEnv({ SYNC_MAX_ATTEMPTS: 'many' })).toThrow(/SYNC_MAX_ATTEMPTS/);
  });
});
