# Teilprojekt 8a: Giveaway-API, Portal-API, Live-Push, Text-Linter – Umsetzungsplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Alles, was die Oberflächen (Teilprojekt 8b, 8c) vom Server brauchen: Lese- und Befehls-Routen für Streamer (Übersicht, Detail, Teilnehmer, Verlauf mit Rückgängig, Start-Assistent, alle Aktionen), Routen für das Teilnehmer-Portal (eigene Giveaways, Chance, Bedingungen, Teilnehmen, Tickets, Gewinn), eine öffentliche Giveaway-Seite, Live-Push per WebSocket aus Redis Pub/Sub, und der deutsche Text-Linter aus Spec 11.6 in der CI.

**Architecture:** Routen bleiben dünn: jede Zustandsänderung ist ein `bus.execute`, jede Liste liest Lesetabellen, jede Detail-Ansicht lädt den Zustand des Stroms per `loadStreamState` (Snapshot + Replay, wie `/me`), weil Kern-Zustand (`viewerView`, Topf) nur dort liegt. Rechte: `GiveawayAuthorizer.controls` für Streamer-Routen, eigene pid für Portal-Routen. Der Verlauf liest Ereignisse seitenweise aus dem Journal und ergänzt je Eintrag Umkehrart und Umkehrstatus. Live-Push: ein `Subscriber` (Redis `psubscribe events:*`, in Tests ein lokaler Bus) verteilt je Ereignis nur `{ stream, seq, type, id, at }` an berechtigte WebSocket-Verbindungen, Oberflächen laden danach neu. Der Text-Linter ist reine Logik in `src/shared/text-rules.ts` plus ein Skript, das alle `reject(...)`-Texte und `why`-Texte im Quellcode prüft.

**Tech Stack:** TypeScript, Node 24, Fastify, pg, zod, ioredis, Vitest, Testcontainers. Eine neue Abhängigkeit: `@fastify/websocket` (bringt `ws` mit; Spec 3.2 nennt WebSocket).

**Spec:** `NEW_DESIGN.md` Abschnitte 3.2, 3.3, 5.3, 5.5, 6.5, 7.1–7.3, 9.4, 11.1–11.3, 11.6, 12.1, 12.2, 14 (Punkt 8). Offen für 8b/8c: 11.4 (Verwaltung), 11.5 (Design), SvelteKit-Oberflächen, Chat-Ansagen (10.3).

## Global Constraints

- Jede Zustandsänderung läuft durch `CommandBus.execute`; Routen schreiben nie direkt.
- Listen lesen Lesetabellen. Detail-Ansichten laden den Zustand per `loadStreamState` (Snapshot + Replay), nie den ganzen Strom roh an den Client.
- Payloads an den Client enthalten Anzeigenamen nur aus `identities` über `displayNameOf`; jede Route, die Namen Dritter liefert, schreibt `logRead` (Spec 5.5). Twitch-IDs verlassen den Server nie, außer an die eigene Person (`/me/data`, bestehend).
- Ablehnungen antworten `{ code, message }` über `rejectionToHttp`; neue 403-Codes dort eintragen.
- Push-Nachrichten tragen keine Payloads, nur `stream`, `seq`, `type`, `id`, `at`.
- UI- und Fehlertexte deutsch, aktiv, höchstens 20 Wörter, kein Semikolon, Glossar-Begriffe; der neue Linter erzwingt Satzlänge, Semikolon, Bannliste und Passiv-Heuristik in der CI.
- Formatänderung eines Ereignistyps: `giveaway_created` und `giveaway_settings_changed` auf v3 (Feld `contact`), Upcaster 2→3, Test.
- Tests nur gegen Testcontainers, kein Netz; WebSocket-Tests gegen einen lokalen Fastify-Server auf Port 0.
- Je Task erst den Code fertig schreiben, dann einmal `npm run typecheck`, `npm run lint`, `npm test`.

## Entscheidungen, die die Spec offen lässt (meine Festlegungen)

