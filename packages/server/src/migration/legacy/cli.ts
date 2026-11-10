// Werkzeug migrate-legacy (NEW_DESIGN.md 15.6): npm run migrate-legacy -- --file <pfad> [--dry-run]
// Liest nur die Datei, löst Logins per Helix auf, schreibt über die Runtime mit Akteur system:migration, legt den Bericht neben die Datei.
// Exit-Codes: 0 fertig, 1 Abbruch vor dem Schreiben (Datei, Version, Kontrollsumme, Twitch), 2 Lauf mit Fehlern.
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { Redis } from 'ioredis';
import { ConfigError, loadConfig } from '../../config/config.js';
import { runMigrations } from '../../db/migrate.js';
import { createPool } from '../../db/pool.js';
import type { BusLogger } from '../../framework/command-bus.js';
import { denyUsers } from '../../framework/giveaway/authorize.js';
import { RedisPublisher } from '../../framework/publisher.js';
import { createRuntime } from '../../framework/runtime.js';
import { denyUsersTeams } from '../../framework/team/commands.js';
import { accountLegalSource } from '../../identity/account/legal-source.js';
import { loadTokenKey } from '../../identity/crypto.js';
import { identityResolver } from '../../identity/resolver.js';
import { attachAccounts } from '../../identity/runtime.js';
import { pgBanDirectory, pgTeamDirectory } from '../../identity/team-directory.js';
import { appTokenSource, helixClient } from '../../ingest/twitch/helix.js';
import { noAdmins } from '../../platform/admin.js';
import { attachPlatform } from '../../platform/runtime.js';
import { LegacyFormatError, parseBackup } from './format.js';
import { renderReport, reportPathOf } from './report.js';
import { helixLoginResolver } from './resolve.js';
import { runImport } from './run.js';

const USAGE = 'Aufruf: npm run migrate-legacy -- --file <pfad> [--dry-run]';

const log: BusLogger = {
  error: (obj, msg) => {
    const { err, ...rest } = obj as { err?: unknown };
    console.error(JSON.stringify({ msg, ...rest, ...(err === undefined ? {} : { err: err instanceof Error ? err.stack : String(err) }) }));
  },
};

export function parseCliArgs(argv: string[]): { file: string; dryRun: boolean } {
  const { values } = parseArgs({ args: argv, options: { file: { type: 'string' }, 'dry-run': { type: 'boolean', default: false } }, strict: true });
  if (!values.file) throw new Error(`Die Datei fehlt. ${USAGE}`);
  return { file: values.file, dryRun: values['dry-run'] === true };
}

async function main(): Promise<number> {
  const { file, dryRun } = parseCliArgs(process.argv.slice(2));
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (e) {
    console.error(`Die Datei ${file} lässt sich nicht lesen: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  let backup;
  try {
    backup = parseBackup(text);
  } catch (e) {
    if (e instanceof LegacyFormatError) {
      console.error(e.message);
      return 1;
    }
    throw e;
  }

  const config = loadConfig(process.env);
  const tokenKey = await loadTokenKey(config.tokenKeyFile);
  const migratePool = createPool(config.databaseUrl, { queryTimeoutMillis: 0 });
  try {
    await runMigrations(migratePool);
  } finally {
    await migratePool.end();
  }
  const pool = createPool(config.databaseUrl);
  const redis = new Redis(config.redisUrl);
  const now = () => new Date();
  try {
    const rt = createRuntime({
      pool, publisher: new RedisPublisher(redis), auth: denyUsers, legalSource: accountLegalSource(), identities: identityResolver(), log,
      teamAuth: denyUsersTeams, teamDirectory: pgTeamDirectory(), bans: pgBanDirectory(),
    });
    const accounts = attachAccounts(rt, { tokenKey });
    attachPlatform(rt, { admins: noAdmins });
    const helix = helixClient({ clientId: config.twitchClientId, appToken: appTokenSource({ clientId: config.twitchClientId, clientSecret: config.twitchClientSecret, now }), now });
    const at = now();
    const result = await runImport(backup, { pool, rt, accounts, resolver: helixLoginResolver(helix), dryRun, now, log });
    const report = renderReport(file, dryRun, at, result);
    await writeFile(reportPathOf(file), report, 'utf8');
    console.log(report);
    console.log(`Bericht: ${reportPathOf(file)}`);
    if (result.aborted) return 1;
    return result.failed > 0 ? 2 : 0;
  } finally {
    await redis.quit();
    await pool.end();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(e instanceof ConfigError ? e.message : e);
    process.exit(1);
  });
