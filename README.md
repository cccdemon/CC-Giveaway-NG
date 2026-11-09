# CC-Giveaway NG

Neubau der Giveaway-Plattform. Das Design steht in [NEW_DESIGN.md](NEW_DESIGN.md).

## Entwickeln

1. Node 24 und Docker installieren.
2. `npm ci` ausführen.
3. `docker compose -f docker-compose.dev.yml up -d` startet PostgreSQL und Redis.
4. `.env.example` nach `.env` kopieren. Twitch-App unter https://dev.twitch.tv/console anlegen, Redirect-URL = `PUBLIC_URL` + `/auth/twitch/callback`.
   Schlüssel für Kanal-Tokens anlegen: `mkdir secrets && openssl rand -hex 32 > secrets/token.key`.
5. `npm test` startet alle Tests. Die Tests starten eigene Container.

## Begriffe

Kurz erklärt, damit Code, Pläne und Gespräche dieselben Wörter meinen. Die
fachlichen Begriffe (Giveaway, Kern, Topf, Chance …) stehen in
[NEW_DESIGN.md, Abschnitt 2](NEW_DESIGN.md#2-glossar). Hier die technischen.

| Begriff | Bedeutung |
|---|---|
| **Ereignis** | Eine Tatsache, die passiert ist: „Teilnehmer X hat 60 s Zuschauzeit bekommen“. Wird einmal geschrieben, nie geändert. |
| **Journal** | Die Tabelle `events`, in der alle Ereignisse der Reihe nach stehen. Nur Anhängen, kein Ändern, kein Löschen. Das ist der Nachweis für alles. |
| **Strom** | Die Ereignisse, die zu einem Ding gehören, zum Beispiel `giveaway:<id>` oder `team:<id>`. Jeder Strom hat eine eigene laufende Nummer (`seq`), die lückenlos hochzählt. |
| **Stromsperre** | Bevor ein Ereignis an einen Strom angehängt wird, sperrt die Datenbank die Zeile dieses Stroms in `stream_heads`. Zwei gleichzeitige Befehle auf denselben Strom laufen dadurch nacheinander. So entscheidet die Datenbank, wer zuerst war, nicht der Zufall im Code. |
| **Befehl** | Der Wunsch, etwas zu ändern: „Giveaway pausieren“, „Signale anwenden“. Ein Befehl wird geprüft und erzeugt dann Ereignisse, oder er wird abgelehnt. |
| **Command-Bus** | Das eine Stück Code (`CommandBus.execute`), durch das jeder Befehl läuft: Rechte prüfen, Zustand laden, entscheiden, Ereignisse schreiben, Lesetabellen nachziehen, Oberflächen benachrichtigen. Es gibt keinen zweiten Weg, etwas zu ändern. |
| **Ablehnung** | Die Antwort des Command-Bus, wenn ein Befehl nicht erlaubt oder nicht möglich ist. Hat immer einen Code (`reason_required`) und einen deutschen Text für die Oberfläche. |
| **Zustand** | Das, was sich aus allen Ereignissen eines Stroms ergibt, zum Beispiel „Giveaway ist pausiert, 38 Teilnehmer, so viele Sekunden je Person“. |
| **Reducer** | Eine reine Funktion: alter Zustand + ein Ereignis = neuer Zustand. Kein Datenbankzugriff, keine Uhrzeit, kein Zufall. Darum nachrechenbar und testbar. |
| **Projektion** | Eine Lesetabelle, die aus Ereignissen gebaut wird, damit Oberflächen schnell lesen können. Wird in derselben Transaktion wie das Ereignis aktualisiert. Lässt sich jederzeit aus dem Journal neu aufbauen. |
| **Snapshot** | Eine Momentaufnahme des Zustands alle 1.000 Ereignisse eines Stroms. Spart das Nachrechnen von vorn. |
| **Umkehrung** | Ein Ereignis rückgängig machen. Drei Arten: `compensate` (Gegen-Ereignis, z. B. Entbannung), `void` (Ereignis wird für ungültig erklärt, bleibt sichtbar, z. B. Ziehung), `none` (geht nicht, die Oberfläche nennt den Grund). Braucht immer einen Grund. |
| **Formatversion** | Jeder Ereignistyp hat eine Versionsnummer seines Aufbaus. Ändert sich der Aufbau, steigt die Nummer. Alte Zeilen bleiben, wie sie sind. |
| **Upcaster** | Eine Funktion, die ein altes Ereignis beim Lesen in das aktuelle Format übersetzt. Pro Versionssprung eine. |
| **Partition** | Die Tabelle `events` ist nach Monaten in Teiltabellen zerlegt (`events_y2026m10`). Jeder Monat liegt für sich. Der Scheduler legt kommende Monate im Voraus an. |
| **Migration** | Eine nummerierte SQL-Datei in `packages/server/migrations/`, die das Datenbankschema ändert. Läuft beim Start genau einmal. Einzige Quelle für das Schema. |
| **Zugriffslog** | Die Tabelle `access_log`: abgelehnte Befehle und Lesezugriffe auf personenbezogene Daten. IP-Adressen werden nach 30 Tagen entfernt. |
| **Drossel** | Gleiche Ablehnungen (derselbe Akteur, derselbe Befehl, derselbe Grund) werden fünf Minuten lang zu einem Eintrag mit Zähler zusammengefasst. Sonst flutet ein pollendes Panel das Log. |
| **Akteur** | Wer einen Befehl auslöst: eine Nutzer-ID oder ein Systemteil wie `system:ingest`, `system:scheduler`, später `system:migration`. |
| **Korrelations-ID** | Eine UUID je Befehl. Alle Ereignisse, die aus einem Befehl entstehen, tragen dieselbe. Damit sieht man im Journal, was zusammengehört. |
| **pid** | Die interne, pseudonyme Teilnehmer-ID. Im Journal steht nie ein Twitch-Name oder eine Twitch-ID, nur die `pid`. Die Zuordnung liegt allein in `identities` und kann gelöscht werden. |
| **Rahmen** | Der Teil des Codes, der für alle Verlosungsarten gleich ist: Journal, Befehle, Ziehung, Oberflächen. |
| **Kern** | Ein Plugin für eine Verlosungsart (Zuschauzeit, Sofortverlosung, Tickets). Ein Kern rechnet nur, er hat keinen Datenbankzugriff. |
| **Ingest** | Der Teil, der von Twitch holt, was passiert: wer im Chat ist, wer schreibt, wer folgt, ob der Stream läuft. |
| **Scheduler** | Der Zeitgeber-Prozess: legt Partitionen an, räumt IP-Adressen weg, beendet später Anmeldefenster und Boosts. Davon darf genau einer laufen. |
| **Einzelinstanz-Lock** | Die Absicherung, dass wirklich nur ein Scheduler läuft: Beim Start holt er sich eine Sperre in PostgreSQL (`pg_advisory_lock`). Ein zweiter Scheduler bekommt sie nicht und bricht mit Hinweis ab. |
| **Advisory Lock** | Eine Sperre in PostgreSQL, die nicht an einer Tabellenzeile hängt, sondern an einer Nummer, die wir selbst wählen. Wir nutzen sie für Migrationen, Partitionen und die Drossel. |
| **Idempotent** | Ein Vorgang, den man beliebig oft wiederholen kann, ohne dass sich das Ergebnis ändert. Beispiel: die Übernahme aus dem Altsystem überspringt beim zweiten Lauf, was schon da ist. |
| **Kontrollsumme** | Eine Zahl zum Gegenprüfen, zum Beispiel die Summe aller Sekunden je Kanal. Stimmt sie nicht mit der Quelle überein, bricht der Import ab, bevor etwas geschrieben wird. |
| **Rolling Deploy** | Neue Version wird Instanz für Instanz ausgerollt. Kurzzeitig laufen alte und neue Version nebeneinander. Darum lehnt alter Code Ereignisse einer neueren Formatversion ab, statt sie falsch zu lesen. |
| **Healthcheck** | `GET /healthz`. Antwortet `ok`, wenn die Datenbank antwortet, sonst 503 mit Grund. Docker und Caddy fragen das ab. |
| **Testcontainers** | Die Tests starten sich eigene PostgreSQL- und Redis-Container in Docker. Keine fremde Datenbank wird je angefasst. |
| **Typecheck / Lint** | `npm run typecheck` prüft Typen (TypeScript), `npm run lint` prüft Regeln, zum Beispiel dass ein Kern nur `kernel-api` importiert. Beides läuft in der CI. |
| **CI** | GitHub Actions. Bei jedem Push: Typecheck, Lint, alle Tests. Kein Merge ohne grün. |
| **Konto** | Der Strom `account:<pid>`: Zustimmung zu den Nutzungsbedingungen, Rechtstexte im Profil, verbundener Kanal, Löschung. Entsteht beim ersten Anmelden mit Twitch. |
| **Identität** | Die Zeile in `identities`: `pid` ↔ Twitch-ID, Login, Anzeigename. Die einzige Stelle mit Twitch-Daten. Löschen entfernt sie, das Journal zeigt dann „gelöschter Teilnehmer #<kurz-id>“. |
| **Sitzung** | Eine Zeile in `sessions` plus das Cookie `ccg_session` (HttpOnly, 30 Tage). Liegt in PostgreSQL, damit ein Redis-Ausfall niemanden abmeldet. |
| **Kanal-Token** | Die Twitch-Tokens eines Streamers in `channel_tokens`, AES-256-GCM-verschlüsselt. Der Schlüssel liegt in der Datei aus `TOKEN_KEY_FILE`, nie in der Datenbank. |
| **Solo-Team** | Das Team, das jeder Streamer beim ersten Anmelden automatisch bekommt (`soloTeamId` im Konto). Giveaways gehören einem Team. Es hat keinen eigenen Strom, sein einziger Kanal ist der eigene. |
| **Team** | Der Strom `team:<id>`: Name, Mitglieder, Einladungen, Sperren, aktiv oder deaktiviert. Entsteht über `POST /teams`, Beitritt per Einladungslink. Alle Mitglieder sind gleichberechtigt und steuern jedes Giveaway des Teams. Die Kanäle eines Giveaways sind Mitglieder des Teams. Deaktivieren verhindert neue Giveaways und Beitritte, löscht keine Nachweise, laufende Giveaways bleiben steuerbar. Das letzte Mitglied kann nicht austreten. |
| **Einladung** | Ein Link `PUBLIC_URL/teams/join/<inviteId>`, 7 Tage gültig, mehrfach nutzbar, bis ein Mitglied ihn widerruft. Beitritt braucht ein vollständiges Konto (Nutzungsbedingungen, Kanal). |
| **Sperre** | Team-weit: `POST /teams/:id/bans {pid}`. Eine gesperrte Person kann sich in keinem Giveaway des Teams anmelden, ihre Signale zählen nicht, die Ziehung schließt sie mit Grund `banned` aus. Aufheben über `DELETE /teams/:id/bans/:pid` oder Rückgängig. Die Zuordnung einer gesperrten Person bleibt über die Löschfristen hinaus erhalten, sonst käme sie mit neuer `pid` zurück. |
| **Rechtstexte** | Impressum, Teilnahmebedingungen und Datenschutzhinweis. Je Giveaway oder im Profil. Beim Öffnen friert der Rahmen sie ein: Text als Kopie, URL mit SHA-256 des Inhalts (`giveaway_legal_frozen`). Ohne sie öffnet kein Giveaway. |
| **Signal** | Was der Ingest von Twitch holt: Anwesenheit (wer ist im Chat, je Minute), Chat-Nachricht, Follow, Live-Status mit Zuschauerzahl. Signale tragen Twitch-Nutzer. Erst der Rahmen macht daraus `pid`s. |
| **Bündel** | Alle Signale eines Kanals in einer Minute. Fließt 5 s nach Minutenende ab und wird je offenem Giveaway des Kanals ein Befehl `apply_signals` mit Akteur `system:ingest`. |
| **Adapter** | Die Quelle der Signale: `twitch` (echte Twitch-API) oder `simulator` (erzeugt Signale im Prozess, deterministisch je Seed). Beide erfüllen dieselbe Schnittstelle. |
| **Conduit / Shard** | Twitch liefert EventSub-Benachrichtigungen (Chat, Follow, Live-Status) über ein Conduit je Plattform. Jeder Ingest-Worker hält einen Shard davon über eine WebSocket-Verbindung. Kanäle werden per Hash auf Worker verteilt, nur der zuständige Worker pollt die Anwesenheit. |
| **Plattform-Bot** | Ein Twitch-Konto des Betreibers, über das die Plattform Chat liest und Ansagen sendet. Es erteilt der App einmal die Rechte `user:bot`, `user:read:chat`, `user:write:chat`. Danach reichen App-Tokens. `TWITCH_BOT_USER_ID` ist seine Twitch-ID. |
| **Signalqualität** | Die Tabelle `channel_status`: live/offline, Zuschauerzahl, Chatters, letztes Signal, Problem. Betriebsdaten des Ingest, kein Nachweis, nicht im Journal. Der Statusblock warnt: rot (Token ungültig), gelb (live ohne Signal über 2 Minuten, Twitch antwortet nicht), Hinweis (Abdeckung unter 50 %). |
| **Zuschauzeit** | Der Rahmen-Dienst, der aus der Anwesenheit je Minute das Ereignis `watch_credited` macht: 60 s je anwesender `pid`, je Kanal und Minute genau einmal. Nur Kanäle im Giveaway, nur im Zustand Offen. |
| **Coin** | Einheit von Kern A und Kern C: Zuschauzeit ÷ Coin-Basis (Default 2 h), abgerundet. Kern A: Topf = alle mit mindestens 1 Coin, Gewicht = Coins. Kern C: Coins kaufen Tickets. |
| **Geldbörse** | Die Coins einer Person in einem Giveaway von Kern C: verdient minus für Tickets ausgegeben. Es gibt kein Guthaben über Giveaways hinweg. Eine Zeit-Korrektur ins Minus lässt gekaufte Tickets stehen. |
| **Ticket** | Ein mit Coins gekauftes Los (Kern C `tickets`). Befehl `buy_tickets` im Portal oder `!ticket <n>` im Chat, nur für angemeldete Teilnehmer, nur im Zustand Offen. Preis je Ticket und Höchstzahl je Person sind Einstellungen. Topf = alle mit mindestens 1 Ticket, Gewicht = Tickets. Rückgängig eines Kaufs und der Abbruch erstatten die gezahlten Coins (`tickets_refunded`). |
| **Chat-Befehl** | Das Wort eines Kern-Befehls im Chat (z. B. `!ticket 3`): erstes Wort gleich dem Wort, zweites Wort die Anzahl. Läuft im Befehl `apply_signals`, nur für Teilnehmer. Eine Ablehnung bleibt bis Teilprojekt 8 ohne Antwort im Chat. Ein Keyword darf keinem Chat-Befehl gleichen. |
| **Chat-Bonus** | Sekunden für Chatnachrichten ab 4 Wörtern (Default +2 s, 10 s Cooldown je Person), gebündelt als `chat_credited` je Kanal und Minute. Zählt nur, wenn der Kanal live ist und Signale liefert. Abschaltbar, Werte bleiben. |
| **Boost** | Faktor 2 bis 10 für 1 Minute bis 24 Stunden auf Zuschauzeit und Chat-Bonus. Startet nur mit einem aktiven Kanal, läuft über Pausen weiter, das Ende setzt der Scheduler per Zeitgeber `framework:stop_boost`. |
| **Zeit-Korrektur** | Das Ereignis `watch_corrected`: der Streamer bucht Sekunden nach oder ab, mit Grund. Es ist auch das Gegen-Ereignis jeder Gutschrift (Rückgängig). |
| **Bedingung** | Follow (alle Kanäle, mindestens N, ein Kanal), Mindestalter des Twitch-Kontos, Mindestalter des Follows, Anwesenheit in N Kanälen. Verbindlich prüft sie die App bei der Ziehung live bei Twitch, vor der Sperre. Antwortet Twitch nicht, bricht die Ziehung ab, ohne Ereignis. |
| **Zählweise** | Je Giveaway: „ab Anmeldung“ (nur angemeldete Teilnehmer sammeln) oder „ab erstem Erscheinen“ (jeder Anwesende bekommt eine `pid` und sammelt, gewinnen können nur Angemeldete). |
| **Keyword** | Ein Wort im Chat (z. B. `!werwolf`), mit dem sich ein Zuschauer anmeldet. Erstes Wort der Nachricht, Groß- und Kleinschreibung egal. Dieselben Regeln wie der Knopf im Portal. |
| **Löschfrist** | Unangemeldete `pid`s der Zählweise „ab erstem Erscheinen“ verlieren ihre Zuordnung Schließen + 7 Tage (einstellbar) nach dem Giveaway: Befehl `purge_unregistered`, Ereignis `unregistered_purged`, die `identities`-Zeile fällt. Nie, wenn die Person ein Konto hat, irgendwo angemeldet oder Gewinner ist oder in einem anderen laufenden Giveaway gesehen wurde. |
| **Teilprojekt** | Ein Abschnitt des Neubaus mit eigenem Umsetzungsplan (NEW_DESIGN.md, Abschnitt 14). Teilprojekte 1 bis 7 (Fundament, Kern-Vertrag + Kern B, Konten + Identität, Ingest, Rahmen-Dienste + Kern A, Kern C Ticketkauf, Teams) sind fertig. |

## Prozesse

Drei Prozesse aus `packages/server`:

- **app** (`npm run start:app`): HTTP-Server. Beim Start Migrationen, Partitionen und Kern-Versionsabgleich der Lesetabellen.
  - `GET /healthz`
  - `GET /auth/twitch/login?return=/pfad` → Twitch → `GET /auth/twitch/callback` setzt das Sitzungs-Cookie. `GET /auth/twitch/connect` verbindet den Kanal mit den Scopes `moderator:read:followers`, `moderator:read:chatters`, `channel:bot`. `POST /auth/logout`.
  - `GET /me`, `POST /me/terms {version}`, `PUT /me/profile {legal}`, `DELETE /me/channel`, `GET /me/channel` (Statusblock des eigenen Kanals), `GET /me/data` (JSON-Export, Eintrag im Zugriffslog), `DELETE /me` (Löschung).
  - `GET /auth/twitch/bot`: Anmeldung mit dem Bot-Konto, erteilt der App die Bot-Rechte (siehe „Bot einrichten“).
  - Teams: `GET /me/teams`, `POST /teams {name}`, `GET /teams/:id` (nur Mitglieder), `PUT /teams/:id/name`, `POST /teams/:id/invites` → Einladungslink, `DELETE /teams/:id/invites/:inviteId`, `GET /teams/join/:inviteId` (ohne Sitzung: Name und Gültigkeit), `POST /teams/join/:inviteId`, `POST /teams/:id/leave|deactivate|reactivate`, `POST /teams/:id/bans {pid}`, `DELETE /teams/:id/bans/:pid`.
  - Ablehnungen antworten mit `{code, message}`: 401 ohne Sitzung, 403 fremde Person oder fremdes Team, 404 unbekannt, sonst 400.
  - Nur die App prüft Bedingungen bei der Ziehung (Helix mit dem Token des Streamers und App-Token). Scheduler und Ingest ziehen nicht.
- **scheduler** (`npm run start:scheduler`): holt sich zuerst den Einzelinstanz-Lock. Ein zweiter Scheduler bricht mit Hinweis ab.
  - Wartung stündlich: Partitionen anlegen, alte IP-Adressen entfernen, abgelaufene Sitzungen löschen, Konten ohne Anmeldung seit 365 Tagen löschen (Befehl mit Akteur `system:scheduler`).
  - Zeitgeber alle 5 s: fällige Einträge aus `timers` laufen als Kern-Befehl mit Akteur `system:scheduler`.
  - `timers` ist nur ein Spiegel der Kern- und Rahmen-Zeitgeber (`framework:stop_boost` beendet einen Boost), kein Zustand. Veraltete Zeilen löscht der Scheduler.
  - Wartung stündlich zusätzlich: Löschfrist für Unangemeldete (`purge_unregistered` je fälligem Giveaway, Akteur `system:scheduler`).
- **ingest** (`npm run start:ingest`, Entwicklung: `npm run dev:ingest -w packages/server`): holt Signale und sendet Befehle. Schreibt nie ins Journal.
  - `INGEST_ADAPTER=twitch|simulator` (Default `twitch`). Der Simulator braucht keine Twitch-Daten: `INGEST_SIM_VIEWERS` (Default 20), `INGEST_SIM_SEED` (Default 1).
  - Mehrere Worker: `INGEST_WORKERS` (Default 1) und je Prozess `INGEST_WORKER_INDEX` (0 bis Workers − 1). Worker 0 legt das Conduit an, die anderen warten darauf.
  - Alle 30 s liest er das Kanalverzeichnis: verbundene Kanäle mit gültigem Token. Kanäle in einem offenen Giveaway bekommen Chat, Follow und Anwesenheit je Minute, alle anderen nur Live-Status und Zuschauerzahl.
  - Je Bündel ein Befehl `apply_signals` je offenem Giveaway des Kanals. Er prüft Rechte, Zustand und Kanal, löst Twitch-IDs zu `pid`s auf (legt sie nur für Unbekannte an, die in diesem Bündel eine Anmeldung oder Gutschrift bekommen) und schreibt Keyword-Anmeldung, Kern-Ereignisse aus Chat-Befehlen (z. B. `tickets_bought` aus `!ticket 2`), `watch_credited` und `chat_credited`. Signale für Kanäle, die nicht live sind oder keine Signale liefern, bringen keinen Chat-Bonus.
  - Twitch-Fehler: drei Versuche mit 1 s, 2 s, 4 s. Danach steht `twitch_error` am Kanal, der nächste Minutenlauf versucht es wieder. Ein abgelehnter Token-Refresh setzt das Token auf `invalid`, der Kanal wird rot, bis der Streamer ihn neu verbindet.

### Bot einrichten

Der Twitch-Adapter liest Chat und sendet Ansagen über ein Bot-Konto des Betreibers.

1. Ein Twitch-Konto für den Bot anlegen oder wählen.
2. Mit diesem Konto bei Twitch angemeldet `PUBLIC_URL/auth/twitch/bot` öffnen und alle Rechte bestätigen.
3. Die Twitch-ID des Bot-Kontos als `TWITCH_BOT_USER_ID` setzen (steht nach der Anmeldung in `GET /me/data` unter `identity.twitchId`).

Ohne `TWITCH_BOT_USER_ID` startet der Ingest mit `INGEST_ADAPTER=twitch` nicht.