1. **Kontaktweg des Streamers (7.3):** neues Feld `GiveawaySettings.contact: string | null` (höchstens 200 Zeichen, freier Text wie „Discord: name“), änderbar wie andere Regeln, auch nach dem Schließen nicht gesperrt? Nein: wie alle Regeln nur bis Geschlossen (7.1), darum beim Anlegen setzen. Ereignisse v3, Upcaster setzt `contact: null`.
2. **Detail per Replay:** `GET /giveaways/:id` und `GET /portal/giveaways/:id` laden `GiveawayState` per `loadStreamState`. Das ist der bestehende Weg von `/me` und nötig für `viewerView`. Snapshots alle 1000 Ereignisse halten das billig. Listen bleiben auf Lesetabellen.
3. **Verlauf seitenweise:** `readStreamPage(db, registry, stream, { beforeSeq?, limit })` in `journal/journal.ts` liefert absteigend nach `seq`, `limit` 1–200 (Default 50). Je Eintrag: `id`, `seq`, `type`, `at`, `actor` (`{ kind: 'system' | 'user', pid?, displayName? }`), `reason`, `reversesEventId`, `reverted` (`isReverted`), `reversal` (`{ kind: 'compensate' | 'void' }` oder `{ kind: 'none', why }`), `payload` (roh, nur pids). Anzeigenamen der Akteure sind Mitgliedsnamen, darum `logRead` `view_history`.
4. **Routen-Form für Befehle:** jeder Befehl antwortet `200 { events: [{ id, seq, type }] }`, Anlegen `201 { giveawayId, events }`. So sieht die Oberfläche, was geschrieben wurde (z. B. die Ziehung), ohne zweite Abfrage.
5. **Kern-Befehle über die API:** `POST /giveaways/:id/kernel-commands { type, args }` für `issuer: 'streamer'` (die Rechteprüfung macht `kernel_command`), `POST /portal/giveaways/:id/kernel-commands { type, args }` setzt `pid` auf die eigene Sitzung. `scheduler`-Befehle lehnt `kernel_command` für Nutzer ab, wenn sie keine Team-Rechte haben (bestehend).
6. **Portal-Sichtbarkeit:** `GET /portal/giveaways` listet Giveaways mit einer Zeile in `giveaway_participants` für die pid (angemeldet, gesehen oder im Topf). Ein Giveaway, an dem die Person nicht beteiligt ist, zeigt `GET /portal/giveaways/:id` trotzdem, wenn es Offen ist (sie will teilnehmen), sonst 404. Die öffentliche Route `GET /public/giveaways/:id` (ohne Sitzung) liefert Gewinn, Sponsor, Kern-Label, Zustand, Kanäle als Anzeigenamen, Keyword, Rechtstexte (eingefroren, sonst die zusammengeführten des Profils des Teams sind unbekannt → nur Giveaway-Texte), Meldefrist. Kanal-Anzeigenamen sind Streamer-Namen (öffentliche Kanäle), kein `logRead`.
7. **Bedingungsstatus im Portal (6.5 „laufend anzeigen“):** `GET /portal/giveaways/:id/gates` prüft auf Anfrage die eigene pid über den `GateChecker` der App (Helix) und liefert `{ ok, reasons }`; Fehler → `502 { code: 'twitch_unreachable' | 'token_invalid', message }`. Keine Zwischenspeicherung, kein Hintergrundlauf (Teilprojekt 10 misst die Last). `GET /portal/giveaways/:id` liefert nur die Konfiguration der Bedingungen und, falls gezogen, das Ergebnis aus dem Nachweis.
8. **Chance:** `weight ÷ pool_weight` der Lesetabelle, als Zahl `chance` (0–1) und nie vorformatiert; die Oberfläche formatiert. Bei `pool_weight = 0` → `null`.
9. **Live-Push:** Route `GET /ws` (Sitzung Pflicht, Upgrade). Client sendet `{ "subscribe": ["giveaway:<uuid>", "team:<uuid>"] }` und `{ "unsubscribe": [...] }`. Rechte je Strom: `team:<id>` und Streamer-Sicht auf `giveaway:<id>` über `controls`; ein Teilnehmer darf `giveaway:<id>`, wenn eine Zeile in `giveaway_participants` existiert oder das Giveaway Offen ist. Ablehnung antwortet `{ "error": { code, message, stream } }`, die Verbindung bleibt. Server sendet je Ereignis `{ "event": { stream, seq, type, id, at } }`. Ping alle 30 s über das WebSocket-Protokoll. Ein Redis-Ausfall schließt die Sockets mit Code 1012, die Oberfläche verbindet neu (12.1 „verbindet neu“).
10. **Subscriber-Schnittstelle:** `Subscriber { subscribe(stream, fn): () => void }` in `framework/subscriber.ts`. `LocalBus` erfüllt `Publisher` und `Subscriber` zugleich (Tests, Einzelprozess). `RedisSubscriber` nutzt eine eigene ioredis-Verbindung mit `psubscribe('events:*')` und verteilt nach Kanalname. Die App bekommt beide: `RedisPublisher` zum Schreiben, `RedisSubscriber` zum Lesen.
11. **Text-Linter (11.6):** `src/shared/text-rules.ts` exportiert `checkText(text): string[]` (Gründe) mit: höchstens 20 Wörter je Satz, kein Semikolon, Bannliste (`nahtlos`, `leistungsstark`, `revolutionär`, `innovativ`, `intuitiv`, `problemlos`, `mühelos`, `optimal`, `umfassend`, `bequem`, `einfach nur`, `state of the art`), Passiv-Heuristik (`wird|werden|wurde|wurden` + Partizip `ge…t|ge…en` im selben Satz, Ausnahme: `wurde` vor `gelöscht` steht nicht in den Texten) und Endsatzzeichen `.` `!` `?`. `scripts/text-lint.ts` (tsx) sammelt alle Zeichenketten aus `reject('…', '<Text>')`, `why: '<Text>'`, `message: '<Text>'` und `text: '<Text>'` in `src/**/*.ts` per Regex und lehnt mit Datei:Zeile ab. `npm run lint` ruft ESLint und den Linter. Vorhandene Texte, die der Linter bemängelt, werden im selben Task korrigiert (gleiche Bedeutung, kürzere Sätze).
12. **Start-Assistent-Vorschau (11.1 „Live-Vorschau, wie viele Teilnehmer die Bedingungen erfüllen“):** nicht in diesem Plan. Sie braucht Helix-Prüfungen für alle Zuschauer der letzten 30 Tage; das kommt mit dem Lasttest (Teilprojekt 10) oder entfällt. Die Oberfläche zeigt bis dahin nur die Zahl der Anwesenden aus `giveaway_participants`.
13. **Nicht hier:** Verwaltung (11.4, Plattform-Strom, Sperren und Verwarnungen für Streamer) → 8c. SvelteKit-Oberflächen, Streamermodus, Design → 8b. Chat-Ansagen (10.3) → eigener Plan nach 8b.

