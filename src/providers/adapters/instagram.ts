import { bearer, callProvider } from '../http.ts';
import { arr, count, isoTime, obj, optionalToken, str, toUnix } from '../parse.ts';
import type { MetricsProvider } from '../provider.ts';
import type { AdapterDeps } from './deps.ts';

export function instagramProvider({ fetch, clock }: AdapterDeps): MetricsProvider {
  return {
    platform: 'instagram',
    async fetchPage(req) {
      const query: Record<string, string> = { since: toUnix(req.from), until: toUnix(req.to, 'ceil') };
      if (req.cursor) query.after = req.cursor;
      const body = await callProvider(
        fetch,
        clock,
        { path: `/instagram/v21.0/${encodeURIComponent(req.accountId)}/media`, query, headers: bearer(req) },
        req.signal,
      );

      const root = obj(body, 'response');
      const posts = arr(root.data, 'data').map((raw, i) => {
        const item = obj(raw, `data[${i}]`);
        return {
          platformPostId: str(item.id, 'id'),
          publishedAt: isoTime(item.timestamp, 'timestamp'),
          url: typeof item.permalink === 'string' ? item.permalink : null,
          observedAt: isoTime(item.insights_updated_time, 'insights_updated_time'),
          counters: {
            views: count(item.play_count, 'play_count'),
            likes: count(item.like_count, 'like_count'),
            comments: count(item.comments_count, 'comments_count'),
            shares: count(item.shares, 'shares'),
          },
        };
      });

      const paging = root.paging === undefined ? null : obj(root.paging, 'paging');
      const hasNext = optionalToken(paging?.next, 'paging.next') !== null;
      const nextCursor = hasNext ? str(obj(paging?.cursors, 'paging.cursors').after, 'paging.cursors.after') : null;
      return { posts, nextCursor };
    },
  };
}
