export const PLATFORMS = ['instagram', 'tiktok', 'youtube', 'x'] as const;
export type Platform = (typeof PLATFORMS)[number];

/** Absolute counters. null means the platform does not expose that counter. */
export interface Counters {
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
}

/** What every adapter returns. Raw provider field names never go past this shape. */
export interface PostMetrics {
  platformPostId: string;
  publishedAt: string;
  url: string | null;
  /** When the provider says the counters were true. null if the provider gives no timestamp. */
  observedAt: string | null;
  counters: Counters;
}

export interface MetricsPage {
  posts: PostMetrics[];
  nextCursor: string | null;
}

export interface SyncWindow {
  from: string;
  to: string;
}

export type ConnectionStatus = 'active' | 'needs_reauth';

export interface ConnectionRow {
  id: string;
  creator_id: string;
  platform: Platform;
  account_id: string;
  access_token: string;
  status: ConnectionStatus;
  created_at: string;
  updated_at: string;
}

export type SyncRunStatus = 'running' | 'succeeded' | 'failed' | 'rate_limited';

export interface SyncRunRow {
  id: string;
  connection_id: string;
  window_from: string;
  window_to: string;
  status: SyncRunStatus;
  attempts: number;
  pages: number;
  posts_upserted: number;
  snapshots_inserted: number;
  duplicates_skipped: number;
  next_cursor: string | null;
  retry_at: string | null;
  error_code: string | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

export interface CurrentPostRow {
  post_id: string;
  connection_id: string;
  creator_id: string;
  platform: Platform;
  platform_post_id: string;
  url: string | null;
  published_at: string;
  last_seen_at: string;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  provider_observed_at: string | null;
  fetched_at: string;
}

export interface SnapshotRow {
  id: number;
  post_id: string;
  sync_run_id: string;
  provider_observed_at: string | null;
  fetched_at: string;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
}
