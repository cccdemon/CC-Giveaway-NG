# Teilprojekt 9: Übernahme des Altbestands – Umsetzungsplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Laufende und pausierte Viewtime-Kampagnen des Altsystems (`CORE_WatchtimeChatActivity`) laufen nach dem Stichtag im Neubau weiter, mit denselben Sekunden je Teilnehmer und Kanal, mit Anmeldung, Zustimmungsfassung und team-weitem Bann (NEW_DESIGN.md 15). Dazu ein Export v2 im Altsystem und das wiederverwendbare Werkzeug `migrate-legacy` im Neubau mit Probelauf, Bericht, Kontrollsumme und Idempotenz.

**Architecture:** Das Altsystem bekommt eine letzte Änderung: `exportTeam` liefert `version: 2` mit `team` und allen Viewtime-Instanzen samt `pgWatchSum` je Kanal; der Export bricht ab, wenn Redis und `watchtime_events` abweichen. Im Neubau liest `migrate-legacy` nur die Datei, prüft Format und Kontrollsummen vor dem ersten Netzzugriff, löst Logins per Helix `Get Users` (App-Token) auf und schreibt ausschließlich über `CommandBus.execute` mit Akteur `system:migration`: `sign_in` (Solo-Streamer), `import_legacy_team` (Mehrpersonen-Team mit Mitgliedern und Sperren), `import_legacy_giveaway` (ein Giveaway je Alt-Instanz). Twitch-Daten stehen nur im Befehl, `prepare` legt Identitäten an, `decide` schreibt nur pids. Das Giveaway entsteht aus `giveaway_created` plus dem Dienst-Ereignis `legacy_imported` (Rahmen: Zustand Pausiert oder Geschlossen, Anmeldungen mit Zustimmungsfassung, `seen`; Kern A: Sekunden je pid und Kanal). Fortsetzen und Wiederöffnen frieren Rechtstexte ein, wenn noch keine Fassung eingefroren ist. IDs sind deterministisch (UUIDv5 aus Alt-ID), Lesetabellen `legacy_imports` und `legacy_teams` machen den zweiten Lauf zum Überspringen.

**Tech Stack:** wie bisher. Keine neue Abhängigkeit (UUIDv5 über `node:crypto`). Altsystem: Node, `node --test`, In-Memory-Mocks.

