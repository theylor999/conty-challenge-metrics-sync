import { describe, expect, it } from 'vitest';
import type { SyncConfig } from '../src/config.ts';
import { rateLimited } from '../src/providers/fake/fake-provider.ts';
import { createHarness, fakePost, SEPTEMBER } from './support/harness.ts';

const ok = (id = 'p1', views = 100) => ({ kind: 'page' as const, posts: [fakePost(id, 3, views)] });

function setup(config: Partial<SyncConfig> = {}) {
  const h = createHarness({ config });
  h.fake.seed('instagram', 'acct', [fakePost('p1', 3, 100), fakePost('p2', 6, 200), fakePost('p3', 9, 300)]);
  const connection = h.connect('instagram', 'tok');
  return { ...h, connection };
}

describe('transient failures', () => {
  it('retries a timeout and then succeeds', async () => {
    const t = setup();
    t.fake.script('tok', { kind: 'timeout' }, { kind: 'serve' });

    const run = await t.runSync(t.connection);

    expect(run).toMatchObject({ status: 'succeeded', attempts: 3, pages: 2 });
    expect(t.sleeper.waits).toEqual([500]);
  });

  it('aborts a request that hangs once the per-request timeout passes', async () => {
    const t = setup({ requestTimeoutMs: 25 });
    t.fake.script('tok', { kind: 'hang' }, { kind: 'serve' });

    const run = await t.runSync(t.connection);

    expect(run).toMatchObject({ status: 'succeeded', attempts: 3 });
    expect(t.sleeper.waits).toEqual([500]);
  });

  it('retries a network error and a 503', async () => {
    const t = setup();
    t.fake.script('tok', { kind: 'network' }, { kind: 'status', status: 503 }, { kind: 'serve' });

    const run = await t.runSync(t.connection);

    expect(run).toMatchObject({ status: 'succeeded', attempts: 4 });
    expect(t.sleeper.waits).toEqual([500, 1000]);
  });

  it('gives up after maxAttempts on persistent 5xx: attempts equals the ceiling and waits are exponential', async () => {
    const t = setup();
    t.fake.always('tok', { kind: 'status', status: 502 });

    const run = await t.runSync(t.connection);

    expect(run).toMatchObject({ status: 'failed', error_code: 'unavailable', attempts: 5, pages: 0 });
    expect(t.fake.calls).toHaveLength(5);
    expect(t.sleeper.waits).toEqual([500, 1000, 2000, 4000]);
    expect(run.finished_at).not.toBeNull();
  });

  it('caps the backoff at maxBackoffMs', async () => {
    const t = setup({ maxAttempts: 7, maxBackoffMs: 1500 });
    t.fake.always('tok', { kind: 'timeout' });

    await t.runSync(t.connection);

    expect(t.sleeper.waits).toEqual([500, 1000, 1500, 1500, 1500, 1500]);
  });

  it('shortens the backoff by jitter but never above the nominal delay', async () => {
    const h = createHarness({ config: { jitterRatio: 0.2 }, random: () => 1 });
    h.fake.seed('instagram', 'acct', [fakePost('p1', 3, 100)]);
    const connection = h.connect();
    h.fake.script('tok', { kind: 'timeout' }, { kind: 'serve' });

    await h.runSync(connection);

    expect(h.sleeper.waits).toEqual([400]);
  });

  it('retries only the failing page: earlier pages are not fetched again', async () => {
    const t = setup();
    t.fake.script('tok', { kind: 'serve' }, { kind: 'status', status: 500 }, { kind: 'serve' });

    const run = await t.runSync(t.connection);

    expect(run.status).toBe('succeeded');
    expect(t.fake.calls.map((c) => c.cursor)).toEqual([null, '2', '2']);
  });

  it('a page that fails for good keeps the pages already stored and the cursor', async () => {
    const t = setup({ maxAttempts: 3 });
    t.fake.script('tok', { kind: 'serve' });
    t.fake.always('tok', { kind: 'status', status: 500 });

    const run = await t.runSync(t.connection);

    expect(run).toMatchObject({ status: 'failed', pages: 1, snapshots_inserted: 2, next_cursor: '2', attempts: 3 });
    expect(t.posts.totalsForCreator('creator_1').posts).toBe(2);
  });

  it('resume continues from the stored cursor and finishes the window', async () => {
    const t = setup({ maxAttempts: 3 });
    t.fake.script('tok', { kind: 'serve' }, { kind: 'status', status: 500 }, { kind: 'status', status: 500 }, { kind: 'status', status: 500 });
    const failed = await t.runSync(t.connection);
    expect(failed.status).toBe('failed');

    const resumed = await t.sync.resume(failed.id).done;

    expect(resumed).toMatchObject({ id: failed.id, status: 'succeeded', pages: 2, error: null, error_code: null });
    expect(t.fake.calls.map((c) => c.cursor)).toEqual([null, '2', '2', '2', '2']);
    expect(t.posts.totalsForCreator('creator_1')).toMatchObject({ posts: 3, views: 600 });
  });
});

