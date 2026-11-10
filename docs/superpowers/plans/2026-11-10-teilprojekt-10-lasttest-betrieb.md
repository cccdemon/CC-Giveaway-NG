# Teilprojekt 10: Lasttest, Betrieb, Ablösung – Umsetzungsplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Der Neubau läuft produktiv auf LXC 103 neben dem Altsystem: Docker Compose mit `app`, `ingest-worker`, `scheduler`, `web`, PostgreSQL, Redis, Caddy und täglichem Backup mit monatlicher Restore-Probe (NEW_DESIGN.md 3.2, 12.3). Ein wiederholbarer Lasttest mit dem Simulator misst 1.000 Kanäle × 200 Zuschauer gegen das Ziel „< 100 ms je Befehl im p95“ (12.2, Erfolgskriterium 7). Die Ablösung des Altsystems ist als Runbook beschrieben, das Altsystem bekommt einen Nur-Lese-Modus (12.5).

**Architecture:** Der Lasttest ist ein Modul `src/loadtest/` im Server: eine reine Statistik (Perzentile) und ein Lauf, der die echte Runtime mit `InMemoryPublisher`, den Simulator-Adapter und den Ingest-Worker gegen eine eigene Datenbank fährt, die Uhr in Sekundenschritten vorrückt und jede `bus.execute`-Dauer je Befehlstyp misst. Ein Skript startet ihn gegen die Dev-Datenbank, ein kleiner Vitest-Lauf hält ihn lebendig. Der Betrieb ist eine Compose-Datei mit zwei Images (Server, Web) plus Caddy-Image mit Cloudflare-DNS- und Ratelimit-Plugin; Caddy terminiert TLS, routet `/api/*` und `/healthz` an `app`, alles andere an `web`, begrenzt `POST /api/errors` und `/api/auth/*`. Backups laufen in einem Cron-Container (`pg_dump`, 30 Tage), die Restore-Probe spielt monatlich den jüngsten Dump in eine Prüfdatenbank ein und zählt Ereignisse gegen das Manifest. Das Runbook in `docs/betrieb.md` beschreibt Deploy, Stichtag (15.4), Rollback und Archiv. Das Altsystem bekommt `READ_ONLY=true`: Giveaway-Mechanik abgelehnt, Export und Lesen bleiben, DSGVO über den Admin-Dienst bleibt.

**Tech Stack:** wie bisher. Docker Compose, Caddy 2 (xcaddy mit `caddy-dns/cloudflare`, `mholt/caddy-ratelimit`), `postgres:17-alpine`, `redis:7-alpine`. Keine neue npm-Abhängigkeit.

**Spec:** `NEW_DESIGN.md` 1 (Erfolgskriterium 7), 3.1, 3.2, 10.2 (Worker je Hash), 11.2, 12.1 (Redis-Ausfall), 12.2 (Last, CI), 12.3, 12.4 (Backups), 12.5, 15.4.

## Global Constraints

- Der Lasttest schreibt nur in eine eigene, frisch angelegte Datenbank (`loadtest_<zeit>`) und löscht sie danach. Nie gegen eine fremde Datenbank. Kein Netz (Simulator).
- Der Lasttest geht denselben Weg wie der Betrieb: Simulator → Bündler → Dispatcher → `apply_signals` über `CommandBus.execute`. Kein zweiter Schreibweg.
- Produktionskonfiguration ist typisiert (`loadConfig`), Geheimnisse liegen in `.env` und `secrets/`, nie im Image, nie im Repo. `secrets/` bleibt in `.gitignore`.
- Caddy ist der einzige offene Port. `app`, `web`, PostgreSQL, Redis hängen nur am Compose-Netz.
- Backups und Restore-Probe laufen ohne Handarbeit (Cron im Container) und melden Erfolg oder Fehler ins Log und in ein Manifest.
- Texte deutsch nach 11.6. Je Task erst Code, dann `typecheck`, `lint`, `test`. Altsystem: `node --test tests/*.test.js`.