## Review Focus

1. Teilnehmerliste eines fremden Team-Giveaways: 403, keine Zeile, kein `logRead`. Test in Task 1.
2. Verlauf: ein aufgehobener Eintrag trägt `reverted: true`, die Umkehrung selbst `reversesEventId`, ein `none`-Typ den Grund; Seitengrenzen überschneiden sich nicht. Test in Task 1.
3. Portal: Anmeldung in einem geschlossenen Giveaway → 400 `not_open`; Detail eines fremden geschlossenen Giveaways ohne Beteiligung → 404; öffentliche Route liefert nie pids von Teilnehmern. Test in Task 3.
4. WebSocket: Abonnement eines fremden Team-Giveaways → `error`, kein Ereignis; ein Teilnehmer bekommt Ereignisse nur für Giveaways mit Beteiligung oder Offen; keine Nachricht trägt eine Payload. Test in Task 4.
5. Text-Linter: erkennt Passiv, 21 Wörter, Semikolon und Bannwort; alle Texte im Quellcode bestehen nach Task 5. Test in Task 5.

---

## Dateistruktur

```
packages/server/src/journal/journal.ts                       + readStreamPage
packages/server/src/framework/giveaway/events.ts             settingsSchema v3 (contact), Upcaster 2→3
packages/server/src/framework/giveaway/services.ts           upcastSettingsV2
packages/server/src/framework/giveaway/lifecycle.ts          contact in checkSettings, create, change_settings
packages/server/src/framework/giveaway/state.ts              GiveawaySettings.contact
packages/server/src/framework/subscriber.ts                  Subscriber, LocalBus, RedisSubscriber
packages/server/src/api/giveaways-read.ts                    loadGiveaway, participantRows, historyPage, Antwortformen
packages/server/src/api/giveaways.ts                         Streamer-Routen (Lesen + Befehle), /kernels
packages/server/src/api/portal.ts                            Portal- und öffentliche Routen
packages/server/src/api/ws.ts                                WebSocket-Route und Abonnements
packages/server/src/api/http.ts                              FORBIDDEN + not_your_team (vorhanden), 502 für GateCheckError
packages/server/src/api/auth.ts                              ApiDeps + auth, gates, subscriber
packages/server/src/app/build-app.ts, app/main.ts            Registrierung, Verdrahtung
packages/server/src/shared/text-rules.ts                     checkText
packages/server/scripts/text-lint.ts                         Sammler + Lauf
packages/server/package.json                                 @fastify/websocket, lint:text
packages/server/test/api-giveaways.test.ts, api-portal.test.ts, api-ws.test.ts, text-rules.test.ts, journal.test.ts (Ergänzung), event-types/lifecycle (Ergänzung contact)
README.md, CLAUDE.md
```

