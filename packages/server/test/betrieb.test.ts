import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Statische Prüfung der Betriebsdateien (NEW_DESIGN.md 12.3), ohne Docker: Form und Verdrahtung, nicht der Start.
const root = (p: string): string => readFileSync(new URL(`../../../${p}`, import.meta.url), 'utf8');
const compose = root('docker-compose.yml');
const caddy = root('caddy/Caddyfile');
const caddyLocal = root('caddy/Caddyfile.local');
const serverImage = root('Dockerfile');
const webImage = root('packages/web/Dockerfile');
const caddyImage = root('caddy/Dockerfile');
const ci = root('.github/workflows/ci.yml');
const envExample = root('.env.production.example');
const runbook = root('docs/betrieb.md');
/** Compose ohne Kommentarzeilen (ingest-1 ist als Vorlage auskommentiert). */
const composeCode = compose.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

/** Block eines Dienstes aus der Compose-Datei (bis zum nächsten Dienst auf derselben Einrückung). */
function service(name: string): string {
  const m = new RegExp(`\\n  ${name}:\\n([\\s\\S]*?)(?=\\n  [a-z_]+:\\n|\\nvolumes:|\\nsecrets:|$)`).exec(compose);
  if (!m) throw new Error(`Dienst ${name} fehlt`);
  return m[1]!;
}