## Entscheidungen, die die Spec offen lässt (meine Festlegungen)

1. **Domain statt Subpfad.** Der Neubau bekommt eine eigene Domain (`DOMAIN` in `.env`, z. B. `giveaway.raumdock.org`) und einen eigenen Host-Port (`CADDY_PORT`, Default 9445) hinter dem SNI-Passthrough von LXC 101 wie das Altsystem (`:9444`). SvelteKit ohne Basispfad, `PUBLIC_URL = https://<DOMAIN>`.
2. **TLS wie im Altsystem:** Caddy terminiert mit Cloudflare DNS-01 (`CF_API_TOKEN`), weil kein Port 80 am Edge ankommt. Zwei Caddyfiles: `caddy/Caddyfile` (DNS-01, Produktion) und `caddy/Caddyfile.local` (`:80`, für `docker compose up` auf dem Entwicklerrechner ohne Zertifikat). Auswahl über `CADDY_CONFIG`.
3. **Routing in Caddy:** `/api/*` und `/healthz` → `app:3000` (WebSocket `/api/ws` inklusive), alles andere → `web:3000`. Caddy setzt `X-Forwarded-Proto`, `X-Forwarded-Host`, `X-Forwarded-For`; `web` liest sie (`PROTOCOL_HEADER`, `HOST_HEADER`, `ADDRESS_HEADER`, `XFF_DEPTH=1`, `ORIGIN`). Sicherheits-Header: HSTS, `nosniff`, `Referrer-Policy`, `X-Frame-Options DENY`, `Permissions-Policy`, CSP `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://static-cdn.jtvnw.net; connect-src 'self' wss:; frame-ancestors 'none'` (SvelteKit hydriert mit Inline-Skript; Nonces sind ein späterer Schritt). Ratelimit (`mholt/caddy-ratelimit`): `POST /api/errors` 10 je Minute je IP, `/api/auth/*` 30 je Minute je IP, `POST /api/feedback` 5 je Minute je IP.
4. **Images:** `Dockerfile` (Server, Multi-Stage: `npm ci` im Workspace, `npm run build -w packages/server`, Laufzeit `node:24-alpine` mit `npm ci --omit=dev -w packages/server`, Nutzer `node`, `CMD` je Prozess über `command:` in Compose) und `packages/web/Dockerfile` (Build, Laufzeit `node build`). `caddy/Dockerfile` baut Caddy mit `xcaddy` und beiden Plugins.
5. **Compose-Dienste** (`docker-compose.yml`): `postgres` (Volume, Healthcheck), `redis` (`appendonly yes`), `app` (1 Instanz, `/healthz`), `ingest` (1 Worker, `INGEST_WORKERS=1`, skalierbar über `INGEST_WORKERS` + eine zweite Service-Definition, dokumentiert), `scheduler` (genau 1), `web`, `caddy` (Ports `${CADDY_PORT}:443`), `backup` (Cron). `migrate-legacy` läuft per `docker compose run --rm app node dist/migration/legacy/cli.js --file /import/<datei>` mit einem Bind-Mount `./import:/import`. Logs `json-file` mit Rotation. `restart: unless-stopped`, `stop_grace_period` 30 s (Ingest drainiert Bündel).
6. **Healthchecks:** `app` über `wget /healthz`, `web` über `wget /` (200), `postgres`/`redis` wie Dev. `ingest` und `scheduler` haben keinen HTTP-Port: Healthcheck prüft, dass der Prozess läuft (`pgrep node`); Signalqualität sieht der Betreiber in der Verwaltung (11.4).
7. **Backup:** `backup/backup.sh` täglich 03:00 (`pg_dump --format=custom`, Datei `ccg_<zeit>.dump`, `KEEP_DAYS=30`, Manifest `manifest.json` mit Zeit, Datei, Größe, Ereigniszahl aus `SELECT count(*) FROM events`). Redis wird nicht gesichert (nur Pub/Sub, 3.2). `backup/restore-check.sh` monatlich am 1. um 04:00: jüngsten Dump in `ccg_restore_check` einspielen (`pg_restore --clean --create` in eine Prüfdatenbank), `SELECT count(*) FROM events` gegen das Manifest, Ergebnis in `restore-check.json` und Log, Prüfdatenbank danach löschen. Beide Skripte laufen auch manuell (`docker compose exec backup sh /backup.sh`).
8. **Lasttest-Modul** `src/loadtest/`: `stats.ts` (rein: `percentile`, `summarize(durations) → {count, p50, p95, p99, max, mean}`), `run.ts` (`runLoadTest(o: { pool; channels; viewers; minutes; seed?; log? }) → LoadResult`): legt je Kanal einen Streamer-pid (UUID, ohne Konto: `allowAll`, `anyChannels`), ein offenes `watchtime`-Giveaway (`fullLegalSource`, Fake-Fetcher) mit Zählweise `first_seen` und Chat-Bonus an, startet `createIngestWorker` mit `SimulatorAdapter` (Simulator-Nutzer bekommen Identitäten über `identityResolver()` beim ersten Bündel, `allActive`), `ChannelSource` aus den pids, `pgGiveawayLookup`, Uhr in 1-s-Schritten je simulierter Minute (`worker.tick`), danach `bundler`-Nachlauf (Grace). Misst jede `bus.execute`-Dauer je Befehlstyp (Proxy um `rt.bus.execute`), zählt Ereignisse (`events`), Ablehnungen, Fehler, Wanduhrzeit. Ergebnis `LoadResult { config, wall: {ms}, commands: Record<type, Summary>, events, rejected, failed, perMinute: {commands, ms}[] }`. Zielprüfung: `applySignals.p95 < 100`. `scripts/load-test.ts`: Argumente `--channels 1000 --viewers 200 --minutes 5 --seed 1 [--keep]`, legt `loadtest_<zeit>` auf `DATABASE_URL` an (Dev-Compose), Migrationen, Partitionen, läuft, druckt Tabelle, löscht die Datenbank (außer `--keep`), Exit 1 wenn p95 ≥ 100 ms. `npm run loadtest -w packages/server -- …`. Pool-Größe für den Lauf einstellbar (`--pool 10`). `test/loadtest.test.ts`: 5 Kanäle × 10 Zuschauer × 2 Minuten gegen `freshDb()`, prüft Form, `events > 0`, `applySignals.count = 10`, kein Fehler. Ergebnis eines echten Laufs (1.000 × 200) steht in `docs/lasttest.md` mit Rechner, Datum, Zahlen und Befund.
9. **Was der Lasttest nicht misst:** Twitch-Netz, Redis-Latenz (InMemory-Publisher), Web-Rendering. Das steht im Bericht.
10. **Ablösung (12.5):** Runbook `docs/betrieb.md`: Voraussetzungen (LXC 103, Docker, Domain, Cloudflare-Token, Twitch-App, Bot), Erstinstallation, Update (`git pull`, `docker compose up -d --build`), Stichtag in der Reihenfolge aus 15.4 mit Befehlen, Altsystem auf `READ_ONLY=true` stellen, Archiv (`GET archive/:sid/export` des Altsystems als tar.gz je Sitzung, abgelegt unter `/opt/team-giveaway/archive`), Rollback (Compose stoppen, Altsystem `READ_ONLY=false`), Backups und Restore-Probe prüfen, Wiederherstellung aus Dump. Altsystem: `READ_ONLY=true` (ENV im Giveaway-Dienst): `gw_cmd`-Befehle außer Lese-Befehlen (`AUDIT_SKIP`-Liste) antworten `read_only`, schreibende REST-Routen (`/api/import`, `/api/wager`, `/api/contest/*`, `/api/claim*`, `/api/participation/withdraw`, `/api/prize/image`) antworten `423 { error: 'read_only' }`, `GET /api/export`, `GET /api/participants`, Archiv und Health bleiben. Der Ticker läuft nicht (`RUN_SCHEDULER=false` setzt der Betreiber dazu). Reine Gate-Funktion `readOnlyGate(method, path, cmd)` mit Test.
11. **CI:** zusätzlich `npm run build`, `docker build` beider Images und `docker compose config` mit `.env.example`-Werten. Kein Deploy aus CI.
12. **Nicht hier:** horizontale Skalierung der App (Caddy-Loadbalancing zwischen mehreren `app`), Redis-Cluster, Monitoring-Stack (Grafana), CSP-Nonces, Streamer.bot-Adapter.

