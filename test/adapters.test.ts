import { describe, expect, it } from 'vitest';
import { parseRetryAfter } from '../src/providers/http.ts';
import { dialects, type FakePost } from '../src/providers/fake/dialects.ts';
import { createProviders } from '../src/providers/adapters/index.ts';
import { FakeProvider } from '../src/providers/fake/fake-provider.ts';
import type { Platform } from '../src/domain/types.ts';
import { FakeClock, NOW } from './support/harness.ts';

const post: FakePost = {
  id: '77',
  publishedAt: '2026-09-03T12:00:00.000Z',
  url: 'https://example.test/77',
  counters: { views: 1200, likes: 80, comments: 5, shares: 3 },
  observedAt: '2026-09-30T08:00:00.000Z',
};

async function fetchOne(platform: Platform) {
  const fake = new FakeProvider();
  fake.seed(platform, 'acct', [post]);
  const providers = createProviders({ fetch: fake.fetch, clock: new FakeClock(NOW) });
  return providers[platform].fetchPage({
    accountId: 'acct',
    accessToken: 't',
    from: '2026-09-01T00:00:00.000Z',
    to: '2026-10-01T00:00:00.000Z',
    cursor: null,
    signal: AbortSignal.timeout(1000),
  });
}

describe('adapters hide each platform shape', () => {
  it('instagram: play_count -> views, "+0000" timestamps, per-item observed time', async () => {
    const page = await fetchOne('instagram');
    expect(page).toEqual({
      nextCursor: null,
      posts: [
        {
          platformPostId: '77',
          publishedAt: '2026-09-03T12:00:00.000Z',
          url: 'https://example.test/77',
          observedAt: '2026-09-30T08:00:00.000Z',
          counters: { views: 1200, likes: 80, comments: 5, shares: 3 },
        },
      ],
    });
  });

  it('tiktok: view_count and unix times', async () => {
    const [p] = (await fetchOne('tiktok')).posts;
    expect(p).toMatchObject({
      publishedAt: '2026-09-03T12:00:00.000Z',
      observedAt: '2026-09-30T08:00:00.000Z',
      counters: { views: 1200, likes: 80, comments: 5, shares: 3 },
    });
  });

  it('youtube: string counters become numbers, shares are null, no observed time', async () => {
    const [p] = (await fetchOne('youtube')).posts;
    expect(p).toMatchObject({
      url: 'https://www.youtube.com/watch?v=77',
      observedAt: null,
      counters: { views: 1200, likes: 80, comments: 5, shares: null },
    });
  });

  it('x: impression_count -> views, retweets+quotes -> shares, no observed time', async () => {
    const [p] = (await fetchOne('x')).posts;
    expect(p).toMatchObject({ observedAt: null, counters: { views: 1200, likes: 80, comments: 5, shares: 3 } });
  });

  it('no raw field name leaks into the normalized post', async () => {
    for (const platform of Object.keys(dialects) as Platform[]) {
      const [p] = (await fetchOne(platform)).posts;
      expect(Object.keys(p!).sort()).toEqual(['counters', 'observedAt', 'platformPostId', 'publishedAt', 'url']);
      expect(Object.keys(p!.counters).sort()).toEqual(['comments', 'likes', 'shares', 'views']);
    }
  });
});

describe('parseRetryAfter', () => {
  const now = Date.parse(NOW);

  it('reads delta-seconds', () => {
    expect(parseRetryAfter('30', now)).toBe(30_000);
    expect(parseRetryAfter(' 0 ', now)).toBe(0);
  });

  it('reads an HTTP-date relative to now, never negative', () => {
    expect(parseRetryAfter(new Date(now + 90_000).toUTCString(), now)).toBe(90_000);
    expect(parseRetryAfter(new Date(now - 90_000).toUTCString(), now)).toBe(0);
  });

  it('returns null for anything else', () => {
    for (const value of [undefined, '', 'soon', '-5', '1.5', '2026-10-01T00:00:30Z', 'Thu 1 Oct 2026']) {
      expect(parseRetryAfter(value, now)).toBeNull();
    }
  });
});
