import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { realSleeper, systemClock } from './clock.ts';
import { syncConfigFromEnv } from './config.ts';
import { Db } from './db.ts';
import { SyncService } from './domain/sync-service.ts';
import { createProviders } from './providers/adapters/index.ts';
import { seedDemo } from './providers/fake/demo.ts';
import { FakeProvider } from './providers/fake/fake-provider.ts';
import { ConnectionsRepo } from './storage/connections.ts';
import { PostsRepo } from './storage/posts.ts';
import { SyncRunsRepo } from './storage/sync-runs.ts';

const db = new Db(process.env.DB_PATH ?? ':memory:');
const connections = new ConnectionsRepo(db);
const posts = new PostsRepo(db);
const runs = new SyncRunsRepo(db);

const interrupted = runs.failInterrupted(systemClock.now().toISOString());
if (interrupted > 0) console.log(`marked ${interrupted} interrupted sync run(s) as failed`);

const fake = new FakeProvider({ pageSize: 3 });
seedDemo(fake);

const sync = new SyncService({
  db,
  connections,
  posts,
  runs,
  providers: createProviders({ fetch: fake.fetch, clock: systemClock }),
  clock: systemClock,
  sleeper: realSleeper,
  config: syncConfigFromEnv(process.env),
});

const app = createApp({ connections, posts, runs, sync, clock: systemClock });
const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port }, () => console.log(`metrics-sync listening on http://localhost:${port} (fake provider)`));
