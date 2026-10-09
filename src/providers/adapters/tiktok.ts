import { bearer, callProvider } from '../http.ts';
import { arr, count, obj, str, toUnix, unixTime } from '../parse.ts';
import type { MetricsProvider } from '../provider.ts';
import type { AdapterDeps } from './deps.ts';

export function tiktokProvider({ fetch, clock }: AdapterDeps): MetricsProvider {
  return {
    platform: 'tiktok',
    async fetchPage(req) {
      const query: Record<string, string> = {
        open_id: req.accountId,
        start_time: toUnix(req.from),
        end_time: toUnix(req.to),
      };
      if (req.cursor) query.cursor = req.cursor;
      const body = await callProvider(
        fetch,
        clock,
        { path: '/tiktok/v2/video/list', query, headers: bearer(req) },
        req.signal,
      );

      const data = obj(obj(body, 'response').data, 'data');
      const posts = arr(data.videos, 'videos').map((raw, i) => {
        const video = obj(raw, `videos[${i}]`);
        return {
          platformPostId: str(video.id, 'id'),
          publishedAt: unixTime(video.create_time, 'create_time'),
          url: typeof video.share_url === 'string' ? video.share_url : null,
          observedAt: unixTime(video.stats_time, 'stats_time'),
          counters: {
            views: count(video.view_count, 'view_count'),
            likes: count(video.like_count, 'like_count'),
            comments: count(video.comment_count, 'comment_count'),
            shares: count(video.share_count, 'share_count'),
          },
        };
      });

      return { posts, nextCursor: data.has_more === true ? str(data.cursor, 'cursor') : null };
    },
  };
}
