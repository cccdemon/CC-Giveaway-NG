import { Redis } from 'ioredis';
import { ConfigError, loadConfig } from '../config/config.js';
import { runMigrations } from '../db/migrate.js';
import { createPool } from '../db/pool.js';
import { reconcileKernelVersions } from '../framework/giveaway/projectors.js';
import { RedisPublisher } from '../framework/publisher.js';
import { createRuntime } from '../framework/runtime.js';
import { accountAuthorizer } from '../identity/account/authorizer.js';
import { loadTokenKey } from '../identity/crypto.js';
import { attachAccounts } from '../identity/runtime.js';
import { twitchAuthClient } from '../identity/twitch.js';
import { ensurePartitions } from '../journal/partitions.js';
import { buildApp } from './build-app.js';

async function main() {
  const config = loadConfig(process.env);
  const tokenKey = await loadTokenKey(config.tokenKeyFile);
  // Migrationen dürfen länger laufen als das normale Abfragelimit.
  const migratePool = createPool(config.databaseUrl, { queryTimeoutMillis: 0 });
  try {
    await runMigrations(migratePool);
  } finally {
    await migratePool.end();
  }
  const pool = createPool(config.databaseUrl);
  await ensurePartitions(pool, new Date(), 2);
  const redis = new Redis(config.redisUrl);
  const log = { error: (obj: object, msg: string) => console.error(JSON.stringify({ msg, ...obj })) };
  const rt = createRuntime({ pool, publisher: new RedisPublisher(redis), auth: accountAuthorizer(), log });
  const accounts = attachAccounts(rt, { tokenKey });
  const twitch = twitchAuthClient({ clientId: config.twitchClientId, clientSecret: config.twitchClientSecret });
  const app = buildApp(
    { pool, api: { rt, accounts, twitch, publicUrl: config.publicUrl, secureCookies: config.nodeEnv === 'production' } },
    { logger: { level: config.logLevel } },
  );
  app.addHook('onClose', async () => {
    await redis.quit();
  });
  const { rebuilt, skipped } = await reconcileKernelVersions(pool, rt);
  app.log.info({ rebuilt, skipped }, 'Kern-Versionsabgleich erledigt.');
  await app.listen({ host: '0.0.0.0', port: config.port });

  const shutdown = (signal: string) => {
    app.log.info({ signal }, 'Der Prozess fährt herunter.');
    app
      .close()
      .then(() => process.exit(0))
      .catch((e: unknown) => {
        app.log.error({ err: e }, 'Das Herunterfahren ist fehlgeschlagen.');
        process.exit(1);
      });
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

main().catch((e) => {
  console.error(e instanceof ConfigError ? e.message : e);
  process.exit(1);
});
