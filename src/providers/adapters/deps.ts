import type { Clock } from '../../clock.ts';
import type { RawFetch } from '../provider.ts';

export interface AdapterDeps {
  fetch: RawFetch;
  clock: Clock;
}
