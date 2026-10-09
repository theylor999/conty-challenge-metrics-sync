import type { MetricsProviders } from '../provider.ts';
import type { AdapterDeps } from './deps.ts';
import { instagramProvider } from './instagram.ts';
import { tiktokProvider } from './tiktok.ts';
import { xProvider } from './x.ts';
import { youtubeProvider } from './youtube.ts';

export function createProviders(deps: AdapterDeps): MetricsProviders {
  return {
    instagram: instagramProvider(deps),
    tiktok: tiktokProvider(deps),
    youtube: youtubeProvider(deps),
    x: xProvider(deps),
  };
}
