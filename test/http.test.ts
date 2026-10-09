import { describe, expect, it, vi } from 'vitest';
import { rateLimited } from '../src/providers/fake/fake-provider.ts';
import { createHarness, fakePost, NOW, OBSERVED } from './support/harness.ts';

function setup() {
  const h = createHarness();
  h.fake.seed('instagram', 'ig_ana', [fakePost('p1', 3, 100), fakePost('p2', 6, 200), fakePost('p3', 9, 300)]);
  return h;
}

const connect = (h: ReturnType<typeof setup>, token = 'tok') =>
  h.post('/connections', { creator_id: 'ana', platform: 'instagram', account_id: 'ig_ana', access_token: token });

describe('connections', () => {
  it('creates a connection and never echoes the token', async () => {
    const h = setup();
    const res = await connect(h);

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ creator_id: 'ana', platform: 'instagram', status: 'active', last_successful_sync_at: null });
    expect(JSON.stringify(res.body)).not.toContain('tok');
  });

  it('posting the same account again renews the token instead of creating a second connection', async () => {
    const h = setup();
    const first = await connect(h);
    const second = await connect(h, 'tok2');

    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
    expect(h.connections.get(first.body.id)!.access_token).toBe('tok2');
  });

  it('refuses an account that belongs to another creator', async () => {
    const h = setup();
    await connect(h);
    const res = await h.post('/connections', { creator_id: 'bia', platform: 'instagram', account_id: 'ig_ana', access_token: 'x' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('account_taken');
  });

  it('validates the body', async () => {
    const h = setup();
    expect((await h.post('/connections', { creator_id: 'ana', platform: 'myspace', account_id: 'a', access_token: 't' })).status).toBe(400);
    expect((await h.post('/connections', { platform: 'x' })).status).toBe(400);
    expect((await h.json('/connections', { method: 'POST', body: 'not json' })).body.error.code).toBe('invalid_json');
  });

  it('reconnecting after a rejected token makes the connection usable again', async () => {
    const h = setup();
    const { body: connection } = await connect(h, 'revoked');
    h.fake.always('revoked', { kind: 'status', status: 401 });
    const failed = await h.post(`/connections/${connection.id}/sync`, { from: '2026-09-01', to: '2026-10-01' });
    expect(failed.body).toMatchObject({ status: 'failed', error_code: 'unauthorized' });
    expect((await h.json(`/connections/${connection.id}`)).body.status).toBe('needs_reauth');

    const blocked = await h.post(`/connections/${connection.id}/sync`, { from: '2026-09-01', to: '2026-10-01' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('needs_reauth');

    await connect(h, 'fresh');
    const again = await h.post(`/connections/${connection.id}/sync`, { from: '2026-09-01', to: '2026-10-01' });
    expect(again.body.status).toBe('succeeded');
  });
});

describe('sync and reading', () => {
  it('sync request validates the window', async () => {
    const h = setup();
    const { body } = await connect(h);
    const bad = [
      { from: '2026-09-10', to: '2026-09-01' },
      { from: '2026-09-10', to: '2026-09-10' },
      { from: 'yesterday', to: '2026-09-10' },
      { from: '2026-09-01T10:00:00', to: '2026-09-10' },
      { from: '2026-09-01' },
    ];
    for (const window of bad) {
      expect((await h.post(`/connections/${body.id}/sync`, window)).status).toBe(400);
    }
    expect((await h.post('/connections/nope/sync', { from: '2026-09-01', to: '2026-09-10' })).status).toBe(404);
  });

  it('exposes fetched_at (our clock) and provider_observed_at (provider clock) per post', async () => {
    const h = setup();
    const { body: connection } = await connect(h);
    await h.post(`/connections/${connection.id}/sync`, { from: '2026-09-01', to: '2026-10-01' });

    const { body } = await h.json(`/connections/${connection.id}/posts`);

    expect(body.posts).toHaveLength(3);
    expect(body.posts[0]).toEqual({
      id: expect.stringMatching(/^pst_/),
      platform_post_id: 'p3',
      url: null,
      published_at: '2026-09-09T12:00:00.000Z',
      metrics: { views: 300, likes: 30, comments: 1, shares: 2 },
      provider_observed_at: OBSERVED,
      fetched_at: NOW,
      last_checked_at: NOW,
    });
  });

  it('fetched_at follows the clock, including time spent waiting on a 429', async () => {
    const h = setup();
    const { body: connection } = await connect(h);
    h.fake.script('tok', rateLimited('30'));
    await h.post(`/connections/${connection.id}/sync`, { from: '2026-09-01', to: '2026-10-01' });

    const { body } = await h.json(`/connections/${connection.id}/posts`);

    expect(body.posts[0].fetched_at).toBe('2026-10-01T00:00:30.000Z');
    expect(body.posts[0].provider_observed_at).toBe(OBSERVED);
  });

  it('a resync with unchanged numbers keeps fetched_at of the snapshot and moves last_checked_at', async () => {
    const h = setup();
    const { body: connection } = await connect(h);
    const window = { from: '2026-09-01', to: '2026-10-01' };
    await h.post(`/connections/${connection.id}/sync`, window);
    h.clock.advance(3_600_000);
    await h.post(`/connections/${connection.id}/sync`, window);

    const { body } = await h.json(`/connections/${connection.id}/posts`);

    expect(body.posts[0]).toMatchObject({ fetched_at: NOW, last_checked_at: '2026-10-01T01:00:00.000Z' });
  });

  it('GET /sync-runs/:id and the run list return the run counters', async () => {
    const h = setup();
    const { body: connection } = await connect(h);
    const { body: run } = await h.post(`/connections/${connection.id}/sync`, { from: '2026-09-01', to: '2026-10-01' });

    expect(run).toMatchObject({
      status: 'succeeded',
      window_from: '2026-09-01T00:00:00.000Z',
      window_to: '2026-10-01T00:00:00.000Z',
      attempts: 2,
      pages: 2,
      posts_upserted: 3,
      snapshots_inserted: 3,
      duplicates_skipped: 0,
      started_at: NOW,
      finished_at: NOW,
    });
    expect((await h.json(`/sync-runs/${run.id}`)).body).toEqual(run);
    expect((await h.json(`/connections/${connection.id}/sync-runs`)).body.sync_runs).toHaveLength(1);
    expect((await h.json('/sync-runs/nope')).status).toBe(404);
  });

  it('async=true answers 202 with the running run', async () => {
    const h = setup();
    const { body: connection } = await connect(h);
    const res = await h.post(`/connections/${connection.id}/sync?async=true`, { from: '2026-09-01', to: '2026-10-01' });
    expect(res.status).toBe(202);
    expect(res.body.status).toBe('running');
  });

  it('async=true: a run that cannot record its outcome is logged instead of crashing the process', async () => {
    const h = setup();
    const { body: connection } = await connect(h);
    h.db.run(
      `CREATE TRIGGER no_finish BEFORE UPDATE ON sync_runs WHEN NEW.status <> 'running'
       BEGIN SELECT RAISE(ABORT, 'disk full'); END`,
    );
    let report!: (error: unknown) => void;
    const loggedError = new Promise<unknown>((resolve) => (report = resolve));
    const logged = vi.spyOn(console, 'error').mockImplementation(report);

    const res = await h.post(`/connections/${connection.id}/sync?async=true`, { from: '2026-09-01', to: '2026-10-01' });

    expect(res.status).toBe(202);
    const error = await loggedError;
    expect(error).toMatchObject({ message: expect.stringContaining('disk full') });
    logged.mockRestore();
  });

  it('a second sync while one runs answers 409', async () => {
    const h = setup();
    const { body: connection } = await connect(h);
    let release!: () => void;
    h.fake.script('tok', { kind: 'gate', until: new Promise<void>((r) => (release = r)) });
    const window = { from: '2026-09-01', to: '2026-10-01' };

    const first = h.post(`/connections/${connection.id}/sync`, window);
    const second = await h.post(`/connections/${connection.id}/sync`, window);
    release();

    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('sync_in_progress');
    expect((await first).body.status).toBe('succeeded');
  });

  it('rate_limited run over HTTP carries retry_at, and resume answers 409 until then', async () => {
    const h = setup();
    const { body: connection } = await connect(h);
    h.fake.script('tok', rateLimited('3600'));
    const { body: run } = await h.post(`/connections/${connection.id}/sync`, { from: '2026-09-01', to: '2026-10-01' });

    expect(run).toMatchObject({ status: 'rate_limited', retry_at: '2026-10-01T01:00:00.000Z' });
    const early = await h.post(`/sync-runs/${run.id}/resume`, {});
    expect(early.status).toBe(409);
    expect(early.body.error).toMatchObject({ code: 'too_early', retry_at: '2026-10-01T01:00:00.000Z' });

    h.clock.advance(3_600_000);
    expect((await h.post(`/sync-runs/${run.id}/resume`, {})).body.status).toBe('succeeded');
  });

  it('creator totals come from current values of distinct posts, across platforms', async () => {
    const h = setup();
    h.fake.seed('x', 'x_ana', [fakePost('t1', 4, 1000)]);
    const { body: ig } = await connect(h);
    const { body: x } = await h.post('/connections', { creator_id: 'ana', platform: 'x', account_id: 'x_ana', access_token: 'tx' });
    const window = { from: '2026-09-01', to: '2026-10-01' };
    for (const id of [ig.id, ig.id, x.id]) await h.post(`/connections/${id}/sync`, window);
    await h.post(`/connections/${ig.id}/sync`, { from: '2026-09-05', to: '2026-09-30' });

    const { body } = await h.json('/creators/ana/metrics');

    expect(body).toMatchObject({ creator_id: 'ana', posts: 4, totals: { views: 1600 }, oldest_fetched_at: NOW, newest_fetched_at: NOW });
    expect(body.connections.map((c: any) => [c.platform, c.posts, c.views])).toEqual([
      ['instagram', 3, 600],
      ['x', 1, 1000],
    ]);
    expect((await h.json('/creators/nobody/metrics')).status).toBe(404);
  });

  it('snapshot history of a post lists every observation', async () => {
    const h = setup();
    const { body: connection } = await connect(h);
    const window = { from: '2026-09-01', to: '2026-10-01' };
    await h.post(`/connections/${connection.id}/sync`, window);
    h.fake.update('instagram', 'ig_ana', 'p1', { views: 150 }, '2026-09-30T12:00:00.000Z');
    await h.post(`/connections/${connection.id}/sync`, window);

    const { body: list } = await h.json(`/connections/${connection.id}/posts`);
    const p1 = list.posts.find((p: any) => p.platform_post_id === 'p1');
    const { body } = await h.json(`/posts/${p1.id}/snapshots`);

    expect(p1.metrics.views).toBe(150);
    expect(body.snapshots.map((s: any) => [s.provider_observed_at, s.metrics.views])).toEqual([
      [OBSERVED, 100],
      ['2026-09-30T12:00:00.000Z', 150],
    ]);
  });
});
