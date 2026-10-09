import { describe, expect, it } from 'vitest';
import { createHarness, fakePost, NOW, OBSERVED } from './support/harness.ts';

const ACCOUNT = 'acct';
const seed = () => [
  fakePost('p1', 3, 100),
  fakePost('p2', 6, 200),
  fakePost('p3', 10, 300),
  fakePost('p4', 14, 400),
  fakePost('p5', 18, 500),
  fakePost('p6', 22, 600),
];

function setup(platform: 'instagram' | 'x' = 'instagram') {
  const h = createHarness();
  h.fake.seed(platform, ACCOUNT, seed());
  const connection = h.connect(platform);
  const totals = () => h.posts.totalsForCreator('creator_1');
  const snapshotCount = () => h.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM snapshots')!.n;
  return { ...h, connection, totals, snapshotCount };
}

describe('overlapping windows', () => {
  it('counts each post once when two windows share posts', async () => {
    const t = setup();
    const a = await t.runSync(t.connection, { from: '2026-09-01', to: '2026-09-16' }); // p1..p4
    const b = await t.runSync(t.connection, { from: '2026-09-09', to: '2026-09-25' }); // p3..p6

    expect(a.status).toBe('succeeded');
    expect(a.snapshots_inserted).toBe(4);
    expect(b.status).toBe('succeeded');
    expect(b.snapshots_inserted).toBe(2);
    expect(b.duplicates_skipped).toBe(2);
    expect(t.totals()).toMatchObject({ posts: 6, views: 2100 });
    expect(t.snapshotCount()).toBe(6);
  });

  it('gives the same totals as one big window, and as the same window repeated', async () => {
    const overlapped = setup();
    await overlapped.runSync(overlapped.connection, { from: '2026-09-01', to: '2026-09-16' });
    await overlapped.runSync(overlapped.connection, { from: '2026-09-09', to: '2026-09-25' });
    await overlapped.runSync(overlapped.connection, { from: '2026-09-09', to: '2026-09-25' });

    const single = setup();
    await single.runSync(single.connection);

    expect(overlapped.totals()).toMatchObject({ posts: 6, views: 2100, likes: 210, comments: 6, shares: 12 });
    expect(single.totals()).toMatchObject({ posts: 6, views: 2100, likes: 210, comments: 6, shares: 12 });
  });

  it('works the same on a platform without provider timestamps (x)', async () => {
    const t = setup('x');
    await t.runSync(t.connection, { from: '2026-09-01', to: '2026-09-16' });
    const b = await t.runSync(t.connection, { from: '2026-09-09', to: '2026-09-25' });

    expect(b.duplicates_skipped).toBe(2);
    expect(t.totals()).toMatchObject({ posts: 6, views: 2100 });
    expect(t.snapshotCount()).toBe(6);
  });
});

describe('repeated data inside one sync', () => {
  it('ignores the same page delivered twice', async () => {
    const h = createHarness();
    const connection = h.connect('instagram', 'dup-page');
    const page = [fakePost('p1', 3, 100), fakePost('p2', 6, 200)];
    h.fake.script(
      'dup-page',
      { kind: 'page', posts: page, nextCursor: 'c2' },
      { kind: 'page', posts: page, nextCursor: null },
    );

    const run = await h.runSync(connection);

    expect(run).toMatchObject({ status: 'succeeded', pages: 2, snapshots_inserted: 2, duplicates_skipped: 2, posts_upserted: 2 });
    expect(h.posts.totalsForCreator('creator_1')).toMatchObject({ posts: 2, views: 300 });
  });

  it('ignores a duplicate item inside one page', async () => {
    const h = createHarness();
    const connection = h.connect('instagram', 'dup-item');
    h.fake.script('dup-item', {
      kind: 'page',
      posts: [fakePost('p1', 3, 100), fakePost('p1', 3, 100), fakePost('p2', 6, 200)],
    });

    const run = await h.runSync(connection);

    expect(run).toMatchObject({ snapshots_inserted: 2, duplicates_skipped: 1, posts_upserted: 2 });
    expect(h.posts.totalsForCreator('creator_1')).toMatchObject({ posts: 2, views: 300 });
  });

  it('ignores a post that reappears on a later page', async () => {
    const h = createHarness();
    const connection = h.connect('instagram', 'shifted');
    h.fake.script(
      'shifted',
      { kind: 'page', posts: [fakePost('p1', 3, 100), fakePost('p2', 6, 200)], nextCursor: 'c2' },
      { kind: 'page', posts: [fakePost('p2', 6, 200), fakePost('p3', 9, 300)] },
    );

    await h.runSync(connection);

    expect(h.posts.totalsForCreator('creator_1')).toMatchObject({ posts: 3, views: 600 });
  });
});