describe('429 and Retry-After', () => {
  it('waits exactly Retry-After seconds and then succeeds', async () => {
    const t = setup();
    t.fake.script('tok', rateLimited('30'), { kind: 'serve' });

    const run = await t.runSync(t.connection);

    expect(t.sleeper.waits).toEqual([30_000]);
    expect(run).toMatchObject({ status: 'succeeded', attempts: 3 });
  });

  it('understands the HTTP-date form, measured against the injected clock', async () => {
    const t = setup();
    const at = new Date(t.clock.now().getTime() + 45_000).toUTCString();
    t.fake.script('tok', rateLimited(at), { kind: 'serve' });

    const run = await t.runSync(t.connection);

    expect(t.sleeper.waits).toEqual([45_000]);
    expect(run.status).toBe('succeeded');
  });

  it('an HTTP-date already in the past means retry now', async () => {
    const t = setup();
    t.fake.script('tok', rateLimited(new Date(t.clock.now().getTime() - 10_000).toUTCString()), { kind: 'serve' });

    const run = await t.runSync(t.connection);

    expect(t.sleeper.waits).toEqual([0]);
    expect(run.status).toBe('succeeded');
  });

  it('waits when Retry-After is exactly the ceiling', async () => {
    const t = setup();
    t.fake.script('tok', rateLimited('60'), { kind: 'serve' });

    const run = await t.runSync(t.connection);

    expect(t.sleeper.waits).toEqual([60_000]);
    expect(run.status).toBe('succeeded');
  });

  it('does not wait above the ceiling: stops as rate_limited with retry_at', async () => {
    const t = setup();
    t.fake.script('tok', rateLimited('3600'));

    const run = await t.runSync(t.connection);

    expect(t.sleeper.waits).toEqual([]);
    expect(t.fake.calls).toHaveLength(1);
    expect(run).toMatchObject({ status: 'rate_limited', error_code: 'rate_limited', attempts: 1, retry_at: '2026-10-01T01:00:00.000Z' });
    expect(t.connections.get(t.connection.id)!.status).toBe('active');
  });

  it('the ceiling is configurable', async () => {
    const t = setup({ maxRetryAfterMs: 10_000 });
    t.fake.script('tok', rateLimited('11'));

    const run = await t.runSync(t.connection);

    expect(t.sleeper.waits).toEqual([]);
    expect(run.status).toBe('rate_limited');
  });

  it('resume is refused before retry_at and works after it', async () => {
    const t = setup();
    t.fake.script('tok', rateLimited('3600'));
    const limited = await t.runSync(t.connection);

    expect(() => t.sync.resume(limited.id)).toThrow(/retry_at/);
    t.clock.advance(3_600_000);
    const resumed = await t.sync.resume(limited.id).done;

    expect(resumed).toMatchObject({ status: 'succeeded', retry_at: null });
    expect(t.posts.totalsForCreator('creator_1').posts).toBe(3);
  });

  it('repeated 429 stops at the attempt ceiling as rate_limited', async () => {
    const t = setup();
    t.fake.always('tok', rateLimited('1'));

    const run = await t.runSync(t.connection);

    expect(run).toMatchObject({ status: 'rate_limited', attempts: 5 });
    expect(t.sleeper.waits).toEqual([1000, 1000, 1000, 1000]);
    expect(run.retry_at).toBe(new Date(t.clock.now().getTime() + 1000).toISOString());
  });

  it('429 and transient errors share one attempt ceiling', async () => {
    const t = setup();
    t.fake.script('tok', rateLimited('2'), { kind: 'timeout' }, rateLimited('2'), { kind: 'status', status: 500 }, { kind: 'status', status: 500 });

    const run = await t.runSync(t.connection);

    expect(run.attempts).toBe(5);
    expect(run.status).toBe('failed');
    expect(t.fake.calls).toHaveLength(5);
  });

  it('429 without a usable Retry-After falls back to backoff', async () => {
    const t = setup();
    t.fake.script('tok', rateLimited(), rateLimited('soon'), { kind: 'serve' });

    const run = await t.runSync(t.connection);

    expect(t.sleeper.waits).toEqual([500, 1000]);
    expect(run.status).toBe('succeeded');
  });

  it('no wait ever exceeds the configured ceiling', async () => {
    const t = setup();
    t.fake.script('tok', rateLimited('59'), rateLimited('60'), rateLimited('61'));

    await t.runSync(t.connection);

    expect(Math.max(...t.sleeper.waits)).toBeLessThanOrEqual(60_000);
  });
});