## Review Focus

1. Der Lasttest misst den echten Befehlsweg (`apply_signals` über den Bus) und sagt die Wahrheit über p95; keine Messung an der Bündelung vorbei. Test in Task 1.
2. Compose exponiert nur Caddy; `web` erreicht `app` nur über `API_URL=http://app:3000`; Cookies `secure` (NODE_ENV=production); `trustProxy` in Fastify passt zu einem Proxy-Hop. Prüfung in Task 2 (statischer Test, `docker compose config`).
3. Backup-Skript bricht bei Fehlern mit Exit ≠ 0 ab (`set -e`), Manifest zeigt `status`; Restore-Probe vergleicht die Ereigniszahl und löscht die Prüfdatenbank auch bei Fehlern. Test in Task 3 (Shell-Skripte gegen den Testcontainer).
4. `READ_ONLY` im Altsystem blockiert jede Mechanik, lässt Export und DSGVO zu. Test in Task 4.
5. Runbook deckt 15.4 Schritt für Schritt mit Befehlen ab, inklusive Rollback. Prüfung in Task 4.

---

## Dateistruktur

```
packages/server/src/loadtest/stats.ts                   percentile, summarize
packages/server/src/loadtest/run.ts                     runLoadTest
packages/server/scripts/load-test.ts                    CLI gegen DATABASE_URL (eigene Datenbank)
packages/server/test/loadtest.test.ts, loadtest-stats.test.ts
packages/server/test/betrieb.test.ts                    Compose, Caddyfile, Dockerfiles statisch
packages/server/test/backup.test.ts                     backup.sh, restore-check.sh gegen Testcontainer
Dockerfile                                              Server-Image
packages/web/Dockerfile                                 Web-Image
caddy/Dockerfile, caddy/Caddyfile, caddy/Caddyfile.local
docker-compose.yml                                      Produktion
backup/backup.sh, backup/restore-check.sh, backup/crontab
.env.production.example
docs/betrieb.md, docs/lasttest.md
.github/workflows/ci.yml                                build, docker build, compose config
../CC-Giveaway/services/giveaway/read-only.js, server.js, tests/read-only.test.js, docker-compose.yml, CLAUDE.md
README.md, CLAUDE.md
```

