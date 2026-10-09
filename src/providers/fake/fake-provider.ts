import type { Counters, Platform } from '../../domain/types.ts';
import type { RawFetch, RawRequest, RawResponse } from '../provider.ts';
import { dialects, platformOf, type FakePost } from './dialects.ts';

/**
 * What the fake does on one call. Without a step it serves the seeded data,
 * filtered by window and paginated by cursor.
 */
export type FakeStep =
  | { kind: 'serve' }
  | { kind: 'page'; posts: FakePost[]; nextCursor?: string | null }
  | { kind: 'status'; status: number; headers?: Record<string, string> }
  | { kind: 'raw'; status: number; body: unknown; headers?: Record<string, string> }
  | { kind: 'timeout' }
  | { kind: 'hang' }
  | { kind: 'network' }
  | { kind: 'gate'; until: Promise<void> };

export interface FakeCall {
  platform: Platform;
  token: string;
  cursor: string | null;
}

export const rateLimited = (retryAfter?: string): FakeStep => ({
  kind: 'status',
  status: 429,
  headers: retryAfter === undefined ? {} : { 'retry-after': retryAfter },
});

export class FakeProvider {
  readonly calls: FakeCall[] = [];
  readonly #data = new Map<string, FakePost[]>();
  readonly #queues = new Map<string, FakeStep[]>();
  readonly #fallbacks = new Map<string, FakeStep>();
  readonly #pageSize: number;

  constructor(options: { pageSize?: number } = {}) {
    this.#pageSize = options.pageSize ?? 3;
  }

  seed(platform: Platform, accountId: string, posts: FakePost[]): void {
    this.#data.set(`${platform}:${accountId}`, [...posts]);
  }

  /** Changes counters the way a real platform would between two syncs. */
  update(platform: Platform, accountId: string, postId: string, counters: Partial<Counters>, observedAt: string): void {
    const post = this.#data.get(`${platform}:${accountId}`)?.find((p) => p.id === postId);
    if (!post) throw new Error(`unknown fake post ${postId}`);
    post.counters = { ...post.counters, ...counters };
    post.observedAt = observedAt;
  }

  /** Steps are consumed one per call for this token, in order. */
  script(token: string, ...steps: FakeStep[]): void {
    this.#queues.set(token, [...(this.#queues.get(token) ?? []), ...steps]);
  }

  /** Behaviour of every call for this token once its script is empty. */
  always(token: string, step: FakeStep): void {
    this.#fallbacks.set(token, step);
  }

  readonly fetch: RawFetch = async (request, signal) => {
    const platform = platformOf(request.path);
    if (!platform) return json(404, { error: 'unknown route' });
    const token = (request.headers.authorization ?? '').replace(/^Bearer /, '');
    const dialect = dialects[platform];
    this.calls.push({ platform, token, cursor: dialect.decode(request).cursor });

    const step = this.#queues.get(token)?.shift() ?? this.#fallbacks.get(token) ?? { kind: 'serve' };
    switch (step.kind) {
      case 'serve':
        return this.#serve(platform, request);
      case 'gate':
        await step.until;
        return this.#serve(platform, request);
      case 'page':
        return json(200, dialect.encode(step.posts, step.nextCursor ?? null));
      case 'status':
        return { status: step.status, headers: step.headers ?? {}, body: { error: `status ${step.status}` } };
      case 'raw':
        return { status: step.status, headers: step.headers ?? {}, body: step.body };
      case 'timeout':
        throw new DOMException('The operation timed out.', 'TimeoutError');
      case 'network':
        throw new TypeError('fetch failed');
      case 'hang':
        return new Promise<RawResponse>((_, reject) => {
          if (signal.aborted) return reject(signal.reason);
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
    }
  };

  #serve(platform: Platform, request: RawRequest): RawResponse {
    const dialect = dialects[platform];
    const { accountId, from, to, cursor } = dialect.decode(request);
    const all = this.#data.get(`${platform}:${accountId}`);
    if (!all) return json(404, { error: 'unknown account' });

    const inWindow = all
      .filter((p) => p.publishedAt >= from && p.publishedAt < to)
      .sort((a, b) => a.publishedAt.localeCompare(b.publishedAt) || a.id.localeCompare(b.id));
    const offset = cursor === null ? 0 : Number(cursor);
    const end = offset + this.#pageSize;
    return json(200, dialect.encode(inWindow.slice(offset, end), end < inWindow.length ? String(end) : null));
  }
}

function json(status: number, body: unknown): RawResponse {
  return { status, headers: {}, body };
}
