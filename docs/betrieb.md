# Betrieb

Runbook für Deploy, Stichtag, Rollback und Wiederherstellung (NEW_DESIGN.md 12.3, 12.5, 15.4). Ziel ist LXC 103 („streamer“, 10.10.10.99) neben dem Altsystem, mit eigener Domain.

## Voraussetzungen

- LXC 103 mit Docker und Docker Compose v2. Zugang wie beim Altsystem über `pct exec 103` auf dem Host.
- Eine Domain für den Neubau (z. B. `giveaway.raumdock.org`) bei Cloudflare, Edge-Eintrag auf LXC 101 (nginx, SNI-Passthrough) auf `10.10.10.99:<CADDY_PORT>` (Default 9445; 9444 gehört dem Altsystem).
- Cloudflare-API-Token mit `Zone:DNS:Edit` für die Domain (TLS per DNS-01, kein Port 80 nötig).
- Twitch-App mit Redirect-URL `https://<DOMAIN>/api/auth/twitch/callback` und ein Bot-Konto (README „Bot einrichten“).
- Twitch-IDs der Betreiber für `ADMIN_TWITCH_IDS`.

## Erstinstallation

```sh
cd /opt && git clone <repo> cc-giveaway-ng && cd cc-giveaway-ng
cp .env.production.example .env            # ausfüllen: DOMAIN, PG_PASSWORD, CF_API_TOKEN, TWITCH_*, ADMIN_TWITCH_IDS
mkdir -p secrets import && openssl rand -hex 32 > secrets/token.key && chmod 600 secrets/token.key
docker compose up -d --build
docker compose ps                          # app, web: healthy; ingest, scheduler: running
curl -sk https://<DOMAIN>/healthz          # ok
```

Danach einmalig mit dem Bot-Konto `https://<DOMAIN>/api/auth/twitch/bot` öffnen, die Twitch-ID des Bots in `TWITCH_BOT_USER_ID` eintragen und `docker compose up -d` erneut ausführen.

Dienste: `postgres`, `redis`, `app` (API, Migrationen, Partitionen), `ingest` (Twitch-Signale), `scheduler` (Zeitgeber, Wartung, genau eine Instanz), `web` (Oberflächen), `caddy` (TLS, einziger Port), `backup` (Cron). Logs: `docker compose logs -f app` usw.

Mehr als ein Ingest-Worker (Lasttest: ab rund 1.000 Live-Kanälen): `INGEST_WORKERS=2` in `.env`, dazu in `docker-compose.yml` einen zweiten Dienst `ingest-1` wie `ingest` mit `INGEST_WORKER_INDEX: "1"` ergänzen.

## Update

```sh
cd /opt/cc-giveaway-ng && git pull
docker compose up -d --build               # Migrationen laufen beim Start jedes Prozesses
docker compose ps
```

Nach einem Update, das den Befehlsablauf, das Journal oder Projektionen anfasst, den Lasttest wiederholen (docs/lasttest.md).

## Stichtag: Übernahme des Altbestands (NEW_DESIGN.md 15.4)

Vorher: Neubau läuft (`healthz` ok), Betreiber ist im Neubau als Superadmin angemeldet, der Probelauf der Übernahme wurde mit einem aktuellen Export geübt.

1. **Altsystem einfrieren.** Im Altsystem (`/opt/team-giveaway`): `docker compose stop bridge` (ab jetzt bucht kein Tick mehr). Dann in dessen `.env` `READ_ONLY=true` und `RUN_SCHEDULER=false` setzen und `docker compose up -d giveaway`. Das Altsystem bleibt lesbar, Mechanik und Import sind zu (Antwort `423 read_only`).
2. **Export je Team.** Als Superadmin im Altsystem je Team `GET https://team.raumdock.org/giveaway/api/export?team=<teamId>` aufrufen und als `<teamId>.json` speichern. Antwortet der Export `409 export_checksum`, erst die Abweichung klären (Kanal und Differenz stehen in der Antwort).
3. **Dateien in den Neubau legen:** nach `/opt/cc-giveaway-ng/import/`.
4. **Probelauf je Datei:**
   ```sh
   docker compose run --rm app node dist/migration/legacy/cli.js --file /import/<teamId>.json --dry-run
   ```
   Bericht lesen (`/import/<teamId>.json.bericht.txt`): nicht auflösbare Logins, inaktive Kanäle, Begrenzungen, Sperren eines Solo-Teams.