**Spec:** `NEW_DESIGN.md` 3.3, 3.4, 5.1 (Akteur `system:migration`), 5.3 (`none`), 6.1 (Zählweise „ab erstem Erscheinen“), 6.4 (Fassung der Zustimmung), 7.1 (Zustände), 9.3, 9.4 (ohne Rechtstexte öffnet nichts), 12.5, 13 (#12, #14, #15), 15 (vollständig).

## Global Constraints

- Jede Änderung im Neubau läuft über `CommandBus.execute` mit Akteur `system:migration`. Kein Schreiben an der Runtime vorbei, auch nicht in `identities` (nur in `prepare`).
- Payloads tragen nur pids, Alt-IDs (`sess_…`, Team-ID des Altsystems) und Texte. Nie Login, Twitch-ID oder Anzeigename (`assertNoTwitchIdentity`).
- Kontrollsumme vor dem ersten Schreiben: Summe `watchSec` je Kanal in der Datei = `pgWatchSum`. Abweichung → Abbruch, Bericht nennt Kanal und Differenz. Nicht auflösbare Logins sind keine Abweichung, der Bericht weist ihre Sekunden je Kanal aus.
- `--dry-run` löst per Helix auf und schreibt nichts (null Ereignisse).
- Idempotent: zweiter Lauf mit derselben Datei schreibt kein Ereignis und sagt im Bericht „übersprungen“.
- Der Bericht enthält Logins und liegt neben der Datei. Er ist kein Teil des Journals.
- Alle Texte deutsch nach 11.6. Je Task erst Code, dann `typecheck`, `lint`, `test`. Altsystem: `node --test tests/*.test.js` in `services/giveaway`.

## Entscheidungen, die die Spec offen lässt (meine Festlegungen)

1. **Format v2** (`format: 'cc-giveaway-backup'`, `version: 2`), eine Datei je Alt-Team. Behält alle Felder von v1 (das Altsystem importiert damit weiter seine eigenen Backups) und ergänzt:
   ```json
   {
     "team": { "id": "team_x", "name": "…", "members": [{ "login": "a", "twitchId": "123", "channel": "a" }], "banned": ["b"] },
     "instances": [{
       "sessionId": "sess_1", "name": "…", "keyword": "!werwolf", "channels": ["a", "c"], "open": true, "paused": false,
       "cfg": { "coin_base_sec": 7200, "follow_min": 2, "chat_enabled": true, "chat_bonus_sec": 2, "chat_min_words": 4, "chat_cooldown": 10 },
       "prize": "…", "sponsor": "…", "termsVersion": 3, "termsText": "…",
       "participants": [{ "login": "z", "registered": true, "perChannel": { "a": { "watchSec": 1234.5 } } }],
       "pgWatchSum": { "a": 1235, "c": 0 }
     }]
   }
   ```
   `instances` enthält nur Instanzen mit `core = CORE_WatchtimeChatActivity` und `closed_at IS NULL`. `twitchId` eines Mitglieds kann `null` sein (Altsystem ohne Login über team.raumdock.org), dann löst der Neubau per Login auf. `termsVersion 0` = kein Text (`termsText: null`). Sekunden sind im Altsystem Gleitkommazahlen, der Neubau rundet je Eintrag (`Math.round`), die Kontrollsumme vergleicht die gerundete Summe mit `pgWatchSum` mit Toleranz von höchstens 1 s je Teilnehmer und Kanal (Rundung), sonst Abweichung.
2. **Deterministische IDs** statt Zufall: `giveawayId = uuidv5(NS_GIVEAWAY, sessionId)`, Team-ID eines Mehrpersonen-Teams `uuidv5(NS_TEAM, legacyTeamId)`, Solo-Team eines neu angelegten Kontos `uuidv5(NS_SOLO, twitchId)`. So trifft ein zweiter Lauf auf `already_exists` und derselbe Streamer bekommt dieselbe pid-Zuordnung, egal wann er sich anmeldet (`identities.twitch_id` entscheidet). Zusätzlich die Lesetabellen aus der Spec: `legacy_imports (legacy_session_id UNIQUE, giveaway_id, imported_at)` über einen Projector auf `legacy_imported`, `legacy_teams (legacy_team_id UNIQUE, team_id, imported_at)` über einen Projector auf `team_imported`. Migration `010_legacy.sql`.
3. **Ereignisse.** `legacy_imported` ist ein Dienst-Ereignis des Dienstes `watchtime` (`FRAMEWORK_EVENTS.legacyImported`, `SERVICE_EVENTS.watchtime` in `kernel-api`): der Rahmen registriert es (`services.ts`, v1, `none`, Grund „Altbestand. Korrektur über Zeit-Korrektur.“), der Rahmen-Reducer setzt daraus Zustand, Anmeldungen und `seen`, Kern A (und jeder Kern mit Dienst `watchtime`) reduziert die Sekunden. Payload: `{ legacySessionId: string, status: 'paused' | 'closed', terms: { version: number, text: string } | null, registered: Pid[], entries: [{ pid, channel, sec }] }` (`sec` ganzzahlig ≥ 1, `channel` = pid des Kanal-Inhabers). Die Spec nennt es „Kern-Ereignis für Kern A“; als Dienst-Ereignis bleibt der Kern frei von Rahmenwissen und der Rahmen braucht keinen Kern-Typnamen. `team_imported { legacyTeamId }` ist ein eigener Typ im Team-Strom (v1, `none`), geschrieben direkt nach `team_created` im selben Befehl; die normalen Team-Ereignisse tragen den Akteur `system:migration` (Frage aus 15.9 damit entschieden: eigener Typ nur für die Zuordnung, sonst normale Ereignisse).
4. **Zustand nach dem Import** über `legacy_imported`: `open=true` → `paused` (auch wenn das Altsystem `paused=false` meldet), `open=false` → `closed` mit `closedAt` = Importzeit (Löschfrist läuft ab Import). `registered[pid] = { since: Importzeit, eventId: <legacy_imported>, legalEventId: <legacy_imported> | null }`, `seen[pid]` = alle Kanäle mit Sekunden. Zählweise `first_seen`, `purgeDays 7`, `claimDays 14`, `winnersCount 1`, `announcements` Default, `contact null`. Gewinner, Boosts, Nachrichtenzähler entfallen.
5. **Regeln:** `coinBaseSec` aus `coin_base_sec` auf 60…360 000 begrenzt; Chat-Bonus aus `chat_*` auf die Schema-Grenzen begrenzt (Bonus 1…60, Wörter 1…20, Cooldown 1…600); `follow_min ≥ 1` → Bedingung `{ id: 'follow', mode: 'min', min }` mit `min` höchstens Zahl der Kanäle, `0` → keine Bedingung; Keyword nur, wenn es `KEYWORD_RE` erfüllt, sonst `null`. Jede Begrenzung oder Streichung steht im Bericht.
6. **Rechtstexte:** `termsText` wird zu `settings.legal = { impressumUrl: null, terms: { text }, privacyUrl: null }`, damit der Streamer nur Impressum und Datenschutzhinweis ergänzt. Die Fassung der Zustimmung steht im `legacy_imported`-Ereignis (`terms`), `registered[pid].legalEventId` zeigt darauf. `change_settings` sperrt `legal` erst, wenn eine Fassung eingefroren ist (`state.legal !== null`), nicht mehr ab „nicht Entwurf“: für normale Giveaways dasselbe Verhalten, für importierte bleibt `legal` bis zum Fortsetzen änderbar.
7. **Fortsetzen und Wiederöffnen** laufen über denselben Handler wie Öffnen (`openGiveawayHandler(d, type)` für `open_giveaway` aus Entwurf, `resume_giveaway` aus Pausiert, `reopen_giveaway` aus Geschlossen). Ist `state.legal` schon eingefroren, schreibt er nur den Übergang (kein Netz). Ist nichts eingefroren, prüft er Impressum, Teilnahmebedingungen und Datenschutzhinweis (`legal_required`), holt die Hashes und schreibt `giveaway_legal_frozen` vor dem Übergang. Spätere Anmeldungen zeigen auf die neue Fassung, importierte behalten ihre.
8. **Portal:** `GET /portal/giveaways/:id` liefert `consent: { at, terms: { text } | { url } | null } | null` aus dem Ereignis, auf das `registered[pid].legalEventId` zeigt (`giveaway_legal_frozen` → `terms`, `legacy_imported` → `terms.text`). Die Portal-Seite zeigt unter den Rechtstexten „Du hast am {Datum} zugestimmt.“ und bei abweichendem Text die zugestimmte Fassung aufklappbar.
9. **Teams.** Ein Alt-Team mit genau einem Mitglied: Solo-Team. Gibt es das Konto (gleiche `twitch_id`) schon, nutzt der Import `accounts.solo_team_id`; sonst `sign_in` mit Akteur `system:migration` (neu erlaubt neben `system:twitch`) und deterministischer Solo-Team-ID. Meldet sich der Streamer später per Twitch an, findet der Login die pid über `identities.twitch_id` und `sign_in` schreibt nichts Neues. Mehrpersonen-Team: `import_legacy_team { teamId, legacyTeamId, name, members: TwitchUser[], banned: TwitchUser[] }`, `prepare` legt Identitäten an, `decide` schreibt `team_created { name, members }`, `team_imported { legacyTeamId }` und je Sperre `participant_banned { pid }`. Mitglieder ohne Konto bekommen keins; beim ersten Twitch-Login entsteht es wie heute, die Mitgliedschaft (pid) gilt schon. Nicht auflösbare Mitglieder fallen weg (Bericht); ohne auflösbares Mitglied wird das Team samt Giveaways übersprungen (Bericht). **Sperren eines Solo-Teams** lassen sich nicht übernehmen (das Solo-Team hat keinen Strom und keine Sperrliste, Teilprojekt 7): der Bericht nennt jede mit Login als „nicht übernommen“.
10. **Kanäle:** `instances[].channels` sind Logins. Der Import löst sie auf, legt Identitäten an und trägt die pid in `settings.channels` ein, ohne Teamprüfung (`import_legacy_giveaway` nutzt `anyChannels`-Verhalten). Ein Kanal, dessen Inhaber kein Mitglied ist, gilt als „inaktiv“ im Sinn von Teilprojekt 7 (Signale werden abgelehnt, Sekunden bleiben); der Bericht nennt ihn. Ein nicht auflösbarer Kanal-Login macht das Giveaway nicht importierbar (Sekunden ließen sich keinem Kanal zuordnen): dieses Giveaway wird mit Grund übersprungen, der Lauf geht weiter.
11. **Teilnehmer ohne Sekunden** (nur angemeldet) werden importiert (Identität, `registered`), ohne `seen`-Eintrag. Teilnehmer ohne Sekunden und ohne Anmeldung fallen weg (Bericht zählt sie). Sperren ohne Teilnahme werden trotzdem übernommen (Mehrpersonen-Team).
12. **Helix:** `HelixClient.getUsersByLogin(logins)` (`GET /users?login=…`, 100 je Aufruf, App-Token, Backoff wie alle Aufrufe). Port `LoginResolver { byLogin(logins): Promise<Map<login, TwitchUser>> }`, Umsetzung über Helix; Tests nutzen einen Stub. Logins werden in Kleinbuchstaben verglichen. Nach drei Fehlversuchen wirft der Client, der Lauf bricht vor dem ersten Schreiben ab.
13. **Lauf** (`run.ts`): 1. Datei lesen und parsen (Format, Version). 2. Kontrollsummen je Instanz und Kanal. 3. Alle Logins sammeln (Mitglieder, Kanäle, Teilnehmer, Gesperrte) und auflösen. 4. Vorhandenes lesen (`legacy_teams`, `legacy_imports`, `accounts` über `identities.twitch_id`). 5. Je Team: Solo oder Team anlegen (oder überspringen). 6. Je Instanz: `import_legacy_giveaway` (oder überspringen). Jeder Befehl ist eine Transaktion; eine Ablehnung oder ein Fehler mitten im Lauf lässt fertige Giveaways stehen, der Bericht nennt den Fehler, Exit-Code 2. Im Probelauf enden die Schritte 5 und 6 als „würde anlegen“.
14. **Bericht** (`report.ts`): reiner Text, deutsch. Kopf (Datei, Probelauf ja/nein, Zeit), Team (Solo/Team, angelegt/vorhanden/übersprungen), je Giveaway: Alt-ID, Name, Ziel-ID, Zustand, Teilnehmer gesamt/importiert/angemeldet, Sekunden je Kanal (importiert, `pgWatchSum`, nicht übernommen), nicht auflösbare Logins mit Sekunden je Kanal, inaktive Kanäle, Begrenzungen, Grund bei Überspringen. Summen am Ende. Datei `<datei>.bericht.txt` (überschreibt), zusätzlich auf der Konsole.
15. **CLI:** `npm run migrate-legacy -- --file <pfad> [--dry-run]` ruft `node dist/migration/legacy/cli.js` (nach `npm run build`; Entwicklung `npx tsx src/migration/legacy/cli.ts`). Konfiguration aus `.env` wie die Prozesse (`loadConfig`), Migrationen laufen beim Start, Publisher Redis (importierte Giveaways erscheinen live), Runtime wie der Scheduler (`denyUsers`, `attachAccounts`, `attachPlatform(noAdmins)`). Exit-Codes: 0 fertig, 1 Abbruch vor dem Schreiben (Datei, Version, Kontrollsumme, Helix), 2 Lauf mit Fehlern.
16. **Altsystem:** `GET /api/export` erlaubt zusätzlich `streamers.is_platform_admin` (Superadmin). `importTeam` nimmt Version 1 und 2 (liest nur die v1-Felder). Kontrollsumme im Export: Summe `watchSec` (gerundet) je Kanal und Instanz gegen `SUM(delta_sec)` aus `watchtime_events` je `session_id` und `channel`; Abweichung → Fehler `export_checksum` mit Kanal und Differenz, kein Export. Die Primär-Kampagne liest ihre Zähler mit `_readMech` (g:-Key vor Legacy-Key) wie heute.
17. **Nicht hier:** Lasttest, Caddy, Archiv-tar.gz des Altsystems (Teilprojekt 10, Betrieb), Oberfläche für den Import (CLI reicht, Betreiber fährt den Stichtag allein).

## Review Focus

1. Kein Twitch-Login und keine Twitch-ID im Journal: Befehle tragen `TwitchUser`, Ereignisse nur pids (Test in Task 2 mit `assertNoTwitchIdentity` über alle geschriebenen Payloads). Test in Task 2 und 4.
2. Sekunden: importierte Sekunden je Kanal = `pgWatchSum` minus „nicht übernommen“; Abweichung bricht vor dem ersten Schreiben ab. Test in Task 1 (rein) und Task 4 (Lauf).
3. Idempotenz: zweiter Lauf schreibt kein Ereignis, Bericht sagt „übersprungen“; vorhandenes Konto wird mit seinem Solo-Team genutzt. Test in Task 4.
4. Kern A nach `legacy_imported` = Zustand, als hätte der Rahmen minütlich gebucht (`sec`, `pool`, `viewerView`). Test in Task 2.
5. Fortsetzen ohne Rechtstexte lehnt mit `legal_required` ab, mit Rechtstexten friert es ein und öffnet; normale Giveaways verhalten sich wie bisher. Test in Task 3.

---

## Dateistruktur

```
packages/server/src/shared/uuid.ts                            uuidV5(namespace, name)
packages/server/src/kernel-api/index.ts                       FRAMEWORK_EVENTS.legacyImported, SERVICE_EVENTS.watchtime, LegacyImportedPayload
packages/server/src/kernels/watchtime/index.ts                reduce(legacy_imported)
packages/server/src/framework/giveaway/services.ts            legacyImportedSchema, Registrierung
packages/server/src/framework/giveaway/state.ts               Reducer: legacy_imported
packages/server/src/framework/giveaway/lifecycle.ts           checkSettings exportiert, legal_locked nur nach Einfrieren
packages/server/src/framework/giveaway/open.ts                openGiveawayHandler(d, type) für open/resume/reopen
packages/server/src/framework/giveaway/legacy.ts              import_legacy_giveaway
packages/server/src/framework/team/events.ts                  team_imported
packages/server/src/framework/team/commands.ts                import_legacy_team
packages/server/src/framework/legacy-projectors.ts            legacy_imports, legacy_teams
packages/server/src/framework/runtime.ts                      handlers.importLegacy, teams.importLegacy, Projektoren
packages/server/migrations/010_legacy.sql
packages/server/src/identity/account/commands.ts              sign_in für system:migration
packages/server/src/ingest/twitch/helix.ts                    getUsersByLogin
packages/server/src/api/portal.ts                             consent
packages/server/src/migration/legacy/{format,ids,resolve,run,report,cli}.ts
packages/server/test/fixtures/legacy/export-v2.json
packages/server/test/legacy-format.test.ts, legacy-import.test.ts, watchtime-kernel (+), lifecycle (+), open (+), api-portal (+), ingest-helix (+), team (+)
packages/server/package.json                                  script migrate-legacy
packages/web/src/lib/api/types.ts, routes/portal/giveaways/[id]/+page.svelte, texts/*   consent
../CC-Giveaway/services/giveaway/watchtime.js                 exportTeam v2, importTeam v1+v2
../CC-Giveaway/services/giveaway/server.js                    GET /api/export für Superadmin
../CC-Giveaway/services/giveaway/tests/watchtime.test.js (+)
README.md, CLAUDE.md, ../CC-Giveaway/CLAUDE.md
```

---

### Task 1: Format v2, Kontrollsumme, IDs, Helix-Auflösung

**Files:**
- Create: `src/shared/uuid.ts`, `src/migration/legacy/format.ts`, `src/migration/legacy/ids.ts`, `src/migration/legacy/resolve.ts`, `test/fixtures/legacy/export-v2.json`
- Modify: `src/ingest/twitch/helix.ts`
- Test: `test/legacy-format.test.ts`, `test/ingest-helix.test.ts` (+)

**Interfaces:**
- `uuid.ts`: `export function uuidV5(namespace: string, name: string): string` (RFC 4122, SHA-1, Version 5, Variante 10).
- `ids.ts`: `NS_GIVEAWAY`, `NS_TEAM`, `NS_SOLO` (feste UUIDs), `giveawayIdOf(sessionId)`, `teamIdOf(legacyTeamId)`, `soloTeamIdOf(twitchId)`.
- `format.ts`:
  ```ts
  export const BACKUP_FORMAT = 'cc-giveaway-backup'; export const BACKUP_VERSION = 2;
  export interface LegacyMember { login: string; twitchId: string | null; channel: string }
  export interface LegacyParticipant { login: string; registered: boolean; perChannel: Record<string, { watchSec: number }> }
  export interface LegacyInstance { sessionId: string; name: string; keyword: string; channels: string[]; open: boolean; paused: boolean; cfg: { coin_base_sec: number; follow_min: number; chat_enabled: boolean; chat_bonus_sec: number; chat_min_words: number; chat_cooldown: number }; prize: string | null; sponsor: string | null; termsVersion: number; termsText: string | null; participants: LegacyParticipant[]; pgWatchSum: Record<string, number> }
  export interface LegacyBackup { team: { id: string; name: string; members: LegacyMember[]; banned: string[] }; instances: LegacyInstance[]; exportedAt?: string }
  export class LegacyFormatError extends Error { code: 'invalid_json' | 'wrong_format' | 'wrong_version' | 'invalid_shape' }
  export function parseBackup(text: string): LegacyBackup;          // wirft LegacyFormatError mit erwarteter Version im Text
  export interface ChecksumDeviation { sessionId: string; channel: string; fileSum: number; pgWatchSum: number }
  export function checkSums(backup: LegacyBackup): ChecksumDeviation[];   // Festlegung 1: gerundete Summe, Toleranz Teilnehmer je Kanal
  export function loginsOf(backup: LegacyBackup): string[];           // alle Logins, klein, eindeutig
  ```
- `resolve.ts`: `export interface LoginResolver { byLogin(logins: string[]): Promise<Map<string, TwitchUser>> }`, `export function helixLoginResolver(helix: Pick<HelixClient, 'getUsersByLogin'>): LoginResolver` (Blöcke zu 100, Schlüssel = Login klein).
- `helix.ts`: `getUsersByLogin(logins: string[]): Promise<HelixUser[]>`.
- Fixture: nach dem Prod-Befund (eine echte Kampagne mit 38 Zuschauern, 12 Anmeldungen, 33 h über zwei Kanäle, zwei Testkampagnen davon eine geschlossen), Logins ersetzt, dazu ein Mitglied ohne `twitchId`, ein Kanal ohne Mitglied, ein gesperrter Login, ein nur angemeldeter Teilnehmer ohne Sekunden.

- [ ] **Step 1: Tests schreiben**

```ts
// legacy-format.test.ts
it('parseBackup accepts the v2 fixture and rejects version 1, a foreign format, broken JSON and a missing instances field with the expected version in the message', ...);
it('checkSums is empty for the fixture, reports channel and difference when watchSec and pgWatchSum diverge, and tolerates rounding of fractional seconds', ...);   // RF 2
it('loginsOf collects members, channels, participants and banned logins lowercase and unique', ...);
it('uuidV5 matches RFC 4122 test vectors and ids are stable for the same legacy id', ...);
it('helixLoginResolver resolves in chunks of 100 and keys by lowercase login; unknown logins are missing', ...);
// ingest-helix.test.ts (+)
it('getUsersByLogin sends login query parameters in chunks of 100', ...);
```

- [ ] **Step 2: Tests laufen lassen, sie scheitern**
- [ ] **Step 3: Implementieren**
- [ ] **Step 4: Prüfen** (`typecheck`, `lint`, `test`)
- [ ] **Step 5: Commit** `feat(migration): Export-Format v2 lesen, Kontrollsumme, deterministische IDs, Logins per Helix auflösen`

---

### Task 2: Ereignisse, Reducer, Projektionen, Befehle

**Files:**
- Create: `src/framework/giveaway/legacy.ts`, `src/framework/legacy-projectors.ts`, `migrations/010_legacy.sql`
- Modify: `src/kernel-api/index.ts`, `src/kernels/watchtime/index.ts`, `src/framework/giveaway/{services,state,lifecycle}.ts`, `src/framework/team/{events,commands}.ts`, `src/framework/runtime.ts`, `src/identity/account/commands.ts`
- Test: `test/legacy-import.test.ts` (Befehle), `test/watchtime-kernel.test.ts` (+), `test/team.test.ts` (+), `test/account.test.ts` (+), `test/event-types.test.ts` (+)

**Interfaces:**
- `kernel-api`: `FRAMEWORK_EVENTS.legacyImported = 'legacy_imported'`, `SERVICE_EVENTS.watchtime` enthält es, `export interface LegacyImportedPayload { legacySessionId: string; status: 'paused' | 'closed'; terms: { version: number; text: string } | null; registered: Pid[]; entries: { pid: Pid; channel: Pid; sec: number }[] }`.
- `services.ts`: `legacyImportedSchema` (zod, `sec` int ≥ 1, `entries` min 0, `registered` uuid[]), Registrierung in `registerServiceEvents` mit `reversal: { kind: 'none', why: LEGACY_WHY }`, `LEGACY_WHY = 'Altbestand. Korrektur über Zeit-Korrektur.'`.
- `state.ts`: Reducer-Fall `legacy_imported` (Festlegung 4).
- `watchtime/index.ts`: `reduce` addiert `entries` mit Faktor 1 und übernimmt `registered`.
- `lifecycle.ts`: `export function checkSettings(kernel, s)`; `legal_locked` nur bei `state.legal !== null`.
- `legacy.ts`:
  ```ts
  export interface ImportLegacyGiveawayCmd {
    giveawayId: string; teamId: string; legacySessionId: string;
    prize: string; sponsor: string | null; keyword: string | null; coinBaseSec: number; followMin: number;
    chatBonus: { enabled: boolean; sec: number; minWords: number; cooldownSec: number };
    channels: TwitchUser[]; status: 'paused' | 'closed'; terms: { version: number; text: string } | null;
    participants: { user: TwitchUser; registered: boolean; perChannel: Record<string, number> }[];   // Schlüssel = twitchId des Kanals, Wert = Sekunden
  }
  export function importLegacyGiveawayHandler(d: GiveawayDeps & { identities: IdentityResolver }): CommandHandler<ImportLegacyGiveawayCmd, GiveawayState, Map<string, Pid>>;
  ```
  `authorize`: nur `system:migration` (`migration_only`). `prepare`: `identities.create(c, [...channels, ...participants.map(p => p.user)], now)` → Map twitchId → pid. `decide`: `exists` → `already_imported`; Kern `watchtime` muss registriert sein; Einstellungen über `checkSettings` (Festlegung 5, `legal` aus `terms`, Festlegung 6); Einträge `sec ≥ 1` nach Rundung; Ereignisse `[giveaway_created, legacy_imported]`.
- `team/commands.ts`: `ImportLegacyTeamCmd { teamId; legacyTeamId; name; members: TwitchUser[]; banned: TwitchUser[] }`, `importLegacyTeamHandler(auth, identities)` mit `prepare` (Identitäten) und `decide` (`team_created`, `team_imported`, `participant_banned` je Sperre, Gesperrte, die auch Mitglied sind, werden nicht gesperrt und abgelehnt mit `banned_member`); `team/events.ts`: `team_imported` v1 `{ legacyTeamId: string }` `none`.
- `legacy-projectors.ts`: `legacyImportsProjector()` (Projector auf `legacy_imported` → `INSERT … ON CONFLICT DO NOTHING`), `legacyTeamsProjector()` (auf `team_imported`), beide mit `reset`. Registrierung in `createRuntime` nach den Giveaway- und Team-Projektoren.
- `runtime.ts`: `RuntimeOptions.identities` wird auch an die Import-Handler gereicht; `handlers.importLegacy`, `teams.importLegacy`.
- `account/commands.ts`: `sign_in` erlaubt `system:migration`.
- `010_legacy.sql`: `legacy_imports (legacy_session_id TEXT PRIMARY KEY, giveaway_id UUID NOT NULL, imported_at TIMESTAMPTZ NOT NULL)`, `legacy_teams (legacy_team_id TEXT PRIMARY KEY, team_id UUID NOT NULL, imported_at TIMESTAMPTZ NOT NULL)`.

- [ ] **Step 1: Tests schreiben**

```ts
// watchtime-kernel.test.ts (+)
it('reduce(legacy_imported) equals the state after minute-wise watch_credited: sec per pid and channel, pool, viewerView, registered', ...);   // RF 4
// legacy-import.test.ts (Befehle)
it('import_legacy_giveaway writes giveaway_created and legacy_imported with pids only, state is paused or closed, registered entries point to the import event, seen holds the channels, kernel holds the seconds; participants and legacy_imports rows exist', ...);   // RF 1
it('import_legacy_giveaway rejects users, a second import of the same session (already_imported), an unknown kernel setup and clamps config and follow gate', ...);
it('import_legacy_team creates team, team_imported, bans and legacy_teams; a user actor is rejected; the second call is already_exists', ...);
it('sign_in with system:migration creates identity and account; the later Twitch sign_in reuses pid and solo team', ...);
// event-types.test.ts (+)
it('legacy_imported and team_imported are none with their reason', ...);
```

- [ ] **Step 2: Tests laufen lassen, sie scheitern**
- [ ] **Step 3: Implementieren**
- [ ] **Step 4: Prüfen**
- [ ] **Step 5: Commit** `feat(giveaway): Übernahme-Befehle import_legacy_team und import_legacy_giveaway mit Ereignis legacy_imported`

---

### Task 3: Fortsetzen friert Rechtstexte ein, Portal zeigt die Zustimmungsfassung

**Files:**
- Modify: `src/framework/giveaway/open.ts`, `src/framework/runtime.ts`, `src/api/portal.ts`, `src/api/giveaways-read.ts` (nur falls Hilfsfunktion), web `src/lib/api/types.ts`, `src/routes/portal/giveaways/[id]/+page.svelte`, `src/lib/texts/{labels,sentences}.ts`
- Test: `test/open.test.ts` (+ oder `lifecycle.test.ts`), `test/api-portal.test.ts` (+), web `src/routes/portal/giveaways/[id]/page.test.ts` (+)

**Interfaces:**
- `open.ts`: `openGiveawayHandler(d: OpenDeps, type: 'open_giveaway' | 'resume_giveaway' | 'reopen_giveaway')`; `pre`: Zustand laden, falscher Ausgangszustand → `skip`, `state.legal !== null` → `{ kind: 'frozen' }`, sonst wie heute; `decide`: `frozen` → nur `giveaway_status_changed`; `ready` → `legal_frozen` + Übergang. `runtime.ts`: `resume` und `reopen` aus diesem Handler, `transitionHandler` nur noch für pause/close/cancel/complete.
- `portal.ts`: `consent` (Festlegung 8), gelesen mit `readEvent` über `registered[pid].legalEventId`.
- Web: `PortalGiveaway.consent`, Zeile `S.portal.consentedAt(date)` plus `<details>` mit `L.portal.consentedTerms` bei Text.

- [ ] **Step 1: Tests schreiben**

```ts
// open.test.ts (+)
it('resume_giveaway of an imported giveaway without legal rejects legal_required, with profile legal it freezes and opens; reopen behaves the same; a normally opened giveaway resumes without fetching', ...);   // RF 5
it('change_settings may change legal before freezing and is locked after', ...);
// api-portal.test.ts (+)
it('portal detail returns consent with the terms text of the version the participant agreed to', ...);
// web page.test.ts (+)
it('shows the consent date and the agreed terms', ...);
```

- [ ] **Step 2: Tests laufen lassen, sie scheitern**
- [ ] **Step 3: Implementieren**
- [ ] **Step 4: Prüfen** (Server und Web: `typecheck`, `lint`, `test`)
- [ ] **Step 5: Commit** `feat(giveaway): Fortsetzen und Wiederöffnen frieren Rechtstexte ein, Portal zeigt die Zustimmungsfassung`

---

### Task 4: Lauf, Bericht, CLI

**Files:**
- Create: `src/migration/legacy/run.ts`, `src/migration/legacy/report.ts`, `src/migration/legacy/cli.ts`
- Modify: `package.json` (`migrate-legacy`)
- Test: `test/legacy-import.test.ts` (+ Lauf), `test/legacy-report.test.ts`

**Interfaces:**
- `run.ts`:
  ```ts
  export interface RunOptions { pool: pg.Pool; rt: Runtime; accounts: AccountHandlers; resolver: LoginResolver; dryRun: boolean; now?: () => Date; log?: BusLogger }
  export interface RunResult { aborted: { code: 'checksum' | 'helix'; message: string } | null; teams: TeamReport[]; giveaways: GiveawayReport[]; unresolved: { login: string; secondsByChannel: Record<string, number> }[]; failed: number }
  export async function runImport(backup: LegacyBackup, o: RunOptions): Promise<RunResult>;
  ```
  Ablauf nach Festlegung 13. `TeamReport { legacyTeamId; kind: 'solo' | 'team'; teamId: string | null; outcome: 'created' | 'existing' | 'skipped' | 'would_create'; reason?: string; bansSkipped: string[] }`, `GiveawayReport { sessionId; name; giveawayId; status; outcome: 'created' | 'skipped' | 'would_create' | 'failed'; reason?: string; participants: { total; imported; registered; dropped }; channels: { login; pid: string | null; imported: number; pgWatchSum: number; notImported: number; inactive: boolean }[]; notes: string[] }` (Begrenzungen als `notes`).
- `report.ts`: `export function renderReport(file: string, dryRun: boolean, at: Date, r: RunResult): string` (Festlegung 14), `export function reportPathOf(file: string): string`.
- `cli.ts`: Argumente, Datei lesen, `parseBackup`, `runImport`, Bericht schreiben und ausgeben, Exit-Code (Festlegung 15). Fehler der Datei vor Helix (`LegacyFormatError` → Exit 1 mit Hinweis).

- [ ] **Step 1: Tests schreiben**

```ts
// legacy-import.test.ts (+ Lauf, Testcontainers, Stub-Resolver)
it('runImport imports the fixture: solo team via sign_in, giveaways paused and closed, seconds per channel equal pgWatchSum minus unresolved, participants projection matches', ...);   // RF 2
it('runImport with a multi-member team creates the team with bans; a one-member team with bans reports them as not imported', ...);
it('a second run writes no event and reports every team and giveaway as skipped; a streamer who signed in before keeps pid and solo team', ...);   // RF 3
it('dry run resolves logins, writes nothing and lists unresolved logins with seconds', ...);
it('an unresolvable participant is dropped with login and seconds in the report; an unresolvable channel skips only that giveaway', ...);
it('a checksum deviation aborts before any write; a resolver that throws aborts with helix and writes nothing', ...);   // RF 2
it('every payload written by the run passes assertNoTwitchIdentity', ...);   // RF 1
// legacy-report.test.ts
it('renderReport names file, dry run, teams, giveaways, seconds per channel, unresolved logins, skipped and failed with sums', ...);
```

- [ ] **Step 2: Tests laufen lassen, sie scheitern**
- [ ] **Step 3: Implementieren**
- [ ] **Step 4: Prüfen**
- [ ] **Step 5: Commit** `feat(migration): Werkzeug migrate-legacy mit Probelauf, Bericht und Idempotenz`

---

### Task 5: Export v2 im Altsystem

**Repo:** `../CC-Giveaway` (eigener Commit dort, Conventional Commits deutsch).
**Files:**
- Modify: `services/giveaway/watchtime.js` (`exportTeam`, `importTeam`), `services/giveaway/server.js` (`GET /api/export`), `services/giveaway/tests/watchtime.test.js` (+), `CLAUDE.md` (Hinweis Export v2)

**Interfaces:**
- `exportTeam(teamId)` → Festlegung 1 und 16: v1-Felder bleiben, `version: 2`, `team` (aus `teams`, `team_members` mit `login`, `channel`, `streamers.twitch_id`; `banned` aus `K.gwBanned` über `K.gwUsers`), `instances` (Primär-Kampagne über `gwOpen`/`gwSessionId` plus `gwSet`, nur `core = CORE_WatchtimeChatActivity` mit `closed_at IS NULL` laut `sessions`), je Instanz `participants` mit `perChannel.watchSec` (nur Kanäle mit Sekunden oder Anmeldung), `pgWatchSum` aus `SELECT channel, COALESCE(SUM(delta_sec),0)::bigint AS sum FROM watchtime_events WHERE session_id=$1 GROUP BY channel`. Abweichung → `throw Object.assign(new Error(…), { code: 'export_checksum' })`, Route antwortet 409 `{ error: 'export_checksum', channel, diff }`.
- `importTeam`: `Number(data.version)` 1 oder 2.
- `GET /api/export`: `ownsTeam || isPlatformAdmin(login)` (`SELECT is_platform_admin FROM streamers WHERE login=$1`).

- [ ] **Step 1: Tests schreiben** (In-Memory-Mocks um die neuen Queries erweitern: `team_members` mit `login`/`channel`, `streamers`, `sessions`, `watchtime_events`-Summen)

```js
test('exportTeam v2 lists team, members, banned and every open viewtime instance with pgWatchSum', ...);
test('exportTeam aborts with export_checksum naming channel and difference when redis and pg diverge', ...);
test('importTeam accepts version 2 and restores the v1 fields', ...);
```

- [ ] **Step 2: Tests laufen lassen, sie scheitern**
- [ ] **Step 3: Implementieren**
- [ ] **Step 4: Prüfen** (`node --test tests/*.test.js` in `services/giveaway`)
- [ ] **Step 5: Commit** (im Altsystem) `feat(export): Backup v2 mit allen Viewtime-Instanzen, Kontrollsumme und Superadmin-Zugriff`

---

### Task 6: Doku

- [ ] README (Begriffe Übernahme, Export v2, Bericht; Prozess `migrate-legacy` mit Ablauf am Stichtag aus 15.4; Route `/portal/giveaways/:id` `consent`; Stand „9 fertig, als Nächstes 10“), CLAUDE.md (Stand, Abschnitt Übernahme, `legacy_imported`, `team_imported`, open/resume/reopen, `sign_in` für Migration, `checkSettings`), `.env.example` unverändert (keine neue Variable), Commit `docs: Übernahme des Altbestands, Stand Teilprojekt 9`.

---

## Selbstprüfung gegen die Spec

- 15.2 Ziele 1–3: Sekunden je Teilnehmer und Kanal (Task 2, 4), wiederverwendbar und mehrfach ausführbar (Task 4), Bericht je Lauf (Task 4).
- 15.2 Anti-Ziele: Kontrollsumme und „nicht übernommen“ (Task 1, 4), kein Login im Journal (Task 2, 4), ein Schreibweg (Task 2, 4).
- 15.3 Team, Giveaway, Gewinn/Sponsor, Regeln, Zählweise, Teilnehmer, Kanal, Anmeldung, Bann, Teilnahmebedingungen (Task 2, Festlegungen 4–11).
- 15.4 Schritt 6: Giveaway bleibt Pausiert, Fortsetzen verlangt Rechtstexte (Task 3); Zustimmung bleibt gültig, Portal zeigt die Fassung (Task 3).
- 15.5 Export v2 mit Kontrollsumme und Superadmin (Task 5).
- 15.6 Modul, CLI, nur Datei, Version, Helix, Identitäten, `system:migration`, `legacy_imported`, `none`, Idempotenz, Kontrollsumme, Probelauf, Bericht (Task 1, 2, 4).
- 15.7 Fehlertabelle (Task 1, 4).
- 15.8 Tests: Format, Auflösung, Kontrollsumme, Idempotenz, Kern A, Journal, Ablauf (Task 1, 2, 4).
- 15.9: Kanal-Markierung über Teilprojekt 7 (Festlegung 10), `team_imported` eigener Typ (Festlegung 3), Akteur vorhanden, Team-Befehl mit Mitgliedern (Task 2).