---

### Task 1: Lese-API für Streamer, Verlauf, Kernkatalog

**Files:**
- Create: `src/api/giveaways-read.ts`, `src/api/giveaways.ts`
- Modify: `src/journal/journal.ts`, `src/api/auth.ts` (`ApiDeps.auth`, `ApiDeps.gates`), `src/app/build-app.ts`, `src/app/main.ts`, `test/helpers/api.ts` (`setupApi` übergibt `auth: allowAll`-kompatibel, optional `accountAuthorizer`)
- Test: `test/api-giveaways.test.ts`, `test/journal.test.ts`

**Interfaces:**
- Produces (`journal.ts`): `readStreamPage(db, registry, stream, o: { beforeSeq?: number; limit?: number }): Promise<EventRecord[]>` – absteigend nach `seq`, `limit` auf 1–200 begrenzt (Default 50), `beforeSeq` exklusiv.
- Produces (`api/auth.ts`): `ApiDeps.auth: GiveawayAuthorizer` (Rechte für Lese-Routen), `ApiDeps.gates?: GateChecker` (Portal, Task 3), `ApiDeps.subscriber?: Subscriber` (Task 4).
- Produces (`giveaways-read.ts`):
  - `loadGiveaway(c, deps, id): Promise<{ state: GiveawayState; row: GiveawayRow } | null>`
  - `giveawayDetail(c, deps, id, state, now): Promise<GiveawayDetail>` – `{ id, teamId, kernel: { id, label, display, configSchema, supportedGates, usesServices }, status, settings, legal (frozen), boost, pool: { size, weight }, registeredCount, winners: [{ pid, displayName, status }], draws: [{ eventId, winners, voided }], channels: ChannelStatusView[] mit displayName, closedAt, purgedAt }`
  - `participantRows(c, deps, id, state): Promise<ParticipantView[]>` – aus `giveaway_participants` + `displayNameOf` + `kernel.viewerView(state.kernelState, pid, config)` → `{ pid, displayName, registered, inPool, seen, weight, chance, winnerStatus, lines }`, sortiert nach `weight` absteigend, dann pid.
  - `historyPage(c, deps, stream, o): Promise<HistoryEntry[]>` nach Festlegung 3.
- Produces (`giveaways.ts`, `registerGiveawayRoutes(app, deps, pool)`):
  - `GET /kernels` → `[{ id, label, version, display, configSchema, supportedGates, usesServices, drawMode, commands: [{ type, label, issuer, chat }] }]` (Sitzung Pflicht).
  - `GET /giveaways` → Kacheln aller Giveaways der eigenen Teams (Solo + `team_members`): `[{ id, teamId, kernel, kernelLabel, status, prize, registeredCount, poolSize, poolWeight, updatedAt, warnings: [{ pid, level, text }] }]`, sortiert `updated_at` absteigend; `?status=open,paused` filtert.
  - `GET /giveaways/:id` → `GiveawayDetail`, Rechte über `deps.auth.controls(c, actor, row.teamId)` (403/404).
  - `GET /giveaways/:id/participants` → `ParticipantView[]`, `logRead` `view_participants`.
  - `GET /giveaways/:id/history?beforeSeq&limit` → `{ entries: HistoryEntry[], nextBeforeSeq: number | null }`, `logRead` `view_history`.
- Produces (`build-app.ts`): `registerGiveawayRoutes` nach den Team-Routen; `app/main.ts` übergibt `auth: accountAuthorizer()`, `gates`, `subscriber` (Task 4).
- Produces (`test/helpers/api.ts`): `setupApi` übergibt `api.auth` = `over.auth ?? allowAll`.