---

### Task 1: Lasttest-Modul und Skript

**Files:**
- Create: `src/loadtest/stats.ts`, `src/loadtest/run.ts`, `scripts/load-test.ts`, `docs/lasttest.md`
- Modify: `packages/server/package.json` (`loadtest`), `src/db/pool.ts` (`max` als Option)
- Test: `test/loadtest-stats.test.ts`, `test/loadtest.test.ts`

**Interfaces:**
- `stats.ts`: `export function percentile(sorted: number[], p: number): number` (nearest-rank, leer → 0), `export interface Summary { count: number; mean: number; p50: number; p95: number; p99: number; max: number }`, `export function summarize(durationsMs: number[]): Summary`.
- `run.ts`:
  ```ts
  export interface LoadOptions { pool: pg.Pool; channels: number; viewers: number; minutes: number; seed?: number; log?: BusLogger; onMinute?: (m: number, info: { commands: number; ms: number }) => void }
  export interface LoadResult { config: { channels; viewers; minutes; seed }; wallMs: number; commands: Record<string, Summary>; events: number; rejected: number; failed: number; perMinute: { minute: number; commands: number; ms: number }[]; target: { p95Ms: 100; ok: boolean } }
  export async function runLoadTest(o: LoadOptions): Promise<LoadResult>;
  ```