describe('Betrieb', () => {
  it('docker-compose.yml defines postgres, redis, app, ingest, scheduler, web, caddy, backup; only caddy publishes ports; web talks to app over the compose network', () => {
    for (const s of ['postgres', 'redis', 'app', 'ingest', 'scheduler', 'web', 'caddy', 'backup']) expect(service(s)).toBeTruthy();
    const withPorts = ['postgres', 'redis', 'app', 'ingest', 'scheduler', 'web', 'caddy', 'backup'].filter((s) => /\n\s+ports:/.test(service(s)));
    expect(withPorts).toEqual(['caddy']);
    expect(service('caddy')).toMatch(/\$\{CADDY_PORT:-9445\}:443/);
    expect(service('web')).toMatch(/API_URL: http:\/\/app:3000/);
    expect(service('web')).toMatch(/ORIGIN: https:\/\/\$\{DOMAIN\}/);
    expect(service('web')).toMatch(/ADDRESS_HEADER: x-forwarded-for/);
    expect(service('web')).toMatch(/XFF_DEPTH: "1"/);
    // Die drei Server-Prozesse teilen eine Umgebung (YAML-Anker) und ein Image.
    const serverEnv = /x-server-env: &server-env\n([\s\S]*?)\n\n/.exec(compose)?.[1] ?? '';
    expect(serverEnv).toMatch(/NODE_ENV: production/);
    expect(serverEnv).toMatch(/TOKEN_KEY_FILE: \/run\/secrets\/token\.key/);
    expect(serverEnv).toMatch(/DATABASE_URL: postgres:\/\/ccg:\$\{PG_PASSWORD\}@postgres:5432\/ccg/);
    expect(serverEnv).toMatch(/REDIS_URL: redis:\/\/redis:6379/);
    expect(serverEnv).toMatch(/PUBLIC_URL: https:\/\/\$\{DOMAIN\}/);
    for (const s of ['app', 'ingest', 'scheduler']) {
      const block = service(s);
      expect(block).toMatch(/environment: \*server-env/);
      expect(block).toMatch(/secrets:\n\s+- token\.key/);
      expect(block).toMatch(new RegExp(`dist/${s}/main\\.js`));
      expect(block).toMatch(/image: ccg-server/);
    }
    expect(service('web')).toMatch(/healthz/);
    expect(service('scheduler')).not.toMatch(/replicas/);
    expect(service('app')).toMatch(/healthz/);
    expect(service('postgres')).toMatch(/pg_isready/);
    expect(service('redis')).toMatch(/appendonly yes/);
    expect(compose).toMatch(/secrets:\n  token\.key:\n    file: \.\/secrets\/token\.key/);
    expect(service('app')).toMatch(/\.\/import:\/import\n/);
    // Zweiter Worker als Vorlage mit Merge-Syntax, damit INGEST_WORKER_INDEX überschreibbar ist.
    expect(compose).toMatch(/#\s+ingest-1:/);
    expect(compose).toMatch(/#\s+<<: \*server-env/);
    expect(compose).toMatch(/#\s+INGEST_WORKER_INDEX: "1"/);
    expect(service('ingest')).toMatch(/\["CMD", "pgrep", "-f", "dist\/ingest\/main\.js"\]/);
    expect(service('backup')).toMatch(/healthcheck:/);
    expect(service('backup')).toMatch(/health\.sh/);
    expect(service('backup')).toMatch(/sh \/backup\/backup\.sh/);
    // Jeder Dienst startet neu und rotiert seine Logs.
    expect((composeCode.match(/restart: unless-stopped/g) ?? []).length).toBe(8);
    expect((composeCode.match(/logging: \*logging/g) ?? []).length).toBe(8);
    expect(compose).toMatch(/max-size/);
  });

  it('Caddyfile routes /api and /healthz to app, everything else to web, sets security headers and rate limits', () => {
    for (const file of [caddy, caddyLocal]) {
      expect(file).toMatch(/@api path \/api\/\* \/healthz/);
      expect(file).toMatch(/handle @api \{\s+reverse_proxy app:3000/);
      expect(file).toMatch(/handle \{\s+reverse_proxy web:3000/);
      expect(file).toMatch(/rate_limit \{/);
      expect(file).toMatch(/path \/api\/errors/);
      expect(file).toMatch(/path \/api\/auth\/\*/);
      expect(file).toMatch(/Strict-Transport-Security/);
      expect(file).toMatch(/X-Content-Type-Options nosniff/);
      expect(file).toMatch(/Content-Security-Policy/);
      expect(file).toMatch(/order rate_limit before basic_auth/);
      expect(file).toMatch(/\n\s+log \{/);
      expect(file).not.toMatch(/basicauth\b/);
    }
    expect(caddy).toMatch(/acme_dns cloudflare \{env\.CF_API_TOKEN\}/);
    expect(caddy).toMatch(/\{\$DOMAIN\} \{/);
    expect(caddyLocal).toMatch(/tls internal/);
    expect(caddyImage).toMatch(/xcaddy build/);
    expect(caddyImage).toMatch(/caddy-dns\/cloudflare/);
    expect(caddyImage).toMatch(/mholt\/caddy-ratelimit/);
  });

  it('Dockerfiles build the workspace packages and run as the node user; CI builds images and validates the compose file', () => {
    expect(serverImage).toMatch(/npm run build -w packages\/server/);
    expect(serverImage).toMatch(/npm ci --omit=dev -w packages\/server/);
    expect(serverImage).toMatch(/COPY packages\/server\/migrations/);
    expect(serverImage).toMatch(/\nUSER node/);
    expect(serverImage).toMatch(/NODE_ENV=production/);
    expect(webImage).toMatch(/npm run build -w packages\/web/);
    expect(webImage).toMatch(/\nUSER node/);
    expect(webImage).toMatch(/CMD \["node", "build"\]/);
    expect(ci).toMatch(/npm run build/);
    expect(ci).toMatch(/docker build -f Dockerfile/);
    expect(ci).toMatch(/docker build -f packages\/web\/Dockerfile/);
    expect(ci).toMatch(/docker compose --env-file \.env\.production\.example config/);
    expect(ci).toMatch(/docker build -t ccg-caddy caddy/);
    expect(ci).toMatch(/caddy validate/);
    // Runbook: der Schlüssel muss für den Nutzer node lesbar sein, der Bericht landet in einem beschreibbaren Ordner.
    expect(runbook).not.toMatch(/chmod 600 secrets\/token\.key/);
    expect(runbook).toMatch(/chmod 444 secrets\/token\.key/);
    expect(runbook).toMatch(/chown 1000:1000 import/);
    expect(runbook).not.toMatch(/RUN_SCHEDULER=false/);
    expect(runbook).toMatch(/pg_restore --exit-on-error/);
    for (const key of ['DOMAIN', 'CADDY_PORT', 'CADDY_CONFIG', 'CF_API_TOKEN', 'PG_PASSWORD', 'TWITCH_CLIENT_ID', 'TWITCH_CLIENT_SECRET', 'TWITCH_BOT_USER_ID', 'ADMIN_TWITCH_IDS', 'INGEST_ADAPTER', 'INGEST_WORKERS', 'LOG_LEVEL']) {
      expect(envExample).toMatch(new RegExp(`^${key}=`, 'm'));
    }
  });
});
