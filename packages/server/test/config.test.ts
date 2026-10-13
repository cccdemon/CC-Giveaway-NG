import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config/config.js';

const valid = {
  DATABASE_URL: 'postgres://u:p@localhost:5433/ccg',
  REDIS_URL: 'redis://localhost:6380',
};

describe('loadConfig', () => {
  it('reads valid env with defaults', () => {
    expect(loadConfig(valid)).toEqual({
      nodeEnv: 'development',
      databaseUrl: valid.DATABASE_URL,
      redisUrl: valid.REDIS_URL,
      port: 3000,
      logLevel: 'info',
    });
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
    expect(problems).toHaveLength(4);
    expect(problems.join('\n')).toMatch(/DATABASE_URL/);
    expect(problems.join('\n')).toMatch(/REDIS_URL/);
    expect(problems.join('\n')).toMatch(/PORT/);
    expect(problems.join('\n')).toMatch(/LOG_LEVEL/);
    expect((err as ConfigError).message).toMatch(/^Der Start ist abgebrochen/);
  });
});