- [ ] **Step 1: Tests schreiben** (`setupApi({ auth: accountAuthorizer(), teamAuth: accountTeamAuthorizer(), teamDirectory: pgTeamDirectory(), bans: pgBanDirectory() })`, Konten über `complete()` wie in `api-teams.test.ts`; Giveaways über `rt.handlers.*` mit Akteur `user:<pid>` anlegen)

```ts
// journal.test.ts: ergänzen
it('readStreamPage returns newest first, respects beforeSeq and clamps limit to 1..200', ...);
// api-giveaways.test.ts
it('GET /kernels lists instant, watchtime, tickets with schema, gates, services and commands', ...);
it('GET /giveaways lists tiles of solo and team giveaways with counts and channel warnings, filter by status', ...);
it('GET /giveaways/:id returns detail with kernel display, settings, frozen legal, pool, channels; foreign team → 403 not_your_team; unknown → 404', ...);
it('GET /giveaways/:id/participants returns display names, weights, chance and kernel lines sorted by weight, writes view_participants; foreign team → 403 and no access_log row', ...);   // Review Focus 1
it('GET /giveaways/:id/history pages newest first, marks reverted entries, carries reason and reversal kind, pages do not overlap', ...);   // Review Focus 2
```

- [ ] **Step 2: Tests laufen lassen, sie scheitern**
- [ ] **Step 3: Implementieren**
- [ ] **Step 4: Prüfen** (`npm run typecheck`, `npm run lint`, `npm test`)
- [ ] **Step 5: Commit** `feat(api): Lese-Routen für Giveaways, Teilnehmer, Verlauf und Kernkatalog`

---

### Task 2: Befehls-API für Streamer, Kontaktweg

**Files:**
- Modify: `src/api/giveaways.ts`, `src/framework/giveaway/state.ts`, `src/framework/giveaway/events.ts`, `src/framework/giveaway/services.ts`, `src/framework/giveaway/lifecycle.ts`, `src/api/http.ts`
- Test: `test/api-giveaways.test.ts`, `test/lifecycle.test.ts`, `test/event-types.test.ts` oder `test/giveaway-state.test.ts` (Upcaster)

**Interfaces:**
- Produces (`state.ts`): `GiveawaySettings.contact: string | null`. (`services.ts`): `upcastSettingsV2(s)` ergänzt `contact: null`; (`events.ts`): `settingsSchema` + `contact: z.string().max(200).nullable()`, `giveaway_created`/`giveaway_settings_changed` `version: 3`, `upcasters: { 1: v1→v2, 2: v2→v3 }`. (`lifecycle.ts`): `checkSettings` prüft `contact` (String ≤ 200 oder null, Fehler `contact_too_long`, „Der Kontaktweg darf höchstens 200 Zeichen haben.“), `create` Default `null`, `change_settings` übernimmt Teilangaben.
- Produces (`giveaways.ts`): Befehlsrouten, alle mit Sitzung, Akteur `user:<pid>`, Antwort `200 { events: [{ id, seq, type }] }` oder Ablehnung:
  - `POST /giveaways { teamId, kernelId, settings }` → `201 { giveawayId, events }` (`giveawayId = randomUUID()`).
  - `PUT /giveaways/:id/settings { settings }`
  - `POST /giveaways/:id/open|pause|resume|close|reopen|cancel|complete|draw`
  - `POST /giveaways/:id/redraw { replace, reason }`
  - `PUT /giveaways/:id/winners/:pid { status }`
  - `POST /giveaways/:id/boost { factor, durationSec }`, `DELETE /giveaways/:id/boost`
  - `POST /giveaways/:id/corrections { channel, pid, sec, reason }`
  - `POST /giveaways/:id/revert { eventId, reason }` (Strom `giveaway:<id>`)
  - `POST /giveaways/:id/kernel-commands { type, args }` (ohne `pid`)
- Produces (`http.ts`): Abbildung bleibt (`_not_found` → 404, `FORBIDDEN` → 403); `GateCheckError`-Codes `twitch_unreachable`, `token_invalid` → 502 (Konstante `UPSTREAM`).

- [ ] **Step 1: Tests schreiben**

```ts
// lifecycle.test.ts / event-types: ergänzen
it('settings carry contact (default null, max 200), v1 and v2 events upcast to v3 with contact null', ...);
// api-giveaways.test.ts: ergänzen
it('POST /giveaways creates a draft (201 with giveawayId and events), PUT settings, open, pause, resume, close, draw, winner status, complete run through the bus with the session actor', ...);
it('boost start/stop, correction, kernel command (open_window on instant) and revert answer with the written events; rejections map to 400 with code and message', ...);
it('redraw replaces a winner with reason; without reason → 400 reason_required', ...);
it('a non-member gets 403 not_your_team on every command route, unknown giveaway 404', ...);
```

