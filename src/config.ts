export interface SyncConfig {
  /** Ceiling of provider requests in one execution, first try included, 429 and transient errors together. */
  maxAttempts: number;
  requestTimeoutMs: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
  /** Backoff is shortened by up to this fraction, so the maximum delay is never exceeded. */
  jitterRatio: number;
  /** Retry-After above this is never waited: the run stops as rate_limited with retry_at. */
  maxRetryAfterMs: number;
  /** Guard against a provider that keeps returning new cursors. */
  maxPages: number;
  /** A provider timestamp further in the future than this is rejected. */
  maxClockSkewMs: number;
}

export const defaultSyncConfig: SyncConfig = {
  maxAttempts: 5,
  requestTimeoutMs: 10_000,
  baseBackoffMs: 500,
  maxBackoffMs: 8_000,
  jitterRatio: 0.2,
  maxRetryAfterMs: 60_000,
  maxPages: 200,
  maxClockSkewMs: 5 * 60_000,
};

export function syncConfigFromEnv(env: NodeJS.ProcessEnv): SyncConfig {
  const num = (key: string, fallback: number) => {
    const raw = env[key];
    if (raw === undefined || raw === '') return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) throw new Error(`${key} must be a non-negative number`);
    return value;
  };
  return {
    ...defaultSyncConfig,
    maxAttempts: Math.max(1, num('SYNC_MAX_ATTEMPTS', defaultSyncConfig.maxAttempts)),
    requestTimeoutMs: num('SYNC_REQUEST_TIMEOUT_MS', defaultSyncConfig.requestTimeoutMs),
    maxRetryAfterMs: num('SYNC_MAX_RETRY_AFTER_MS', defaultSyncConfig.maxRetryAfterMs),
  };
}
