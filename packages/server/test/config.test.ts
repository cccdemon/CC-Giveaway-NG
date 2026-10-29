import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config/config.js';

const valid = {
  DATABASE_URL: 'postgres://u:p@localhost:5433/ccg',
  REDIS_URL: 'redis://localhost:6380',
  TWITCH_CLIENT_ID: 'cid',
  TWITCH_CLIENT_SECRET: 'csecret',
  PUBLIC_URL: 'https://giveaway.example.org/',
  TOKEN_KEY_FILE: './secrets/token.key',
};

const problemsOf = (env: Record<string, string | undefined>): string[] => {
  try {
    loadConfig(env);
  } catch (e) {
    return (e as ConfigError).problems;
  }
  return [];
};

describe('loadConfig', () => {
  it('reads valid env with defaults', () => {
    expect(loadConfig(valid)).toEqual({
      nodeEnv: 'development',
      databaseUrl: valid.DATABASE_URL,
      redisUrl: valid.REDIS_URL,
      port: 3000,
      logLevel: 'info',
      twitchClientId: 'cid',
      twitchClientSecret: 'csecret',
      publicUrl: 'https://giveaway.example.org',
      tokenKeyFile: './secrets/token.key',
    });
  });

  it('rejects an empty TWITCH_CLIENT_ID and a PUBLIC_URL that is no URL', () => {
    expect(problemsOf({ ...valid, TWITCH_CLIENT_ID: '' }).join('\n')).toMatch(/TWITCH_CLIENT_ID/);
    expect(problemsOf({ ...valid, PUBLIC_URL: 'giveaway' }).join('\n')).toMatch(/PUBLIC_URL: Keine gültige URL/);
  });

  it('coerces PORT', () => {
    expect(loadConfig({ ...valid, PORT: '8080' }).port).toBe(8080);
  });

  it('lists every problem at once', () => {
    let err: unknown;
    try {
      loadConfig({ PORT: 'abc', LOG_LEVEL: 'loud' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    const problems = (err as ConfigError).problems;
    expect(problems).toHaveLength(8);
    expect(problems.join('\n')).toMatch(/DATABASE_URL/);
    expect(problems.join('\n')).toMatch(/REDIS_URL/);
    expect(problems.join('\n')).toMatch(/PORT/);
    expect(problems.join('\n')).toMatch(/LOG_LEVEL/);
    expect((err as ConfigError).message).toMatch(/^Der Start ist abgebrochen/);
  });

  it('gives German, actionable message for LOG_LEVEL', () => {
    const text = problemsOf({ ...valid, LOG_LEVEL: 'loud' }).join('\n');
    expect(text).toMatch(/LOG_LEVEL/);
    expect(text).toMatch(/Erlaubt sind/);
  });

  it('gives German, actionable message for NODE_ENV', () => {
    const text = problemsOf({ ...valid, NODE_ENV: 'staging' }).join('\n');
    expect(text).toMatch(/NODE_ENV/);
    expect(text).toMatch(/Erlaubt sind/);
  });

  it('gives German, actionable message for PORT range', () => {
    const text = problemsOf({ ...valid, PORT: '70000' }).join('\n');
    expect(text).toMatch(/ganze Zahl von 1 bis 65535/);
  });
});
