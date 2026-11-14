# Betrieb

Runbook für Deploy, Stichtag, Rollback und Wiederherstellung (NEW_DESIGN.md 12.3, 12.5, 15.4). Ziel ist ein eigener Container auf dem Proxmox-Host: LXC 112 „giveaway“ (10.10.10.46, Ubuntu 24.04, unprivileged mit `nesting=1,keyctl=1`, 4 Kerne, 4 GB, 60 GB). Das Altsystem bleibt auf LXC 103 (10.10.10.99).

## Voraussetzungen

- LXC 112 mit Docker CE und Docker Compose v2 (eingerichtet am 14.11.2026). Zugang über den Host: `ssh -i ~/.ssh/claude_deploy root@ve.raumdock.org`, dann `pct exec 112 -- bash`. Feste Adresse per DHCP-Reservierung (`/etc/dnsmasq.d/giveaway.conf` auf dem Host).
- Eine Domain für den Neubau (z. B. `giveaway.raumdock.org`): DNS-A-Record bei Cloudflare auf die öffentliche IP des Hosts, Edge-Eintrag auf LXC 101 (`/etc/nginx/stream.d/minecraft.raumdock.org.conf`): in der SNI-Map `giveaway.raumdock.org giveaway_lxc;` und `upstream giveaway_lxc { server 10.10.10.46:443; }`, danach `nginx -t && systemctl reload nginx`. Im eigenen Container sind 80/443 frei, darum `CADDY_PORT=443`.
- Cloudflare-API-Token mit `Zone:DNS:Edit` für die Domain (TLS per DNS-01, kein Port 80 nötig).
- Twitch-App mit Redirect-URL `https://<DOMAIN>/api/auth/twitch/callback` und ein Bot-Konto (README „Bot einrichten“).
- Twitch-IDs der Betreiber für `ADMIN_TWITCH_IDS`.
- Reicht der Edge die Client-Adresse nicht durch (SNI-Passthrough ohne PROXY-Protokoll), gelten die Ratelimits in Caddy für alle Nutzer zusammen (`/api/auth/*` 30 je Minute, also höchstens 15 Anmeldungen je Minute). Dann PROXY-Protokoll am Edge aktivieren und in `caddy/Caddyfile` den `listener_wrappers`-Block aus dem Kommentar einschalten.

## Erstinstallation

```sh
cd /opt && git clone -b main-ng https://github.com/cccdemon/CC-Giveaway-NG.git cc-giveaway-ng && cd cc-giveaway-ng   # Produktionsstand liegt auf dem Branch main-ng
cp .env.production.example .env            # ausfüllen: DOMAIN, CADDY_PORT=443, PG_PASSWORD, CF_API_TOKEN, TWITCH_*, ADMIN_TWITCH_IDS
mkdir -p secrets import && openssl rand -hex 32 > secrets/token.key
chmod 700 secrets && chmod 444 secrets/token.key   # die Prozesse laufen als Nutzer node (uid 1000) und lesen den Schlüssel über ein Bind-Mount
chown 1000:1000 import                              # Berichte der Übernahme schreibt derselbe Nutzer
docker compose build
docker compose run --rm app node -e "require('node:fs').readFileSync('/run/secrets/token.key'); console.log('Schlüssel lesbar')"
docker compose up -d
docker compose ps                          # app, web, backup: healthy; scheduler: running; ingest: running erst mit TWITCH_BOT_USER_ID (sonst Neustartschleife mit ConfigError)
curl -sk https://<DOMAIN>/healthz          # ok
docker compose logs caddy | grep remote_ip # Zugriffslog: die Adresse muss die des Clients sein, nicht die des Edge (sonst gilt jedes Ratelimit für alle zusammen)
```

Danach einmalig mit dem Bot-Konto `https://<DOMAIN>/api/auth/twitch/bot` öffnen, die Twitch-ID des Bots in `TWITCH_BOT_USER_ID` eintragen und `docker compose up -d` erneut ausführen.

Dienste: `postgres`, `redis`, `app` (API, Migrationen, Partitionen), `ingest` (Twitch-Signale), `scheduler` (Zeitgeber, Wartung, genau eine Instanz), `web` (Oberflächen), `caddy` (TLS, einziger Port), `backup` (Cron). Logs: `docker compose logs -f app` usw.

