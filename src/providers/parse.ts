import { ProviderError } from './provider.ts';

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

/** Counter as a non-negative integer. Accepts "123" because YouTube sends counters as strings. */
export function count(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null;
  const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) throw bad(`${field}: expected non-negative integer`);
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
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw bad(`${field}: expected unix seconds`);
  return new Date(value * 1000).toISOString();
}

export const toUnix = (iso: string): string => String(Math.floor(Date.parse(iso) / 1000));
