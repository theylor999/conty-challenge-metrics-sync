import { bearer, callProvider } from '../http.ts';
import { arr, count, isoTime, obj, str } from '../parse.ts';
import type { MetricsProvider } from '../provider.ts';
import type { AdapterDeps } from './deps.ts';

export function youtubeProvider({ fetch, clock }: AdapterDeps): MetricsProvider {
  return {
    platform: 'youtube',
    async fetchPage(req) {
      const query: Record<string, string> = {
        channelId: req.accountId,
        publishedAfter: req.from,
        publishedBefore: req.to,
      };
      if (req.cursor) query.pageToken = req.cursor;
      const body = await callProvider(
        fetch,
        clock,
        { path: '/youtube/v3/videos', query, headers: bearer(req) },
        req.signal,
      );

      const root = obj(body, 'response');
      const posts = arr(root.items, 'items').map((raw, i) => {
        const item = obj(raw, `items[${i}]`);
        const id = str(item.id, 'id');
        const stats = obj(item.statistics, 'statistics');
        return {
          platformPostId: id,
          publishedAt: isoTime(obj(item.snippet, 'snippet').publishedAt, 'snippet.publishedAt'),
          url: `https://www.youtube.com/watch?v=${id}`,
          observedAt: null, // the API does not say when the counters were computed
          counters: {
            views: count(stats.viewCount, 'viewCount'),
            likes: count(stats.likeCount, 'likeCount'),
            comments: count(stats.commentCount, 'commentCount'),
            shares: null, // not exposed
          },
        };
      });

      return { posts, nextCursor: typeof root.nextPageToken === 'string' ? root.nextPageToken : null };
    },
  };
}
