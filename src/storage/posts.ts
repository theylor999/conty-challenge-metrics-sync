import { randomUUID } from 'node:crypto';
import type { Db } from '../db.ts';
import type { CurrentPostRow, PostMetrics, SnapshotRow } from '../domain/types.ts';

export interface Totals {
  posts: number;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  oldest_fetched_at: string | null;
  newest_fetched_at: string | null;
}

const TOTALS = `
  COUNT(*) AS posts,
  COALESCE(SUM(views), 0) AS views, COALESCE(SUM(likes), 0) AS likes,
  COALESCE(SUM(comments), 0) AS comments, COALESCE(SUM(shares), 0) AS shares,
  MIN(fetched_at) AS oldest_fetched_at, MAX(fetched_at) AS newest_fetched_at`;

export class PostsRepo {
  constructor(private readonly db: Db) {}

  /** Identity of a post is (connection, platform post id); seeing it again only refreshes last_seen. */
  upsertPost(connectionId: string, item: PostMetrics, now: string, runId: string): string {
    const row = this.db.get<{ id: string }>(
      `INSERT INTO posts (id, connection_id, platform_post_id, published_at, url, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (connection_id, platform_post_id)
       DO UPDATE SET last_seen_at = excluded.last_seen_at
       RETURNING id`,
      `pst_${randomUUID()}`,
      connectionId,
      item.platformPostId,
      item.publishedAt,
      item.url,
      now,
      now,
    );
    this.db.run('INSERT OR IGNORE INTO sync_run_posts (run_id, post_id) VALUES (?, ?)', runId, row!.id);
    return row!.id;
  }

  /**
   * Appends a snapshot unless it is already known. Returns false for a duplicate.
   * With a provider timestamp the UNIQUE (post_id, provider_observed_at) decides.
   * Without one, a snapshot identical to the latest is a duplicate (SQLite treats NULLs
   * as distinct, so the constraint cannot help there).
   */
  insertSnapshot(postId: string, item: PostMetrics, fetchedAt: string, runId: string): boolean {
    const { views, likes, comments, shares } = item.counters;
    if (item.observedAt === null) {
      const latest = this.db.get<Pick<SnapshotRow, 'views' | 'likes' | 'comments' | 'shares'>>(
        `SELECT views, likes, comments, shares FROM snapshots WHERE post_id = ?
         ORDER BY effective_observed_at DESC, id DESC LIMIT 1`,
        postId,
      );
      if (latest && latest.views === views && latest.likes === likes && latest.comments === comments && latest.shares === shares) {
        return false;
      }
    }
    const result = this.db.run(
      `INSERT INTO snapshots (post_id, sync_run_id, provider_observed_at, effective_observed_at, fetched_at, views, likes, comments, shares)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (post_id, provider_observed_at) DO NOTHING`,
      postId,
      runId,
      item.observedAt,
      item.observedAt ?? fetchedAt,
      fetchedAt,
      views,
      likes,
      comments,
      shares,
    );
    return result.changes === 1;
  }

  listCurrentByConnection(connectionId: string): CurrentPostRow[] {
    return this.db.all<CurrentPostRow>(
      'SELECT * FROM current_metrics WHERE connection_id = ? ORDER BY published_at DESC, platform_post_id',
      connectionId,
    );
  }

  get(postId: string): { id: string; connection_id: string; platform_post_id: string } | undefined {
    return this.db.get('SELECT id, connection_id, platform_post_id FROM posts WHERE id = ?', postId);
  }

  listSnapshots(postId: string): SnapshotRow[] {
    return this.db.all<SnapshotRow>(
      'SELECT * FROM snapshots WHERE post_id = ? ORDER BY effective_observed_at, id',
      postId,
    );
  }

  totalsForCreator(creatorId: string): Totals {
    return this.db.get<Totals>(`SELECT ${TOTALS} FROM current_metrics WHERE creator_id = ?`, creatorId)!;
  }

  totalsForConnection(connectionId: string): Totals {
    return this.db.get<Totals>(`SELECT ${TOTALS} FROM current_metrics WHERE connection_id = ?`, connectionId)!;
  }
}
