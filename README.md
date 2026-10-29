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
| **Solo-Team** | Das Team, das jeder Streamer beim ersten Anmelden automatisch bekommt (`soloTeamId` im Konto). Giveaways gehören einem Team. |
| **Rechtstexte** | Impressum, Teilnahmebedingungen und Datenschutzhinweis. Je Giveaway oder im Profil. Beim Öffnen friert der Rahmen sie ein: Text als Kopie, URL mit SHA-256 des Inhalts (`giveaway_legal_frozen`). Ohne sie öffnet kein Giveaway. |
| **Teilprojekt** | Ein Abschnitt des Neubaus mit eigenem Umsetzungsplan (NEW_DESIGN.md, Abschnitt 14). Teilprojekte 1 bis 3 (Fundament, Kern-Vertrag + Kern B, Konten + Identität) sind fertig. |

## Prozesse

Zwei Prozesse aus `packages/server`:

- **app** (`npm run start:app`): HTTP-Server. Beim Start Migrationen, Partitionen und Kern-Versionsabgleich der Lesetabellen.
  - `GET /healthz`
  - `GET /auth/twitch/login?return=/pfad` → Twitch → `GET /auth/twitch/callback` setzt das Sitzungs-Cookie. `GET /auth/twitch/connect` verbindet den Kanal mit den Scopes `moderator:read:followers`, `moderator:read:chatters`, `channel:bot`. `POST /auth/logout`.
  - `GET /me`, `POST /me/terms {version}`, `PUT /me/profile {legal}`, `DELETE /me/channel`, `GET /me/data` (JSON-Export, Eintrag im Zugriffslog), `DELETE /me` (Löschung).
  - Ablehnungen antworten mit `{code, message}`: 401 ohne Sitzung, 403 fremde Person oder fremdes Team, 404 unbekannt, sonst 400.
- **scheduler** (`npm run start:scheduler`): holt sich zuerst den Einzelinstanz-Lock. Ein zweiter Scheduler bricht mit Hinweis ab.
  - Wartung stündlich: Partitionen anlegen, alte IP-Adressen entfernen, abgelaufene Sitzungen löschen, Konten ohne Anmeldung seit 365 Tagen löschen (Befehl mit Akteur `system:scheduler`).
  - Zeitgeber alle 5 s: fällige Einträge aus `timers` laufen als Kern-Befehl mit Akteur `system:scheduler`.
  - `timers` ist nur ein Spiegel der Kern-Zeitgeber, kein Zustand. Veraltete Zeilen löscht der Scheduler.