Auf CT 112 ist der Stand vom 14.11.2026 schon vorbereitet (`/opt/cc-giveaway-ng`, `secrets/token.key`, `import/`, `.env` mit Domain, Port und Datenbankpasswort); es fehlen `CF_API_TOKEN`, `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, `TWITCH_BOT_USER_ID`, `ADMIN_TWITCH_IDS`.

Mehr als ein Ingest-Worker (Lasttest: ab rund 1.000 Live-Kanälen): `INGEST_WORKERS=2` in `.env`, dazu in `docker-compose.yml` den auskommentierten Dienst `ingest-1` einkommentieren (Merge-Syntax `<<: *server-env` mit eigenem `INGEST_WORKER_INDEX`).

## Update

```sh
cd /opt/cc-giveaway-ng && git pull origin main-ng
docker compose up -d --build               # Migrationen laufen beim Start jedes Prozesses
docker compose ps
```

Nach einem Update, das den Befehlsablauf, das Journal oder Projektionen anfasst, den Lasttest wiederholen (docs/lasttest.md).

## Stichtag: Übernahme des Altbestands (NEW_DESIGN.md 15.4)

Vorher: Neubau läuft (`healthz` ok), Betreiber ist im Neubau als Superadmin angemeldet, der Probelauf der Übernahme wurde mit einem aktuellen Export geübt.

1. **Altsystem einfrieren.** Im Altsystem (`/opt/team-giveaway`): `docker compose stop bridge` (ab jetzt bucht kein Tick mehr). Dann in dessen `.env` `READ_ONLY=true` setzen und `docker compose up -d giveaway`. Das Altsystem bleibt lesbar, Mechanik, Import und Ingest sind zu (Antwort `423 read_only`); Ticker und Sofort-Watcher stehen, die Löschfristen (Retention) laufen weiter. Abweichung von NEW_DESIGN.md 15.4 Schritt 3: das Altsystem wird nicht gestoppt, sondern nur lesbar gehalten, damit Export und Datenschutz weiter bedient werden.
2. **Export je Team.** Als Superadmin im Altsystem je Team `GET https://team.raumdock.org/giveaway/api/export?team=<teamId>` aufrufen und als `<teamId>.json` speichern. Antwortet der Export `409 export_checksum`, erst die Abweichung klären (Kanal und Differenz stehen in der Antwort).
3. **Dateien in den Neubau legen:** nach `/opt/cc-giveaway-ng/import/`.
4. **Probelauf je Datei:**
   ```sh
   docker compose run --rm app node dist/migration/legacy/cli.js --file /import/<teamId>.json --dry-run
   ```
   Bericht lesen (Konsole und `import/<teamId>.json.bericht.txt`; anderer Ort über `--report <pfad>`): nicht auflösbare Logins, inaktive Kanäle, Begrenzungen, Sperren eines Solo-Teams.
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
cd /opt/team-giveaway && sed -i 's/^READ_ONLY=.*/READ_ONLY=false/' .env && docker compose up -d
```

Der Neubau behält seine Daten; ein erneuter Lauf der Übernahme überspringt schon übernommene Teams und Giveaways.

## Backups und Restore-Probe

- Täglich 03:00: `backup/backup.sh` schreibt `ccg_<zeit>.dump` (pg_dump, Custom-Format) ins Volume `backups`, hält 30 Tage, Manifest `manifest.json` mit Zeit, Datei, Größe und Ereigniszahl.
- Monatlich am 1. um 04:00: `backup/restore-check.sh` spielt den Dump aus dem Manifest in `ccg_restore_check` ein, vergleicht die Ereigniszahl, schreibt `restore-check.json`, löscht die Prüfdatenbank.
- Prüfen: `docker compose ps backup` (healthy = letztes Backup jünger als 26 h, kein Fehler danach, Restore-Probe ok), `docker compose exec backup cat /backups/manifest.json` (`eventsBefore`/`eventsAfter` = Spanne während des Dumps), `/backups/last-error.json`, `/backups/restore-check.json`. Logs in `/backups/backup.log`, `/backups/restore-check.log`. Die Probe braucht vorübergehend Platz für eine zweite Datenbank.
- Manuell: `docker compose exec backup sh /backup/backup.sh` bzw. `sh /backup/restore-check.sh`.
- Kopie außer Haus: das Volume liegt unter `docker volume inspect ccg_backups`; den Ordner regelmäßig per `rsync` auf einen anderen Host spiegeln.

## Wiederherstellung aus einem Dump

```sh
docker compose stop app ingest scheduler web backup
docker compose exec postgres sh -c 'dropdb -U ccg ccg && createdb -U ccg ccg'
docker compose cp backup:/backups/ccg_<zeit>.dump /tmp/ccg.dump   # oder direkt aus dem Volume
docker compose cp /tmp/ccg.dump postgres:/tmp/ccg.dump
docker compose exec postgres pg_restore --exit-on-error --no-owner -U ccg -d ccg /tmp/ccg.dump
docker compose exec postgres psql -U ccg -d ccg -At -c 'SELECT count(*) FROM events'   # muss in der Spanne eventsBefore..eventsAfter des Manifests liegen
docker compose up -d
```

Redis braucht keine Wiederherstellung (nur Pub/Sub). Nach dem Start gleicht die App die Kern-Versionen ab und die Oberflächen verbinden neu.

## Störungen

| Lage | Was tun |
|---|---|
| `app` unhealthy | `docker compose logs app`; meist Konfiguration (`ConfigError` nennt den Wert) oder PostgreSQL nicht erreichbar. |
| Kanal rot in der Übersicht | Token abgelaufen: Streamer verbindet den Kanal neu. |
| Keine Signale (gelb) | `docker compose logs ingest`; Twitch-Fehler stehen mit Code am Kanal (`channel_status`). |
| Redis weg | App schließt Live-Verbindungen, Oberflächen verbinden neu; `docker compose up -d redis`. |
| Zertifikat fehlt | `docker compose logs caddy`; `CF_API_TOKEN` prüfen, DNS der Domain bei Cloudflare. |
| Ratelimit trifft alle zugleich | Der Edge reicht die Client-Adresse nicht durch; PROXY-Protokoll am Edge und in `caddy/Caddyfile` einschalten (Kommentar oben in der Datei). |
