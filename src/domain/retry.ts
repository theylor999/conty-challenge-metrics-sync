import type { SyncConfig } from '../config.ts';

/**
 * Delay after the n-th failed attempt (n starts at 1): base * 2^(n-1), capped,
 * then shortened by up to jitterRatio. random() is injected so tests are exact.
 */
export function backoffDelayMs(attempt: number, config: SyncConfig, random: () => number): number {
  const exponential = Math.min(config.maxBackoffMs, config.baseBackoffMs * 2 ** (attempt - 1));
  return Math.round(exponential * (1 - config.jitterRatio * random()));
}