5. **Lauf je Datei:** derselbe Befehl ohne `--dry-run`. Exit 0 = fertig, 1 = Abbruch vor dem Schreiben, 2 = einzelne Giveaways fehlgeschlagen (Bericht lesen, Wiederholung ist sicher).
6. **Streamer informieren:** anmelden, Kanal verbinden, Rechtstexte hinterlegen, Giveaway fortsetzen. Bis dahin bleibt es Pausiert.
7. **Berichte** nach 30 Tagen löschen (sie enthalten Logins): `rm /opt/cc-giveaway-ng/import/*.bericht.txt`.

### Altsystem danach

- Bleibt mit `READ_ONLY=true` lesbar bis zum Ende der Aufbewahrungsfrist; DSGVO-Anfragen zu Altdaten bedient weiter der Admin-Dienst des Altsystems.
- Archiv: je Sitzung `GET /giveaway/api/archive/<sid>/export` (tar.gz mit Ziehungsnachweis und Audit) nach `/opt/team-giveaway/archive/` ablegen, zusätzlich ein letztes Backup aus dem Dienst `backup` des Altsystems sichern.
- Abschalten nach Ablauf der Frist: `docker compose down` im Altsystem, Volumes erst nach einer letzten Sicherung löschen.

### Rollback (nur vor Schritt 6 sinnvoll)

```sh
cd /opt/cc-giveaway-ng && docker compose stop ingest scheduler app web
cd /opt/team-giveaway && sed -i 's/^READ_ONLY=.*/READ_ONLY=false/; s/^RUN_SCHEDULER=.*/RUN_SCHEDULER=true/' .env && docker compose up -d
```

Der Neubau behält seine Daten; ein erneuter Lauf der Übernahme überspringt schon übernommene Teams und Giveaways.

## Backups und Restore-Probe

- Täglich 03:00: `backup/backup.sh` schreibt `ccg_<zeit>.dump` (pg_dump, Custom-Format) ins Volume `backups`, hält 30 Tage, Manifest `manifest.json` mit Zeit, Datei, Größe und Ereigniszahl.
- Monatlich am 1. um 04:00: `backup/restore-check.sh` spielt den Dump aus dem Manifest in `ccg_restore_check` ein, vergleicht die Ereigniszahl, schreibt `restore-check.json`, löscht die Prüfdatenbank.
- Prüfen: `docker compose exec backup cat /backups/manifest.json` und `/backups/restore-check.json` (Feld `status`). Logs in `/backups/backup.log`, `/backups/restore-check.log`.
- Manuell: `docker compose exec backup sh /backup/backup.sh` bzw. `sh /backup/restore-check.sh`.
- Kopie außer Haus: das Volume liegt unter `docker volume inspect ccg_backups`; den Ordner regelmäßig per `rsync` auf einen anderen Host spiegeln.

## Wiederherstellung aus einem Dump

```sh
docker compose stop app ingest scheduler web
docker compose exec backup sh -c 'pg_restore --clean --if-exists --no-owner -d ccg /backups/ccg_<zeit>.dump'
docker compose up -d
```

Redis braucht keine Wiederherstellung (nur Pub/Sub). Nach dem Start baut die App Kern-Versionen ab und die Oberflächen verbinden neu.

## Störungen

| Lage | Was tun |
|---|---|
| `app` unhealthy | `docker compose logs app`; meist Konfiguration (`ConfigError` nennt den Wert) oder PostgreSQL nicht erreichbar. |
| Kanal rot in der Übersicht | Token abgelaufen: Streamer verbindet den Kanal neu. |
| Keine Signale (gelb) | `docker compose logs ingest`; Twitch-Fehler stehen mit Code am Kanal (`channel_status`). |
| Redis weg | App schließt Live-Verbindungen, Oberflächen verbinden neu; `docker compose up -d redis`. |
| Zertifikat fehlt | `docker compose logs caddy`; `CF_API_TOKEN` prüfen, DNS der Domain bei Cloudflare. |
| Ratelimit trifft alle zugleich | Der Edge reicht die Client-Adresse nicht durch; PROXY-Protokoll am Edge und in `caddy/Caddyfile` einschalten (Kommentar oben in der Datei). |
