import type { Clock } from '../clock.ts';
import { ProviderError, type PageRequest, type RawFetch, type RawRequest } from './provider.ts';

const HTTP_DATE = /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/**
 * Retry-After is either delta-seconds or an HTTP-date (IMF-fixdate).
 * Returns milliseconds to wait, or null if the value is absent or unusable.
 */
export function parseRetryAfter(value: string | undefined, nowMs: number): number | null {
  if (value === undefined) return null;
  const text = value.trim();
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  if (HTTP_DATE.test(text)) {
    const at = Date.parse(text);
    if (!Number.isNaN(at)) return Math.max(0, at - nowMs);
  }
  return null;
}

export function bearer(request: PageRequest): Record<string, string> {
  return { authorization: `Bearer ${request.accessToken}` };
}

/** Runs one provider call and turns transport and HTTP failures into ProviderError. */
export async function callProvider(
  fetch: RawFetch,
  clock: Clock,
  request: RawRequest,
  signal: AbortSignal,
): Promise<unknown> {
  let response;
  try {
    response = await fetch(request, signal);
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    if (signal.aborted || name === 'TimeoutError' || name === 'AbortError') {
      throw new ProviderError('timeout', 'request timed out');
    }
    throw new ProviderError('network', error instanceof Error ? error.message : 'network error');
  }

  const { status } = response;
  if (status >= 200 && status < 300) return response.body;
  if (status === 401) throw new ProviderError('unauthorized', 'provider rejected the access token (401)');
  if (status === 429) {
    const wait = parseRetryAfter(response.headers['retry-after'], clock.now().getTime());
    throw new ProviderError('rate_limited', 'provider rate limit (429)', wait);
  }
  if (status === 408) throw new ProviderError('timeout', 'provider timed out (408)');
  if (status >= 500) throw new ProviderError('server', `provider error (${status})`);
  throw new ProviderError('rejected', `provider rejected the request (${status})`);
}
