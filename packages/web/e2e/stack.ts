// E2E-Stack (NEW_DESIGN.md 12.2): echter app-Prozess mit PostgreSQL aus Testcontainers, Twitch-Stub und lokalem Bus.
// Nur für Playwright. Kein Netz zu Twitch: der Stub leitet die Anmeldung direkt auf den Callback zurück.
// Start: npx tsx e2e/stack.ts (Port 3100). Steuerroute POST /__e2e/user { id, login, displayName } setzt die nächste Person.
import { randomBytes } from 'node:crypto';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { buildApp } from '../../server/src/app/build-app.js';
import { runMigrations } from '../../server/src/db/migrate.js';
import { createRuntime } from '../../server/src/framework/runtime.js';
import { LocalBus } from '../../server/src/framework/subscriber.js';
import { accountAuthorizer, accountTeamAuthorizer } from '../../server/src/identity/account/authorizer.js';
import { accountLegalSource } from '../../server/src/identity/account/legal-source.js';
import { attachAccounts } from '../../server/src/identity/runtime.js';
import { pgBanDirectory, pgTeamDirectory } from '../../server/src/identity/team-directory.js';
import { REQUIRED_CHANNEL_SCOPES, type TwitchAuthClient } from '../../server/src/identity/twitch.js';
import type { TwitchUser } from '../../server/src/identity/identities.js';
import { ensurePartitions } from '../../server/src/journal/partitions.js';

const API_PORT = Number(process.env.E2E_API_PORT ?? 3100);
const WEB_URL = process.env.E2E_WEB_URL ?? 'http://localhost:3101';

async function main() {
  const container = await new PostgreSqlContainer('postgres:17-alpine').start();
  const pool = new pg.Pool({ connectionString: container.getConnectionUri(), max: 20 });
  await runMigrations(pool);
  await ensurePartitions(pool, new Date(), 1);

  let current: TwitchUser = { id: '1001', login: 'alice', displayName: 'Alice' };
  const twitch: TwitchAuthClient = {
    // Kein Twitch: direkt zurück zum Callback der App, der Code trägt den Login.
    authorizeUrl: (p) => `${p.redirectUri}?code=${encodeURIComponent(current.login)}&state=${encodeURIComponent(p.state)}`,
    async exchangeCode(code) {
      return { accessToken: `acc-${code}`, refreshToken: `ref-${code}`, expiresIn: 3600, scopes: [...REQUIRED_CHANNEL_SCOPES] };
    },
    async refresh(refreshToken) {
      return { accessToken: `acc-${refreshToken}`, refreshToken, expiresIn: 3600, scopes: [...REQUIRED_CHANNEL_SCOPES] };
    },
    getUser: async () => current,
  };

  const bus = new LocalBus();
  const log = { error: (obj: object, msg: string) => console.error(JSON.stringify({ msg, ...obj })) };
  const rt = createRuntime({
    pool,
    publisher: bus,
    auth: accountAuthorizer(),
    legalSource: accountLegalSource(),
    // Rechtstext-Links prüft der Stack nicht im Netz: Hash aus der URL.
    fetcher: async (url: string) => ({ ok: true, hash: `h:${url}` }),
    teamAuth: accountTeamAuthorizer(),
    teamDirectory: pgTeamDirectory(),
    bans: pgBanDirectory(),
    log,
  });
  const accounts = attachAccounts(rt, { tokenKey: randomBytes(32) });
  const app = buildApp({ pool, api: { rt, accounts, auth: accountAuthorizer(), subscriber: bus, twitch, publicUrl: WEB_URL, secureCookies: false } });
  app.post<{ Body: Partial<TwitchUser> }>('/__e2e/user', async (req) => {
    const b = req.body ?? {};
    current = { id: String(b.id ?? current.id), login: String(b.login ?? current.login), displayName: String(b.displayName ?? current.displayName) };
    return current;
  });
  await app.listen({ host: '127.0.0.1', port: API_PORT });
  console.log(`ready http://127.0.0.1:${API_PORT}`);

  const stop = async () => {
    await app.close();
    await container.stop();
    process.exit(0);
  };
  process.once('SIGTERM', () => void stop());
  process.once('SIGINT', () => void stop());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
