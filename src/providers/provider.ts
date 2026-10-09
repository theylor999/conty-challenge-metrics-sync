import type { MetricsPage, Platform } from '../domain/types.ts';

export type ProviderErrorKind =
  | 'timeout'
  | 'network'
  | 'server'
  | 'rate_limited'
  | 'unauthorized'
  | 'rejected'
  | 'invalid_payload';

export class ProviderError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
  }
}

/** Minimal HTTP shape the adapters speak. Header names are lower case. */
export interface RawRequest {
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
}

export interface RawResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export type RawFetch = (request: RawRequest, signal: AbortSignal) => Promise<RawResponse>;

export interface PageRequest {
  accountId: string;
  accessToken: string;
  from: string;
  to: string;
  cursor: string | null;
  signal: AbortSignal;
}

/**
 * One implementation per platform. Throws ProviderError for every failure,
 * returns normalized metrics otherwise.
 */
export interface MetricsProvider {
  readonly platform: Platform;
  fetchPage(request: PageRequest): Promise<MetricsPage>;
}

export type MetricsProviders = Record<Platform, MetricsProvider>;