describe('failures that must not retry', () => {
  it('401 stops at once and marks the connection needs_reauth', async () => {
    const t = setup();
    t.fake.always('tok', { kind: 'status', status: 401 });

    const run = await t.runSync(t.connection);

    expect(run).toMatchObject({ status: 'failed', error_code: 'unauthorized', attempts: 1 });
    expect(t.sleeper.waits).toEqual([]);
    expect(t.connections.get(t.connection.id)!.status).toBe('needs_reauth');
    expect(() => t.sync.start(t.connection.id, SEPTEMBER)).toThrow(/reconnect/);
  });

  it('a 400 fails at once without marking the connection', async () => {
    const t = setup();
    t.fake.script('tok', { kind: 'status', status: 400 });

    const run = await t.runSync(t.connection);

    expect(run).toMatchObject({ status: 'failed', error_code: 'rejected', attempts: 1 });
    expect(t.connections.get(t.connection.id)!.status).toBe('active');
  });

  it('a malformed payload fails at once', async () => {
    const t = setup();
    t.fake.script('tok', { kind: 'raw', status: 200, body: { data: 'nope' } });

    const run = await t.runSync(t.connection);

    expect(run).toMatchObject({ status: 'failed', error_code: 'invalid_payload', attempts: 1 });
  });

  it('rejects a provider timestamp from the future', async () => {
    const t = setup();
    t.fake.script('tok', { kind: 'page', posts: [fakePost('p1', 3, 100, '2027-01-01T00:00:00.000Z')] });

    const run = await t.runSync(t.connection);

    expect(run).toMatchObject({ status: 'failed', error_code: 'invalid_payload' });
    expect(t.posts.totalsForCreator('creator_1').posts).toBe(0);
  });

  it('stops a provider that keeps returning a cursor it already returned', async () => {
    const t = setup();
    t.fake.always('tok', { kind: 'page', posts: [fakePost('p1', 3, 100)], nextCursor: 'same' });

    const run = await t.runSync(t.connection);

    expect(run).toMatchObject({ status: 'failed', error_code: 'cursor_loop', pages: 2 });
  });

  it('stops after maxPages even if every cursor is new', async () => {
    const t = setup({ maxPages: 3 });
    t.fake.script('tok', ...[1, 2, 3, 4].map((i) => ({ kind: 'page' as const, posts: [fakePost(`p${i}`, 3, 100)], nextCursor: `c${i}` })));

    const run = await t.runSync(t.connection);

    expect(run).toMatchObject({ status: 'failed', error_code: 'too_many_pages', pages: 3 });
  });
});

describe('one run at a time per connection', () => {
  it('refuses a second sync while one is in progress', async () => {
    const t = setup();
    let release!: () => void;
    t.fake.script('tok', { kind: 'gate', until: new Promise<void>((r) => (release = r)) });

    const first = t.sync.start(t.connection.id, SEPTEMBER);
    expect(() => t.sync.start(t.connection.id, SEPTEMBER)).toThrow(/already has a sync running/);
    release();
    expect((await first.done).status).toBe('succeeded');
    expect((await t.sync.start(t.connection.id, SEPTEMBER).done).status).toBe('succeeded');
  });

  it('marks runs left running by a crashed process as failed', async () => {
    const t = setup();
    const { run, done } = t.sync.start(t.connection.id, SEPTEMBER);
    // what the next boot does with a run the dead process left behind
    expect(t.runs.failInterrupted('2026-10-01T00:00:00.000Z')).toBe(1);
    expect(t.runs.get(run.id)).toMatchObject({ status: 'failed', error_code: 'interrupted' });
    await done;
  });
});
