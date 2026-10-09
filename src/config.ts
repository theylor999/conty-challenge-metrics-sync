export interface SyncConfig {
  /** Ceiling of provider requests for one page, first try included; 429 and transient errors share it. */
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

/** Largest value Node timers accept; above it setTimeout silently fires after 1 ms. */
const MAX_TIMER_MS = 2 ** 31 - 1;

export function syncConfigFromEnv(env: NodeJS.ProcessEnv): SyncConfig {
  const int = (key: string, fallback: number, min: number, max: number) => {
    const raw = env[key];
    if (raw === undefined || raw === '') return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new Error(`${key} must be an integer between ${min} and ${max}`);
    }
    return value;
  };
  return {
    ...defaultSyncConfig,
    maxAttempts: int('SYNC_MAX_ATTEMPTS', defaultSyncConfig.maxAttempts, 1, 100),
    requestTimeoutMs: int('SYNC_REQUEST_TIMEOUT_MS', defaultSyncConfig.requestTimeoutMs, 1, MAX_TIMER_MS),
    maxRetryAfterMs: int('SYNC_MAX_RETRY_AFTER_MS', defaultSyncConfig.maxRetryAfterMs, 0, MAX_TIMER_MS),
  };
}
