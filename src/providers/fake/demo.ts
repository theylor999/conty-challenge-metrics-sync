import type { Platform } from '../../domain/types.ts';
import type { FakePost } from './dialects.ts';
import { FakeProvider, rateLimited } from './fake-provider.ts';

const day = (n: number) => `2026-09-${String(n).padStart(2, '0')}T12:00:00.000Z`;
const OBSERVED = '2026-10-08T23:00:00.000Z';

function posts(prefix: string, days: number[], base: number): FakePost[] {
  return days.map((d, i) => ({
    id: `${prefix}${d}`,
    publishedAt: day(d),
    counters: {
      views: base * (i + 2),
      likes: Math.round((base * (i + 2)) / 12),
      comments: Math.round((base * (i + 2)) / 90),
      shares: Math.round((base * (i + 2)) / 150),
    },
    observedAt: OBSERVED,
  }));
}

/** Accounts and tokens the dev server exposes. See README for the curl walkthrough. */
export function seedDemo(fake: FakeProvider): void {
  const days = [2, 5, 8, 11, 14, 17, 20, 23];
  const accounts: Record<Platform, [string, string, number]> = {
    instagram: ['ig_ana', 'ig', 4000],
    tiktok: ['tt_ana', 'tt', 9000],
    youtube: ['yt_ana', 'yt', 2500],
    x: ['x_ana', 'x', 1200],
  };
  for (const [platform, [account, prefix, base]] of Object.entries(accounts) as [Platform, [string, string, number]][]) {
    fake.seed(platform, account, posts(prefix, days, base));
  }

  // First call answers 429 with Retry-After: 2, then the token behaves normally.
  fake.script('demo-flaky', rateLimited('2'));
  // Always 429 with a one hour Retry-After, above the default ceiling.
  fake.always('demo-ratelimited', rateLimited('3600'));
  fake.always('demo-revoked', { kind: 'status', status: 401 });
}