- [ ] **Step 2: Tests laufen lassen, sie scheitern**
- [ ] **Step 3: Implementieren**
- [ ] **Step 4: Prüfen**
- [ ] **Step 5: Commit** `feat(api): Befehls-Routen für Giveaways, Kontaktweg in den Einstellungen`

---

### Task 3: Portal-API und öffentliche Giveaway-Seite

**Files:**
- Create: `src/api/portal.ts`
- Modify: `src/app/build-app.ts`, `src/api/http.ts`
- Test: `test/api-portal.test.ts`

**Interfaces:**
- Consumes: `loadGiveaway`, `participantRows`-Helfer (Task 1), `deps.gates` (GateChecker; Tests mit Stub), `rt.handlers.register|withdraw|kernelCommand`.
- Produces (`portal.ts`, `registerPortalRoutes(app, deps, pool)`):
  - `GET /public/giveaways/:id` (ohne Sitzung) → `{ id, prize, sponsor, kernel: { id, label, display }, status, channels: [{ pid, displayName }], keyword, legal: FrozenLegal | LegalTexts | null, claimDays, counting, winnersCount }`; 404 bei unbekannt.
  - `GET /portal/giveaways` → `[{ id, prize, kernelLabel, status, registered, inPool, weight, chance, winnerStatus, updatedAt }]` aus `giveaway_participants JOIN giveaways` für die pid, sortiert `updated_at` absteigend.
  - `GET /portal/giveaways/:id` → `{ ...public, registered, view: ViewerView, chance, gates: GateConfig[], lastGateResult: { ok, reasons } | null (aus dem gültigen Nachweis), winner: { status, claimDeadline, contact } | null, legalEventId }`; 404 ohne Beteiligung, wenn nicht Offen (Festlegung 6).
  - `GET /portal/giveaways/:id/gates` → `{ ok, reasons }` über `deps.gates.check` für die eigene pid; `GateCheckError` → 502.
  - `POST /portal/giveaways/:id/register`, `POST /portal/giveaways/:id/withdraw` → `200 { events }`.
  - `POST /portal/giveaways/:id/kernel-commands { type, args }` → `pid` = Sitzung → `200 { events }`.
  - `claimDeadline` = Zeitpunkt des gültigen `giveaway_drawn` + `claimDays` Tage, ISO.

- [ ] **Step 1: Tests schreiben** (`setupApi({ gates: stub })`, Giveaways über `rt.handlers` mit `allowAll`, Teilnehmer über `login(s, BOB)`)

```ts
it('GET /public/giveaways/:id shows prize, kernel, status, channel display names, keyword and legal without session and without any pid', ...);   // Review Focus 3
it('register and withdraw via the portal run as the session pid; register on a closed giveaway → 400 not_open', ...);   // Review Focus 3
it('GET /portal/giveaways lists my participations with chance; GET detail shows viewerView lines, gates config and winner info with claimDeadline and contact after a draw', ...);
it('detail of an open giveaway without participation works, of a closed one → 404', ...);   // Review Focus 3
it('GET gates asks the checker for my pid only; checker failure → 502 twitch_unreachable', ...);
it('portal kernel command buys tickets for the session pid (tickets kernel), not for another pid in the body', ...);
```

- [ ] **Step 2: Tests laufen lassen, sie scheitern**
- [ ] **Step 3: Implementieren**
- [ ] **Step 4: Prüfen**
- [ ] **Step 5: Commit** `feat(api): Teilnehmer-Portal und öffentliche Giveaway-Seite`

---

### Task 4: Live-Push per WebSocket

**Files:**
- Create: `src/framework/subscriber.ts`, `src/api/ws.ts`
- Modify: `packages/server/package.json` (`@fastify/websocket`), `src/app/build-app.ts`, `src/app/main.ts`, `src/framework/publisher.ts` (nur Export `channelFor`, vorhanden), `test/helpers/api.ts`
- Test: `test/api-ws.test.ts`, `test/publisher.test.ts` (Ergänzung LocalBus)

