import { z } from 'zod';

const ZAHL_MSG = 'Erlaubt ist eine ganze Zahl von 1 bis 65535.';
const WORKERS_MSG = 'Erlaubt ist eine ganze Zahl ab 1.';
const INDEX_MSG = 'Erlaubt ist eine ganze Zahl ab 0.';
const SIM_MSG = 'Erlaubt ist eine ganze Zahl von 1 bis 5000.';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production'], { message: 'Erlaubt sind: development, test, production.' }).default('development'),
  DATABASE_URL: z.string({ message: 'Pflichtwert fehlt.' }).url({ message: 'Keine gültige URL.' }),
  REDIS_URL: z.string({ message: 'Pflichtwert fehlt.' }).url({ message: 'Keine gültige URL.' }),
  PORT: z.coerce.number({ message: 'Keine Zahl.' }).int({ message: ZAHL_MSG }).min(1, { message: ZAHL_MSG }).max(65535, { message: ZAHL_MSG }).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'], { message: 'Erlaubt sind: fatal, error, warn, info, debug, trace.' }).default('info'),
  TWITCH_CLIENT_ID: z.string({ message: 'Pflichtwert fehlt.' }).min(1, { message: 'Pflichtwert fehlt.' }),
  TWITCH_CLIENT_SECRET: z.string({ message: 'Pflichtwert fehlt.' }).min(1, { message: 'Pflichtwert fehlt.' }),
  PUBLIC_URL: z
    .string({ message: 'Pflichtwert fehlt.' })
    .url({ message: 'Keine gültige URL.' })
    .transform((s) => s.replace(/\/+$/, '')),
  TOKEN_KEY_FILE: z.string({ message: 'Pflichtwert fehlt.' }).min(1, { message: 'Pflichtwert fehlt.' }),
  INGEST_ADAPTER: z.enum(['twitch', 'simulator'], { message: 'Erlaubt sind: twitch, simulator.' }).default('twitch'),
  INGEST_WORKERS: z.coerce.number({ message: 'Keine Zahl.' }).int({ message: WORKERS_MSG }).min(1, { message: WORKERS_MSG }).default(1),
  INGEST_WORKER_INDEX: z.coerce.number({ message: 'Keine Zahl.' }).int({ message: INDEX_MSG }).min(0, { message: INDEX_MSG }).default(0),
  TWITCH_BOT_USER_ID: z.string().default(''),
  INGEST_SIM_VIEWERS: z.coerce.number({ message: 'Keine Zahl.' }).int({ message: SIM_MSG }).min(1, { message: SIM_MSG }).max(5000, { message: SIM_MSG }).default(20),
  INGEST_SIM_SEED: z.coerce.number({ message: 'Keine Zahl.' }).int({ message: 'Erlaubt ist eine ganze Zahl.' }).default(1),
  ADMIN_TWITCH_IDS: z.string().default(''),
});

export interface Config {
  nodeEnv: 'development' | 'test' | 'production';
  databaseUrl: string;
  redisUrl: string;
  port: number;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
  twitchClientId: string;
  twitchClientSecret: string;
  /** Öffentliche Basis-URL ohne Schrägstrich am Ende, z. B. https://giveaway.example.org */
  publicUrl: string;
  /** Pfad zur Schlüsseldatei für Kanal-Tokens (64 Hex-Zeichen). */
  tokenKeyFile: string;
  ingestAdapter: 'twitch' | 'simulator';
  /** Zahl der Ingest-Worker (Conduit-Shards). Kanäle werden per Hash verteilt (NEW_DESIGN.md 10.2). */
  ingestWorkers: number;
  ingestWorkerIndex: number;
  /** Twitch-ID des Plattform-Bots. Pflicht nur bei INGEST_ADAPTER=twitch, prüft der Ingest beim Start. */
  twitchBotUserId: string;
  ingestSimViewers: number;
  ingestSimSeed: number;
  /** Twitch-IDs der Superadmins (NEW_DESIGN.md 11.4), kommagetrennt. Leer = niemand. */
  adminTwitchIds: string[];
}

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Der Start ist abgebrochen. Korrigiere diese Werte in der Umgebung:\n${problems.map((p) => `- ${p}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
  }
  const v = parsed.data;
  if (v.INGEST_WORKER_INDEX >= v.INGEST_WORKERS) {
    throw new ConfigError(['INGEST_WORKER_INDEX muss kleiner als INGEST_WORKERS sein.']);
  }
  return {
    nodeEnv: v.NODE_ENV,
    databaseUrl: v.DATABASE_URL,
    redisUrl: v.REDIS_URL,
    port: v.PORT,
    logLevel: v.LOG_LEVEL,
    twitchClientId: v.TWITCH_CLIENT_ID,
    twitchClientSecret: v.TWITCH_CLIENT_SECRET,
    publicUrl: v.PUBLIC_URL,
    tokenKeyFile: v.TOKEN_KEY_FILE,
    ingestAdapter: v.INGEST_ADAPTER,
    ingestWorkers: v.INGEST_WORKERS,
    ingestWorkerIndex: v.INGEST_WORKER_INDEX,
    twitchBotUserId: v.TWITCH_BOT_USER_ID,
    ingestSimViewers: v.INGEST_SIM_VIEWERS,
    ingestSimSeed: v.INGEST_SIM_SEED,
    adminTwitchIds: v.ADMIN_TWITCH_IDS.split(',').map((x) => x.trim()).filter((x) => x !== ''),
  };
}