- `pool.ts`: `PoolOptions.max?: number`.
- `scripts/load-test.ts`: Argumente wie Festlegung 8, Ausgabe als Tabelle (Befehl, Anzahl, p50, p95, p99, max), Exit 1 bei Zielverfehlung.

- [ ] **Step 1: Tests schreiben**

```ts
// loadtest-stats.test.ts
it('percentile uses nearest rank and summarize reports count, mean, p50, p95, p99, max; empty input gives zeros', ...);
// loadtest.test.ts
it('runLoadTest drives simulator signals through apply_signals for every channel and minute, writes events and reports per-command summaries and the p95 target', ...);   // RF 1: applySignals.count = channels × minutes, events > 0, failed = 0, identities = channels × viewers
```

- [ ] **Step 2: Tests laufen lassen, sie scheitern**
- [ ] **Step 3: Implementieren**
- [ ] **Step 4: Prüfen**; danach `npm run loadtest -- --channels 1000 --viewers 200 --minutes 3` gegen die Dev-Datenbank, Ergebnis in `docs/lasttest.md` (Rechner, Datum, Zahlen, Befund, Engpässe).
- [ ] **Step 5: Commit** `feat(loadtest): Lasttest mit Simulator, Perzentile je Befehl und Skript gegen eigene Datenbank`

---

### Task 2: Images, Compose, Caddy

**Files:**
- Create: `Dockerfile`, `packages/web/Dockerfile`, `caddy/Dockerfile`, `caddy/Caddyfile`, `caddy/Caddyfile.local`, `docker-compose.yml`, `.env.production.example`, `.dockerignore`
- Modify: `.github/workflows/ci.yml`, `.gitignore` (`import/`, `backups/`)
- Test: `test/betrieb.test.ts`

