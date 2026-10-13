import { z } from 'zod';

const ZAHL_MSG = 'Erlaubt ist eine ganze Zahl von 1 bis 65535.';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production'], { message: 'Erlaubt sind: development, test, production.' }).default('development'),
  DATABASE_URL: z.string({ message: 'Pflichtwert fehlt.' }).url({ message: 'Keine gültige URL.' }),
  REDIS_URL: z.string({ message: 'Pflichtwert fehlt.' }).url({ message: 'Keine gültige URL.' }),
  PORT: z.coerce.number({ message: 'Keine Zahl.' }).int({ message: ZAHL_MSG }).min(1, { message: ZAHL_MSG }).max(65535, { message: ZAHL_MSG }).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'], { message: 'Erlaubt sind: fatal, error, warn, info, debug, trace.' }).default('info'),
});

export interface Config {
  nodeEnv: 'development' | 'test' | 'production';
  databaseUrl: string;
  redisUrl: string;
  port: number;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
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
  return { nodeEnv: v.NODE_ENV, databaseUrl: v.DATABASE_URL, redisUrl: v.REDIS_URL, port: v.PORT, logLevel: v.LOG_LEVEL };
}