describe('counters are absolute, not additive', () => {
  it('a newer snapshot replaces the current value instead of adding to it', async () => {
    const t = setup();
    await t.runSync(t.connection);
    t.fake.update('instagram', ACCOUNT, 'p1', { views: 150 }, '2026-09-30T12:00:00.000Z');
    const run = await t.runSync(t.connection);

    expect(run.snapshots_inserted).toBe(1);
    expect(run.duplicates_skipped).toBe(5);
    expect(t.totals()).toMatchObject({ posts: 6, views: 2150 });
    expect(t.snapshotCount()).toBe(7);
  });

  it('an older snapshot arriving later is kept in history but never becomes current', async () => {
    const h = createHarness();
    const connection = h.connect('instagram', 'late');
    h.fake.script(
      'late',
      { kind: 'page', posts: [fakePost('p1', 3, 500, '2026-09-30T12:00:00.000Z')] },
      { kind: 'page', posts: [fakePost('p1', 3, 400, '2026-09-29T12:00:00.000Z')] },
    );

    await h.runSync(connection);
    const second = await h.runSync(connection);

    const [current] = h.posts.listCurrentByConnection(connection.id);
    expect(second.snapshots_inserted).toBe(1);
    expect(current).toMatchObject({ views: 500, provider_observed_at: '2026-09-30T12:00:00.000Z' });
    expect(h.posts.listSnapshots(current!.post_id)).toHaveLength(2);
    expect(h.posts.totalsForCreator('creator_1').views).toBe(500);
  });

  it('same provider timestamp with different numbers: first one wins, second is a duplicate', async () => {
    const h = createHarness();
    const connection = h.connect('instagram', 'same-ts');
    h.fake.script(
      'same-ts',
      { kind: 'page', posts: [fakePost('p1', 3, 500)] },
      { kind: 'page', posts: [fakePost('p1', 3, 990)] },
    );

    await h.runSync(connection);
    const second = await h.runSync(connection);

    expect(second.duplicates_skipped).toBe(1);
    expect(h.posts.totalsForCreator('creator_1').views).toBe(500);
  });

  it('without provider timestamps, unchanged numbers are skipped and a change (including a decrease) is stored', async () => {
    const h = createHarness();
    const connection = h.connect('x', 'no-ts');
    const at = (likes: number) => [fakePost('p1', 3, 100, OBSERVED, { likes })];
    h.fake.script(
      'no-ts',
      { kind: 'page', posts: at(5) },
      { kind: 'page', posts: at(5) },
      { kind: 'page', posts: at(6) },
      { kind: 'page', posts: at(5) },
    );

    const runs = [];
    for (let i = 0; i < 4; i++) {
      h.clock.advance(60_000);
      runs.push(await h.runSync(connection));
    }

    expect(runs.map((r) => r.snapshots_inserted)).toEqual([1, 0, 1, 1]);
    const [current] = h.posts.listCurrentByConnection(connection.id);
    expect(current).toMatchObject({ likes: 5, provider_observed_at: null });
    expect(h.posts.listSnapshots(current!.post_id)).toHaveLength(3);
  });
});

describe('database enforces idempotency', () => {
  it('rejects a second snapshot with the same (post, provider_observed_at)', async () => {
    const t = setup();
    await t.runSync(t.connection);
    const row = t.db.get<{ post_id: string; sync_run_id: string }>('SELECT post_id, sync_run_id FROM snapshots LIMIT 1')!;

    expect(() =>
      t.db.run(
        `INSERT INTO snapshots (post_id, sync_run_id, provider_observed_at, effective_observed_at, fetched_at, views)
         VALUES (?, ?, ?, ?, ?, 1)`,
        row.post_id,
        row.sync_run_id,
        OBSERVED,
        OBSERVED,
        NOW,
      ),
    ).toThrow(/UNIQUE/);
  });

  it('rejects a second post with the same (connection, platform_post_id)', async () => {
    const t = setup();
    await t.runSync(t.connection);
    const row = t.db.get<{ connection_id: string; platform_post_id: string; last_sync_run_id: string }>(
      'SELECT connection_id, platform_post_id, last_sync_run_id FROM posts LIMIT 1',
    )!;

    expect(() =>
      t.db.run(
        `INSERT INTO posts (id, connection_id, platform_post_id, published_at, first_seen_at, last_seen_at, last_sync_run_id)
         VALUES ('x', ?, ?, ?, ?, ?, ?)`,
        row.connection_id,
        row.platform_post_id,
        NOW,
        NOW,
        NOW,
        row.last_sync_run_id,
      ),
    ).toThrow(/UNIQUE/);
  });

  it('snapshots cannot be updated or deleted', async () => {
    const t = setup();
    await t.runSync(t.connection);
    expect(() => t.db.run('UPDATE snapshots SET views = 1')).toThrow(/append-only/);
    expect(() => t.db.run('DELETE FROM snapshots')).toThrow(/append-only/);
  });

  it('a page that fails halfway leaves nothing behind', async () => {
    const h = createHarness();
    const connection = h.connect('instagram', 'atomic');
    h.fake.script('atomic', {
      kind: 'page',
      posts: [fakePost('p1', 3, 100), fakePost('p2', 6, -5)],
    });

    const run = await h.runSync(connection);

    expect(run).toMatchObject({ status: 'failed', error_code: 'invalid_payload', pages: 0 });
    expect(h.posts.totalsForCreator('creator_1').posts).toBe(0);
  });
});

describe('who sees the numbers', () => {
  it('two different connections for different creators never mix', async () => {
    const h = createHarness();
    h.fake.seed('instagram', 'a', [fakePost('p1', 3, 100)]);
    h.fake.seed('instagram', 'b', [fakePost('p1', 3, 700)]);
    const a = h.connect('instagram', 'tok-a', 'a', 'creator_a');
    const b = h.connect('instagram', 'tok-b', 'b', 'creator_b');
    await h.runSync(a);
    await h.runSync(b);

    expect(h.posts.totalsForCreator('creator_a').views).toBe(100);
    expect(h.posts.totalsForCreator('creator_b').views).toBe(700);
  });
});