**Interfaces:**
- Produces (`subscriber.ts`): `interface Subscriber { subscribe(stream: StreamId, fn: (events: EventRecord[]) => void): () => void }`; `class LocalBus implements Publisher, Subscriber` (synchron, für Tests und Einzelprozess); `class RedisSubscriber implements Subscriber` (`constructor(redis: Redis)`, `start(): Promise<void>` macht `psubscribe('events:*')`, `stop()`), parst `createdAt` zurück zu `Date`, `onError(fn)` für den Ausfall.
- Produces (`ws.ts`, `registerWsRoutes(app, deps, pool)`): Route `GET /ws` mit `@fastify/websocket`; ohne Sitzung schließt sie mit Code 4401 und Grund `no_session`. Nachrichten nach Festlegung 9. Rechteprüfung je Strom: `team:<id>` → `controls`; `giveaway:<id>` → `controls` oder Zeile in `giveaway_participants` für die pid oder `giveaways.status = 'open'`; sonst `{ error: { code: 'not_allowed', message: 'Diesen Verlauf darfst du nicht abonnieren.', stream } }`. Ping alle 30 s (`WS_PING_MS`), Abonnements fallen beim Schließen weg. `deps.subscriber` fehlt → Route antwortet 503 `{ code: 'no_push', message: 'Live-Aktualisierung ist in diesem Prozess nicht verfügbar.' }`.
- Produces (`build-app.ts`): registriert `@fastify/websocket` und `registerWsRoutes`, wenn `deps.api.subscriber` gesetzt ist. (`main.ts`): `RedisSubscriber` mit zweiter Verbindung, `start()` vor `listen`, bei `onError` Sockets schließen (Code 1012).
- Produces (`test/helpers/api.ts`): `setupApi` nutzt `LocalBus` als `publisher` und `subscriber`; `listen(s)` startet den Server auf Port 0 und liefert die URL.

- [ ] **Step 1: Tests schreiben** (WebSocket-Client `ws` aus der Abhängigkeit; `await app.listen({ port: 0 })`)

```ts
// publisher.test.ts: ergänzen
it('LocalBus delivers published events to stream subscribers and unsubscribe stops them', ...);
// api-ws.test.ts
it('connect without session closes with 4401; with session subscribe to own giveaway, a bus command yields one event message without payload', ...);   // Review Focus 4
it('subscribing to a foreign team giveaway answers error not_allowed and sends nothing; a participant with a row or an open giveaway may subscribe', ...);   // Review Focus 4
it('unsubscribe stops messages; closing the socket removes subscriptions (no error logged)', ...);
```

- [ ] **Step 2: Tests laufen lassen, sie scheitern**
- [ ] **Step 3: Implementieren** (`npm install @fastify/websocket -w packages/server`, Version festhalten)
- [ ] **Step 4: Prüfen**
- [ ] **Step 5: Commit** `feat(api): Live-Push per WebSocket aus Redis Pub/Sub`

---

### Task 5: Text-Linter

**Files:**
- Create: `src/shared/text-rules.ts`, `scripts/text-lint.ts`
- Modify: `package.json` (`lint:text`, `lint` ruft beides), Quelltexte, die der Linter bemängelt
- Test: `test/text-rules.test.ts`

**Interfaces:**
- Produces (`text-rules.ts`): `BANNED_WORDS: readonly string[]`, `MAX_WORDS = 20`, `checkText(text: string): string[]` (leer = ok; Gründe `zu_lang`, `semikolon`, `bannwort:<wort>`, `passiv`, `satzzeichen`), `extractUiTexts(source: string): { text: string; line: number }[]` (Regex über `reject('…', '<Text>')`, `why: '<Text>'`, `message: '<Text>'`, `text: '<Text>'`, auch Template-Strings mit `${…}`-Lücken, Lücken zählen als ein Wort).
- Produces (`scripts/text-lint.ts`): läuft über `src/**/*.ts`, druckt `Datei:Zeile: Grund – Text`, Exit 1 bei Treffern. `npm run lint:text` = `tsx scripts/text-lint.ts`, `npm run lint` = `eslint . && npm run lint:text`.

- [ ] **Step 1: Tests schreiben**

```ts
it('checkText flags 21 words, a semicolon, a banned word, passive voice (wird … geprüft) and a missing end mark; accepts the project texts', ...);   // Review Focus 5
it('extractUiTexts finds reject messages, why, message and text literals with line numbers, including template strings', ...);
```

