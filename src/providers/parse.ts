import { ProviderError } from './provider.ts';

const MAX_COUNTER = 1e12;
const bad = (message: string) => new ProviderError('invalid_payload', message);

export function obj(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw bad(`${field}: expected object`);
  return value as Record<string, unknown>;
}

export function arr(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw bad(`${field}: expected array`);
  return value;
}

export function str(value: unknown, field: string): string {
  if (typeof value === 'string' && value !== '') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  throw bad(`${field}: expected non-empty string`);
}

/**
 * Counter as a non-negative integer. Accepts "123" because YouTube sends counters as strings.
 * Capped at 1e12 so that a sum over many posts stays a safe integer.
 */
export function count(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null;
  const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0 || n > MAX_COUNTER) throw bad(`${field}: expected non-negative integer`);
  return n;
}

/** ISO 8601 with offset, including the "+0000" form Instagram uses. */
export function isoTime(value: unknown, field: string): string {
  if (typeof value === 'string') {
    const normalized = value.replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
    const at = Date.parse(normalized);
    if (/[zZ]|[+-]\d{2}:\d{2}$/.test(normalized) && !Number.isNaN(at)) return new Date(at).toISOString();
  }
  throw bad(`${field}: expected ISO 8601 timestamp with offset`);
}

export function unixTime(value: unknown, field: string): string {
  if (typeof value !== 'number' || value < 0) throw bad(`${field}: expected unix seconds`);
  const at = new Date(value * 1000);
  if (Number.isNaN(at.getTime())) throw bad(`${field}: expected unix seconds`);
  return at.toISOString();
}

/** Unix seconds for APIs without sub-second ranges. The bounds are widened, never narrowed; the service filters by the exact window. */
export const toUnix = (iso: string, round: 'floor' | 'ceil' = 'floor'): string =>
  String(Math[round](Date.parse(iso) / 1000));

/** A continuation token that is absent ends the listing; one that is present but unusable is a broken page. */
export function optionalToken(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw bad(`${field}: expected string`);
  return value;
}
