import { bearer, callProvider } from '../http.ts';
import { arr, count, isoTime, obj, str } from '../parse.ts';
import type { MetricsProvider } from '../provider.ts';
import type { AdapterDeps } from './deps.ts';

export function xProvider({ fetch, clock }: AdapterDeps): MetricsProvider {
  return {
    platform: 'x',
    async fetchPage(req) {
      const query: Record<string, string> = { start_time: req.from, end_time: req.to };
      if (req.cursor) query.pagination_token = req.cursor;
      const body = await callProvider(
        fetch,
        clock,
        { path: `/x/2/users/${encodeURIComponent(req.accountId)}/tweets`, query, headers: bearer(req) },
        req.signal,
      );

      const root = obj(body, 'response');
      const posts = arr(root.data ?? [], 'data').map((raw, i) => {
        const tweet = obj(raw, `data[${i}]`);
        const id = str(tweet.id, 'id');
        const m = obj(tweet.public_metrics, 'public_metrics');
        const retweets = count(m.retweet_count, 'retweet_count');
        const quotes = count(m.quote_count, 'quote_count');
        return {
          platformPostId: id,
          publishedAt: isoTime(tweet.created_at, 'created_at'),
          url: `https://x.com/i/status/${id}`,
          observedAt: null, // public_metrics carry no timestamp
          counters: {
            views: count(m.impression_count, 'impression_count'),
            likes: count(m.like_count, 'like_count'),
            comments: count(m.reply_count, 'reply_count'),
            shares: retweets === null && quotes === null ? null : (retweets ?? 0) + (quotes ?? 0),
          },
        };
      });

      const meta = root.meta === undefined ? {} : obj(root.meta, 'meta');
      return { posts, nextCursor: typeof meta.next_token === 'string' ? meta.next_token : null };
    },
  };
}
