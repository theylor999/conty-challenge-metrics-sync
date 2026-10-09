import type { Counters, Platform } from '../../domain/types.ts';
import type { RawRequest } from '../provider.ts';

/** A post as the fake provider's database holds it. */
export interface FakePost {
  id: string;
  publishedAt: string;
  url?: string;
  counters: Counters;
  /** When the provider computed the counters. Platforms that report it put it in the payload. */
  observedAt: string;
}

export interface Decoded {
  accountId: string;
  from: string;
  to: string;
  cursor: string | null;
}

/** How one platform's fake API reads a request and shapes its payload. */
export interface Dialect {
  decode(request: RawRequest): Decoded;
  encode(posts: FakePost[], nextCursor: string | null): unknown;
}

const iso = (seconds: string) => new Date(Number(seconds) * 1000).toISOString();
const unix = (isoTime: string) => Math.floor(Date.parse(isoTime) / 1000);
const instagramTime = (isoTime: string) => isoTime.replace(/\.\d{3}Z$/, '+0000');

const instagram: Dialect = {
  decode: (r) => ({
    accountId: decodeURIComponent(r.path.split('/')[3] ?? ''),
    from: iso(r.query.since ?? '0'),
    to: iso(r.query.until ?? '0'),
    cursor: r.query.after ?? null,
  }),
  encode: (posts, next) => ({
    data: posts.map((p) => ({
      id: p.id,
      timestamp: instagramTime(p.publishedAt),
      permalink: p.url,
      like_count: p.counters.likes,
      comments_count: p.counters.comments,
      play_count: p.counters.views,
      shares: p.counters.shares,
      insights_updated_time: instagramTime(p.observedAt),
    })),
    paging: next ? { cursors: { after: next }, next: `https://graph.example/next?after=${next}` } : { cursors: {} },
  }),
};

const tiktok: Dialect = {
  decode: (r) => ({
    accountId: r.query.open_id ?? '',
    from: iso(r.query.start_time ?? '0'),
    to: iso(r.query.end_time ?? '0'),
    cursor: r.query.cursor ?? null,
  }),
  encode: (posts, next) => ({
    data: {
      videos: posts.map((p) => ({
        id: p.id,
        create_time: unix(p.publishedAt),
        share_url: p.url,
        view_count: p.counters.views,
        like_count: p.counters.likes,
        comment_count: p.counters.comments,
        share_count: p.counters.shares,
        stats_time: unix(p.observedAt),
      })),
      cursor: next === null ? 0 : Number(next),
      has_more: next !== null,
    },
    error: { code: 'ok' },
  }),
};

const youtube: Dialect = {
  decode: (r) => ({
    accountId: r.query.channelId ?? '',
    from: r.query.publishedAfter ?? '',
    to: r.query.publishedBefore ?? '',
    cursor: r.query.pageToken ?? null,
  }),
  encode: (posts, next) => ({
    kind: 'youtube#videoListResponse',
    items: posts.map((p) => ({
      id: p.id,
      snippet: { publishedAt: p.publishedAt },
      statistics: {
        viewCount: p.counters.views === null ? undefined : String(p.counters.views),
        likeCount: p.counters.likes === null ? undefined : String(p.counters.likes),
        commentCount: p.counters.comments === null ? undefined : String(p.counters.comments),
      },
    })),
    ...(next ? { nextPageToken: next } : {}),
  }),
};

const x: Dialect = {
  decode: (r) => ({
    accountId: decodeURIComponent(r.path.split('/')[4] ?? ''),
    from: r.query.start_time ?? '',
    to: r.query.end_time ?? '',
    cursor: r.query.pagination_token ?? null,
  }),
  encode: (posts, next) => ({
    data: posts.map((p) => ({
      id: p.id,
      created_at: p.publishedAt,
      public_metrics: {
        impression_count: p.counters.views,
        like_count: p.counters.likes,
        reply_count: p.counters.comments,
        retweet_count: p.counters.shares,
        quote_count: 0,
      },
    })),
    meta: { result_count: posts.length, ...(next ? { next_token: next } : {}) },
  }),
};

export const dialects: Record<Platform, Dialect> = { instagram, tiktok, youtube, x };

export function platformOf(path: string): Platform | null {
  const first = path.split('/')[1];
  return first !== undefined && first in dialects ? (first as Platform) : null;
}