**Interfaces:**
- Compose-Dienste nach Festlegung 5, Umgebung aus `.env` (`DOMAIN`, `CADDY_PORT`, `CADDY_CONFIG`, `CF_API_TOKEN`, `PG_PASSWORD`, `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, `TWITCH_BOT_USER_ID`, `ADMIN_TWITCH_IDS`, `INGEST_WORKERS`, `LOG_LEVEL`). `DATABASE_URL`, `REDIS_URL`, `PUBLIC_URL`, `API_URL`, `TOKEN_KEY_FILE=/run/secrets/token.key` setzt Compose selbst. `secrets/token.key` als Bind-Mount (read-only).
- Caddyfile nach Festlegung 3.
- `betrieb.test.ts` (statisch, ohne Docker): Compose nennt alle acht Dienste, nur `caddy` hat `ports`, `web` hat `API_URL=http://app:3000` und `ORIGIN=https://${DOMAIN}`, `app`/`ingest`/`scheduler` setzen `NODE_ENV=production` und `TOKEN_KEY_FILE`; Caddyfile routet `/api/*` und `/healthz` an `app:3000`, den Rest an `web:3000`, enthält `rate_limit` für `/api/errors`; Dockerfiles bauen `packages/server` bzw. `packages/web` und laufen als `node`.

- [ ] **Step 1: Tests schreiben**

```ts
// betrieb.test.ts
it('docker-compose.yml defines postgres, redis, app, ingest, scheduler, web, caddy, backup; only caddy publishes ports; web talks to app over the compose network', ...);   // RF 2
it('Caddyfile routes /api and /healthz to app, everything else to web, sets forwarded headers and rate limits', ...);
it('Dockerfiles build the workspace packages and run as the node user', ...);
```

- [ ] **Step 2: Tests laufen lassen, sie scheitern**
- [ ] **Step 3: Implementieren**; lokal `docker compose config` und `docker compose build` ausführen.
- [ ] **Step 4: Prüfen**
- [ ] **Step 5: Commit** `feat(betrieb): Produktions-Compose mit Caddy, Images für Server und Web, CI baut Images`

---

### Task 3: Backup und Restore-Probe

**Files:**
- Create: `backup/backup.sh`, `backup/restore-check.sh`, `backup/crontab`
- Modify: `docker-compose.yml` (Dienst `backup`)
- Test: `test/backup.test.ts` (führt beide Skripte per `sh` gegen den Testcontainer aus, braucht `pg_dump`/`pg_restore` im PATH; sonst `it.skip` mit Hinweis)

**Interfaces:** nach Festlegung 7. Skripte lesen `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`, `BACKUP_DIR`, `KEEP_DAYS`.

- [ ] **Step 1: Tests schreiben**

```ts
// backup.test.ts
it('backup.sh writes a custom-format dump and a manifest with the event count, and deletes dumps older than KEEP_DAYS', ...);   // RF 3
it('restore-check.sh restores the newest dump into a check database, compares the event count with the manifest, writes restore-check.json and drops the check database', ...);
```

- [ ] **Step 2: Tests laufen lassen, sie scheitern**
- [ ] **Step 3: Implementieren**
- [ ] **Step 4: Prüfen**
- [ ] **Step 5: Commit** `feat(betrieb): tägliches Backup und monatliche Restore-Probe`

---

### Task 4: Runbook und Nur-Lese-Modus im Altsystem

**Files:**
- Create: `docs/betrieb.md`; Altsystem `services/giveaway/read-only.js`, `services/giveaway/tests/read-only.test.js`
- Modify: Altsystem `services/giveaway/server.js`, `docker-compose.yml` (`READ_ONLY`), `CLAUDE.md`

**Interfaces:**
- `read-only.js`: `isReadOnly(env)`, `readOnlyGate({ readOnly, method, path, cmd }) → null | { status, error: 'read_only', message }` mit Allow-Liste nach Festlegung 10; in `server.js` als Express-Middleware vor den Routen und als Prüfung am Anfang von `case 'gw_cmd'`.

- [ ] **Step 1: Tests schreiben**

```js
test('readOnlyGate lets GET, export, archive, health and read commands through and blocks mechanics with read_only', ...);   // RF 4
```

- [ ] **Step 2: Tests laufen lassen, sie scheitern**
- [ ] **Step 3: Implementieren**, Runbook schreiben (RF 5)
- [ ] **Step 4: Prüfen** (Altsystem `node --test tests/*.test.js`)
- [ ] **Step 5: Commits** Altsystem `feat(betrieb): Nur-Lese-Modus READ_ONLY für die Ablösung`, Neubau `docs(betrieb): Runbook für Deploy, Stichtag, Rollback und Wiederherstellung`

---

### Task 5: Doku

- [ ] README (Entwickeln: Produktion starten; Begriffe Lasttest, Backup, Restore-Probe, Runbook; Stand „10 fertig, Neubau vollständig“), CLAUDE.md (Stand, Befehle `loadtest`, Abschnitt Betrieb und Lasttest), Commit `docs: Betrieb und Lasttest, Stand Teilprojekt 10`.

---

## Selbstprüfung gegen die Spec

- 12.2 Last: Simulator, 1.000 × 200, Ziel p95 < 100 ms, Ergebnis dokumentiert (Task 1). CI: Typecheck, Lint, Tests, E2E, jetzt auch Build und Images (Task 2).
- 12.3 Betrieb: Compose mit allen sechs Diensten plus Backup (Task 2, 3), LXC 103 mit eigener Domain (Festlegung 1), typisierte Konfiguration bleibt, Migrationen bleiben die Quelle des Schemas, tägliche Backups und monatliche Restore-Probe (Task 3).
- 3.2 Caddy als Reverse Proxy (Task 2). 12.1 Redis-Ausfall: `appendonly`, Neustart durch Compose, App schließt Sockets (vorhanden).
- 12.5 Ablösung: harter Schnitt per Runbook, Altsystem nur lesbar, Archiv, DSGVO beim Altsystem (Task 4).
- 15.4 Stichtag mit `migrate-legacy` im Container (Task 2, 4).
