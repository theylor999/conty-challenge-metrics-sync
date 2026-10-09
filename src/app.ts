import { Hono } from 'hono';
import type { Clock } from './clock.ts';
import { isRealDate } from './dates.ts';
import { AppError } from './errors.ts';
import { PLATFORMS, type ConnectionRow, type Platform, type SyncWindow } from './domain/types.ts';
import type { SyncService } from './domain/sync-service.ts';
import type { ConnectionsRepo } from './storage/connections.ts';
import type { PostsRepo } from './storage/posts.ts';
import type { SyncRunsRepo } from './storage/sync-runs.ts';

export interface AppDeps {
  connections: ConnectionsRepo;
  posts: PostsRepo;
  runs: SyncRunsRepo;
  sync: SyncService;
  clock: Clock;
}

const ISO_INPUT = /^(\d{4})-(\d{2})-(\d{2})(T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d+)?)?(Z|[+-]([01]\d|2[0-3]):[0-5]\d))?$/;

export function createApp({ connections, posts, runs, sync, clock }: AppDeps): Hono {
  const app = new Hono();

  app.onError((error, c) => {
    if (error instanceof AppError) {
      return c.json({ error: { code: error.code, message: error.message, ...error.details } }, error.status);
    }
    console.error(error);
    return c.json({ error: { code: 'internal', message: 'internal error' } }, 500);
  });
  app.notFound((c) => c.json({ error: { code: 'not_found', message: 'route not found' } }, 404));

  app.post('/connections', async (c) => {
    const body = await readBody(c.req.raw);
    const input = {
      creatorId: text(body, 'creator_id'),
      platform: platform(body.platform),
      accountId: text(body, 'account_id'),
      accessToken: text(body, 'access_token'),
    };
    const now = clock.now().toISOString();
    const existing = connections.findByAccount(input.platform, input.accountId);
    if (existing) {
      if (existing.creator_id !== input.creatorId) {
        throw new AppError(409, 'account_taken', 'this account is connected to another creator');
      }
      connections.renewToken(existing.id, input.accessToken, now);
      return c.json(publicConnection(connections.get(existing.id)!, runs), 200);
    }
    return c.json(publicConnection(connections.create(input, now), runs), 201);
  });

  app.get('/connections/:id', (c) => c.json(publicConnection(mustGetConnection(connections, c.req.param('id')), runs)));

  app.post('/connections/:id/sync', async (c) => {
    const body = await readBody(c.req.raw);
    const { run, done } = sync.start(c.req.param('id'), window(body));
    if (c.req.query('async') === 'true') return c.json(run, 202);
    return c.json(await done);
  });

  app.get('/connections/:id/sync-runs', (c) => {
    const connection = mustGetConnection(connections, c.req.param('id'));
    return c.json({ connection_id: connection.id, sync_runs: runs.listByConnection(connection.id) });
  });

  app.get('/sync-runs/:id', (c) => {
    const run = runs.get(c.req.param('id'));
    if (!run) throw new AppError(404, 'sync_run_not_found', 'sync run not found');
    return c.json(run);
  });

  app.post('/sync-runs/:id/resume', async (c) => {
    const { run, done } = sync.resume(c.req.param('id'));
    if (c.req.query('async') === 'true') return c.json(run, 202);
    return c.json(await done);
  });

  app.get('/connections/:id/posts', (c) => {
    const connection = mustGetConnection(connections, c.req.param('id'));
    return c.json({
      connection_id: connection.id,
      platform: connection.platform,
      connection_status: connection.status,
      posts: posts.listCurrentByConnection(connection.id).map((p) => ({
        id: p.post_id,
        platform_post_id: p.platform_post_id,
        url: p.url,
        published_at: p.published_at,
        metrics: { views: p.views, likes: p.likes, comments: p.comments, shares: p.shares },
        provider_observed_at: p.provider_observed_at,
        fetched_at: p.fetched_at,
        last_checked_at: p.last_seen_at,
      })),
    });
  });

  app.get('/posts/:id/snapshots', (c) => {
    const post = posts.get(c.req.param('id'));
    if (!post) throw new AppError(404, 'post_not_found', 'post not found');
    return c.json({
      post_id: post.id,
      snapshots: posts.listSnapshots(post.id).map((s) => ({
        provider_observed_at: s.provider_observed_at,
        fetched_at: s.fetched_at,
        sync_run_id: s.sync_run_id,
        metrics: { views: s.views, likes: s.likes, comments: s.comments, shares: s.shares },
      })),
    });
  });

  app.get('/creators/:id/metrics', (c) => {
    const creatorId = c.req.param('id');
    const list = connections.listByCreator(creatorId);
    if (list.length === 0) throw new AppError(404, 'creator_not_found', 'creator has no connections');
    const { posts: postCount, ...totals } = posts.totalsForCreator(creatorId);
    return c.json({
      creator_id: creatorId,
      posts: postCount,
      totals: { views: totals.views, likes: totals.likes, comments: totals.comments, shares: totals.shares },
      oldest_fetched_at: totals.oldest_fetched_at,
      newest_fetched_at: totals.newest_fetched_at,
      connections: list.map((connection) => {
        const t = posts.totalsForConnection(connection.id);
        return {
          connection_id: connection.id,
          platform: connection.platform,
          status: connection.status,
          last_successful_sync_at: runs.lastSucceededAt(connection.id),
          posts: t.posts,
          views: t.views,
          likes: t.likes,
          comments: t.comments,
          shares: t.shares,
        };
      }),
    });
  });

  return app;
}

function publicConnection(connection: ConnectionRow, runs: SyncRunsRepo) {
  const { access_token: _token, ...rest } = connection;
  return { ...rest, last_successful_sync_at: runs.lastSucceededAt(connection.id) };
}

function mustGetConnection(connections: ConnectionsRepo, id: string): ConnectionRow {
  const connection = connections.get(id);
  if (!connection) throw new AppError(404, 'connection_not_found', 'connection not found');
  return connection;
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new AppError(400, 'invalid_json', 'request body must be JSON');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new AppError(400, 'invalid_body', 'request body must be a JSON object');
  }
  return body as Record<string, unknown>;
}

function text(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || value.trim() === '' || value.length > 300) {
    throw new AppError(400, 'invalid_field', `${field} must be a non-empty string`, { field });
  }
  return value.trim();
}

function platform(value: unknown): Platform {
  if (typeof value === 'string' && (PLATFORMS as readonly string[]).includes(value)) return value as Platform;
  throw new AppError(400, 'invalid_field', `platform must be one of ${PLATFORMS.join(', ')}`, { field: 'platform' });
}

/** Window is [from, to): a post published exactly at `to` belongs to the next window. */
function window(body: Record<string, unknown>): SyncWindow {
  const parse = (field: 'from' | 'to') => {
    const value = body[field];
    const match = typeof value === 'string' ? ISO_INPUT.exec(value) : null;
    const real = match !== null && isRealDate(Number(match[1]), Number(match[2]), Number(match[3]));
    const at = real ? Date.parse(value as string) : NaN;
    if (Number.isNaN(at)) {
      throw new AppError(400, 'invalid_field', `${field} must be an ISO 8601 date or datetime with offset`, { field });
    }
    return new Date(at).toISOString();
  };
  const from = parse('from');
  const to = parse('to');
  if (from >= to) throw new AppError(400, 'invalid_window', 'from must be before to');
  return { from, to };
}