- [ ] **Step 2: Tests laufen lassen, sie scheitern**
- [ ] **Step 3: Implementieren, dann `npm run lint:text` laufen lassen und jede Fundstelle im Quelltext korrigieren**
- [ ] **Step 4: Prüfen**
- [ ] **Step 5: Commit** `feat(texts): deutscher Text-Linter in der CI`

---

### Task 6: Doku und Gesamtprüfung

**Files:**
- Modify: `README.md`, `CLAUDE.md`, `.env.example` (keine neuen Variablen; prüfen)

**Interfaces:**
- README „Prozesse“ → app: Routenblöcke Giveaways, Portal, öffentlich, `/ws`; Begriffe `Kontaktweg`, `Live-Push`, `Text-Linter`; Teilprojekt-Zeile: 8a fertig.
- CLAUDE.md: Pflichtlektüre: 8a fertig, als Nächstes 8b (SvelteKit-Oberflächen); Befehle: `npm run lint` = ESLint + Text-Linter; Architektur: Abschnitt **API** (Routen, Replay in Detail-Ansichten, `readStreamPage`, Push ohne Payload, `Subscriber`/`LocalBus`), Ereignisse v3 mit `contact`.

- [ ] **Step 1: Doku schreiben**
- [ ] **Step 2: Alles prüfen** (`npm run typecheck`, `npm run lint`, `npm test`, `npm run build`; App gegen den Dev-Stack starten, mit `curl` `GET /healthz`, `GET /public/giveaways/<id>` eines Dev-Giveaways, und mit einem kleinen `ws`-Skript ein Abonnement plus ein Ereignis über die Runtime sehen)
- [ ] **Step 3: Commit** `docs: Giveaway-API, Portal, Live-Push, Stand Teilprojekt 8a`

---

## Selbstprüfung gegen die Spec

- 3.2 Fastify für HTTP und WebSocket → Task 4. Redis nur Pub/Sub → `RedisSubscriber`.
- 3.3 Ein Schreibweg: alle Routen über `bus.execute` → Task 2, 3.
- 5.3 „Rückgängig“ oder Grund an jedem Verlaufseintrag, aufgehobene durchgestrichen mit Verweis → `HistoryEntry.reversal`, `reverted`, `reversesEventId` → Task 1; Befehl `revert` → Task 2.
- 5.5 Lesezugriffe auf personenbezogene Daten → `view_participants`, `view_history` → Task 1.
- 6.5 Bedingungsstatus laufend → auf Anfrage je Person → Task 3 (Festlegung 7).
- 7.1 Übergänge, 7.2 Ziehung, Ersatzziehung mit Grund, 7.3 Gewinnerstatus, Meldefrist, Kontaktweg → Task 2, 3 (Festlegung 1).
- 9.4 Rechtstexte je Giveaway im Portal → `legal` in Detail und öffentlicher Route → Task 3.
- 11.1 Übersicht (Kacheln, Verbindungsstatus, Abgeschlossene), Detail (Statusblock, Warnstreifen, Aktionen, Teilnehmer mit Chance, Verlauf), Start-Assistent (Kernkatalog, Einstellungen, Kanäle, Bedingungen, Rechtstexte, Öffnen) → Daten dafür in Task 1, 2. Live-Vorschau → Festlegung 12.
- 11.2 Statusblock: Zustand, Topf, Kanäle mit Warnungen → `GiveawayDetail.channels`, Tätigkeit „Prüft Follows…“ ist Ziehungslaufzeit, nicht persistent → 8b zeigt den laufenden Befehl clientseitig.
- 11.3 Portal: Liste, Status, Bedingungen, Zeit/Coins/Tickets je Kanal (`viewerView.lines`), Chance, Teilnehmen, Rückzug, Tickets, Rechtstexte, Gewinn mit Frist und Kontaktweg, Meine Daten (bestehend) → Task 3.
- 11.6 deutscher Linter in CI → Task 5.
- 12.1 Redis-Ausfall „verbindet neu“ → Sockets schließen 1012 → Task 4. Helix nicht erreichbar → 502 mit Grund → Task 3.
- 12.2 Tests je Ebene → Task 1–5.
- Offen: 11.4 Verwaltung (8c), Oberflächen und Streamermodus (8b), Chat-Ansagen (10.3), Start-Assistent-Vorschau (Teilprojekt 10).
