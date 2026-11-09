# Teilprojekt 8c: Plattform-Verwaltung (Superadmin) – Umsetzungsplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Die Plattform-Verwaltung aus NEW_DESIGN.md 11.4: der Betreiber (Superadmin) sieht Betrieb (Health, Ingest je Kanal, abgelehnte Befehle, Browser-Fehler), sperrt und verwarnt Streamer, veröffentlicht Fassungen der Nutzungsbedingungen und liest Rückmeldungen. Dazu der Strom `platform` (5.1: Sperren, Verwarnungen, Nutzungsbedingungen) mit Wirkung in Rechten, Ingest und Onboarding, die Betriebsdaten-Tabellen `browser_errors` und `feedback` mit Fristen (12.4), die Seiten der Web-App und die Hinweise für betroffene Streamer.

**Architecture:** Alles, was ein Nachweis ist, läuft als Befehl über `CommandBus.execute` in den Strom `platform` (Reducer `platform`, Lesetabellen `platform_bans`, `platform_warnings`, `platform_terms`). Betriebsdaten ohne Nachweis-Charakter (Browser-Fehler ohne Personenbezug, Rückmeldungen als Freitext) liegen wie `channel_status` in Tabellen, nicht im Journal. Der Superadmin ist eine Person mit Twitch-ID aus `ADMIN_TWITCH_IDS`; `isAdmin` prüft über `identities`. Admin-Routen unter `/api/admin/*` antworten Nicht-Admins mit 403 `not_admin`. Die gültige Fassung der Nutzungsbedingungen kommt aus `platform_terms` (höchste veröffentlichte Version, sonst 1 ohne Text); `accept_terms`, `accountAuthorizer` und `/api/me` lesen sie statt der Konstante. Eine Sperre wirkt in `accountAuthorizer.controls`/`canFound` (`account_banned`) und im Kanalverzeichnis des Ingest (keine Signale). Die Web-App bekommt `/admin/*`, `/feedback`, den Fehlerbericht aus `hooks.client.ts` und Hinweise für verwarnte oder gesperrte Streamer.

**Tech Stack:** wie bisher. Keine neue Abhängigkeit.

**Spec:** `NEW_DESIGN.md` 3.3, 5.1 (Strom `platform`), 5.3, 5.5, 9.2 (Nutzungsbedingungen versioniert, erzwungen), 11.4, 11.5, 11.6, 12.1, 12.4 (Browser-Fehler 30 Tage ohne Personenbezug). Nicht hier: Chat-Ansagen (10.3), Übernahme (9), Caddy/Lasttest (10).

## Global Constraints

- Sperren, Verwarnungen und Fassungen der Nutzungsbedingungen sind Ereignisse im Strom `platform`, geschrieben nur über `CommandBus.execute`. Payloads tragen nur `pid`; Gründe stehen im Feld `reason` (Grundpflicht), der Text der Nutzungsbedingungen im Payload (kein Personenbezug).
- Browser-Fehler enthalten keinen Personenbezug: kein `pid`, kein Cookie, kein Twitch-Name. Die Route liest die Sitzung nicht. Löschung nach 30 Tagen durch den Scheduler.
- Rückmeldungen tragen die `pid` des Absenders (Pseudonym) und den Text, keine Twitch-Daten. Namen zeigt die Verwaltung nur über `identities` und schreibt `logRead` (`admin_view_feedback`, `admin_search`).
- Neue Tabellen nur über `migrations/008_platform.sql`. Formatänderungen von Ereignistypen gibt es nicht (nur neue Typen).
- Texte: deutsch, aktiv, höchstens 20 Wörter, über den Text-Linter (Server: `reject`/`message`-Texte, Web: `labels.ts`/`sentences.ts`).
- Web: `admin`-Seiten nur über `requireAdmin` (Sitzung, `me.admin`), ein Kupfer-Element je Ansicht, Namen von Teilnehmern über `Name.svelte`; Streamer-Namen (Kanäle) bleiben sichtbar.
- Je Task erst den Code fertig schreiben, dann einmal `npm run typecheck`, `npm run lint`, `npm test`.

## Entscheidungen, die die Spec offen lässt (meine Festlegungen)

1. **Superadmin:** Umgebungsvariable `ADMIN_TWITCH_IDS` (Twitch-IDs, kommagetrennt, Default leer). `isAdmin(c, pid)` = Zeile in `identities` mit `twitch_id` in der Liste. Twitch-IDs statt pids, weil der Betreiber sie vor der ersten Anmeldung kennt. Admin-Befehle laufen mit Akteur `user:<pid>` des Admins; `authorize` prüft `isAdmin`.
2. **Strom `platform`:** Reducer `platform` (Version 1), Zustand `{ bans: Record<pid, { reason, since, eventId }>, warnings: Record<pid, { eventId, reason, at }[]>, terms: { version, publishedAt } | null }`. Ereignisse: `streamer_banned { pid }` (compensate ↔ `streamer_unbanned { pid }`), `streamer_warned { pid }` (compensate → `warning_withdrawn { pid, warningEventId }`), `terms_published { version, text }` (`none`: „Eine veröffentlichte Fassung ist ein Nachweis. Veröffentliche eine neue.“). Gründe im Feld `reason`.
3. **Wirkung der Sperre:** `accountAuthorizer.controls` und `canFound` lehnen mit `account_banned` ab („Dein Konto ist gesperrt. Grund: …. Wende dich an den Betreiber.“). Das Kanalverzeichnis des Ingest lässt gesperrte Kanäle aus (keine Signale, Live-Status bleibt). Laufende Giveaways bleiben stehen; der Admin sieht sie in der Verwaltung und kann sie nicht steuern (kein zweiter Weg). Die Sperre betrifft Streamer-Rechte, nicht die Teilnahme als Zuschauer.
4. **Verwarnung:** nur ein Hinweis mit Grund, sichtbar für die Person auf der Übersicht und unter `/api/me` (`warnings`). Rücknahme über `withdraw_warning` (compensate).
5. **Nutzungsbedingungen:** `platform_terms (version PK, text, published_at)`. `currentTerms(db)` = höchste Version oder `{ version: 1, text: null }`. `accept_terms` prüft in `prepare` gegen die Datenbank, `accountAuthorizer` ebenso, `/api/me.currentTermsVersion` liest sie. `GET /api/terms` (ohne Sitzung) liefert `{ version, text, publishedAt }`; ohne Text zeigt die Web-App die bisherigen Pflichten als Platzhalter. `publish_terms { text }` erzeugt Version `(aktuell) + 1`; wer die alte Fassung hat, muss neu annehmen (bestehende Regel).
6. **Betriebsdaten:** `browser_errors (id, at, message ≤ 500, stack ≤ 4000, url ≤ 500, user_agent ≤ 300)` über `POST /api/errors` (ohne Sitzung, Body ≤ 8 KiB, 202), Scheduler löscht nach 30 Tagen (`purgeBrowserErrors`). `feedback (id, pid, text ≤ 2000, at, done)` über `POST /api/feedback` (Sitzung, 201). Beides keine Journal-Ereignisse (Betriebsdaten wie `channel_status`).
7. **Betriebsansicht** `GET /api/admin/ops`: `{ db: 'ok', workers: [{ worker, channels, lastUpdate }], channels: [{ pid, displayName, connected, tokenStatus, live, viewers, chatters, lastSignalAt, problem, warning }], giveaways: { open, paused, closed, drawn }, denied: [{ action, reason, count, lastAt }] (letzte 24 h, `access_log` `kind='denied'`, Top 50), browserErrors: [{ at, message, url }] (letzte 50) }`. `logRead` `admin_view_ops` (Kanalnamen sind Streamer, aber die Liste ist vollständig).
8. **Streamer-Suche** `GET /api/admin/streamers?q=`: `identities` ⋈ `accounts` (nicht gelöscht), `login`/`display_name ILIKE %q%`, höchstens 50, je Treffer `{ pid, login, displayName, channelConnected, termsVersion, banned: { reason, since } | null, warnings: [{ eventId, reason, at }] }`; `logRead` `admin_search`. Ohne `q` die zuletzt angemeldeten 50.
9. **Web:** Navigation „Verwaltung“ nur mit `me.admin`. Seiten `/admin` (Betrieb), `/admin/streamers` (Suche, Sperren, Verwarnen, Rücknahme mit Grund über `Confirm`), `/admin/terms` (aktueller Text, neue Fassung veröffentlichen), `/admin/feedback` (Liste, erledigt). `/feedback` für alle mit Sitzung (Formular). `/terms` zeigt den veröffentlichten Text. Übersicht zeigt Verwarnungen als Warnstreifen und bei Sperre einen roten Streifen mit Grund. `hooks.client.ts` `handleError` sendet Browser-Fehler an `POST /api/errors` (einmal je Fehler, kein Personenbezug).
10. **Akteur in der Verwaltung:** `Me.admin: boolean` aus `/api/me`; die Admin-Seiten laden sonst `/`-Weiterleitung über `requireAdmin` (403-Seite, wenn `me` da, aber kein Admin).
11. **Nicht hier:** Rückmeldungs-Antworten, Admin-Steuerung fremder Giveaways, Export der Betriebsdaten.

## Review Focus

1. Ein gesperrter Streamer kann kein Giveaway anlegen oder steuern, seine Kanäle liefern keine Signale, aber er kann weiter als Zuschauer teilnehmen. Test in Task 2.
2. Eine neue Fassung der Nutzungsbedingungen sperrt Streamer-Befehle, bis die Person sie annimmt; Annahme einer alten Fassung wird abgelehnt. Test in Task 2.
3. Nicht-Admins bekommen auf jeder `/api/admin/*`-Route 403 und keinen Eintrag mit Namen im Zugriffslog. Test in Task 3.
4. Browser-Fehler speichern keinen Personenbezug, auch wenn ein Cookie mitkommt; zu große Bodies lehnt die Route ab. Test in Task 3.
5. Web: Admin-Seiten für Nicht-Admins zeigen die Fehlerseite, Navigation zeigt „Verwaltung“ nur Admins; eine Sperre erscheint auf der Übersicht mit Grund. Test in Task 4.

---

## Dateistruktur

```
packages/server/migrations/008_platform.sql                 platform_bans, platform_warnings, platform_terms, browser_errors, feedback
packages/server/src/config/config.ts                        ADMIN_TWITCH_IDS → adminTwitchIds: string[]
packages/server/src/platform/state.ts                       PlatformState, PLATFORM_EVENTS, platformReducer, PLATFORM_STREAM
packages/server/src/platform/events.ts                      registerPlatformEvents
packages/server/src/platform/commands.ts                    banStreamer, unbanStreamer, warnStreamer, withdrawWarning, publishTerms, platformRevert
packages/server/src/platform/projectors.ts                  platformProjector (StateProjector → drei Tabellen)
packages/server/src/platform/admin.ts                       AdminCheck, isAdmin(c, pid, ids), adminAuthorizer
packages/server/src/platform/terms.ts                       currentTerms(db): { version, text, publishedAt }
packages/server/src/platform/runtime.ts                     attachPlatform(rt, o): PlatformHandlers
packages/server/src/platform/ops.ts                         browser_errors, feedback: insert, list, purge; opsView
packages/server/src/identity/account/authorizer.ts          account_banned, Fassung aus platform_terms
packages/server/src/identity/account/commands.ts            accept_terms prüft in prepare gegen currentTerms
packages/server/src/identity/terms.ts                       entfällt (PLATFORM_TERMS_VERSION → platform/terms.ts TERMS_FALLBACK_VERSION = 1)
packages/server/src/ingest/directory.ts                     NOT EXISTS platform_bans
packages/server/src/scheduler/maintenance.ts                purgeBrowserErrors
packages/server/src/api/admin.ts                            /api/admin/*
packages/server/src/api/public.ts                           GET /api/terms, POST /api/errors, POST /api/feedback
packages/server/src/api/me.ts                               admin, banned, warnings, currentTermsVersion aus DB
packages/server/src/api/auth.ts                             ApiDeps.platform, ApiDeps.adminTwitchIds
packages/server/src/app/build-app.ts, app/main.ts, scheduler/main.ts, ingest/main.ts
packages/server/test/platform.test.ts, api-admin.test.ts, api-me.test.ts (+), account-authorizer.test.ts (+), directory.test.ts (+), maintenance.test.ts (+)
packages/web/src/lib/api/types.ts                           Me.admin/banned/warnings, Terms, Ops, AdminStreamer, FeedbackRow
packages/web/src/lib/guard.ts                               requireAdmin
packages/web/src/hooks.client.ts                            handleError → POST /api/errors
packages/web/src/routes/admin/+layout.ts, +page.*, streamers/+page.*, terms/+page.*, feedback/+page.*
packages/web/src/routes/feedback/+page.*
packages/web/src/routes/terms/+page.* (Text aus /api/terms)
packages/web/src/routes/giveaways/+page.svelte (Verwarnungen, Sperre), +layout.svelte (Navigation)
packages/web/src/lib/texts/labels.ts, sentences.ts
README.md, CLAUDE.md, .env.example
```

---

### Task 1: Plattform-Strom: Ereignisse, Reducer, Befehle, Lesetabellen, Admin-Prüfung

**Files:**
- Create: `migrations/008_platform.sql`, `src/platform/{state,events,commands,projectors,admin,terms,runtime}.ts`
- Modify: `src/config/config.ts`
- Test: `test/platform.test.ts`, `test/config.test.ts` (+)

**Interfaces:**
- Produces (`008_platform.sql`): `platform_bans (pid UUID PK, reason TEXT NOT NULL, since TIMESTAMPTZ NOT NULL, event_id TEXT NOT NULL)`, `platform_warnings (event_id TEXT PK, pid UUID NOT NULL, reason TEXT NOT NULL, at TIMESTAMPTZ NOT NULL, withdrawn BOOLEAN NOT NULL DEFAULT false)` + Index `(pid)`, `platform_terms (version INTEGER PK, text TEXT NOT NULL, published_at TIMESTAMPTZ NOT NULL)`, `browser_errors (id BIGINT IDENTITY PK, at TIMESTAMPTZ NOT NULL, message TEXT NOT NULL, stack TEXT, url TEXT, user_agent TEXT)` + Index `(at)`, `feedback (id BIGINT IDENTITY PK, pid UUID NOT NULL, text TEXT NOT NULL, at TIMESTAMPTZ NOT NULL, done BOOLEAN NOT NULL DEFAULT false)`.
- Produces (`config.ts`): `ADMIN_TWITCH_IDS: z.string().default('')` → `Config.adminTwitchIds: string[]` (getrimmt, leere weg).
- Produces (`state.ts`): `PLATFORM_STREAM = 'platform'`, `PLATFORM_EVENTS = { banned: 'streamer_banned', unbanned: 'streamer_unbanned', warned: 'streamer_warned', warningWithdrawn: 'warning_withdrawn', termsPublished: 'terms_published' }`, `PlatformState` (Festlegung 2), `platformReducer: StreamReducer<PlatformState>` (`name: 'platform'`, `version: 1`). `streamer_warned` hängt `{ eventId: e.id, reason: e.reason ?? '', at }` an; `warning_withdrawn` entfernt den Eintrag mit `warningEventId`; `streamer_banned` setzt `bans[pid] = { reason: e.reason ?? '', since: at, eventId: e.id }`; `terms_published` setzt `terms = { version, publishedAt }`.
- Produces (`events.ts`): `registerPlatformEvents(registry)` mit zod-Schemas (`pid: z.uuid()`, `warningEventId: z.string()`, `version: z.int().min(1)`, `text: z.string().min(1).max(50_000)`), Umkehrarten aus Festlegung 2. `inverse` von `streamer_banned` → `streamer_unbanned { pid }` (lehnt `not_banned` ab, wenn die Sperre nicht mehr gilt), von `streamer_unbanned` → `streamer_banned { pid }`, von `streamer_warned` → `warning_withdrawn { pid, warningEventId }`, `warning_withdrawn` → `none` („Eine zurückgenommene Verwarnung bleibt zurückgenommen. Sprich eine neue aus.“).
- Produces (`admin.ts`): `interface AdminCheck { isAdmin(c: Queryable, pid: string): Promise<boolean> }`, `twitchIdAdmins(ids: string[]): AdminCheck` (SQL `SELECT 1 FROM identities WHERE pid = $1 AND twitch_id = ANY($2)`), `noAdmins: AdminCheck`, `allAdmins: AdminCheck` (Tests), `authorizeAdmin(check): (cmd, ctx, c) => Promise<Rejection | null>` → `not_admin` („Diese Aktion ist dem Betreiber vorbehalten.“), `system:`-Akteure dürfen nicht (Admin-Handlungen sind Personen zuzuordnen).
- Produces (`commands.ts`): Befehle (alle `streamOf: () => PLATFORM_STREAM`, `authorize: authorizeAdmin`, `reason` Pflicht über `reason_required` außer `publish_terms`):
  - `banStreamerHandler(check): Handler<{ pid: string; reason: string }>` → `[{ type: banned, payload: { pid }, reason }]`; `already_banned`, wenn gesperrt; `invalid_id` bei Nicht-UUID.
  - `unbanStreamerHandler(check): Handler<{ pid; reason }>` → `unbanned` mit `reversesEventId` der Sperre; `not_banned`.
  - `warnStreamerHandler(check): Handler<{ pid; reason }>` → `warned`.
  - `withdrawWarningHandler(check): Handler<{ pid; warningEventId; reason }>` → `warning_withdrawn` mit `reversesEventId`; `warning_not_found`.
  - `publishTermsHandler(check): Handler<{ text: string }>` → `terms_published { version: (state.terms?.version ?? 1) + 1, text }`; `invalid_terms` bei leer oder > 50 000 Zeichen. Erste Veröffentlichung ist Version 2, weil Version 1 die Fassung ohne Text ist (bestehende Konten mit `terms_version = 1` bleiben gültig, bis der Betreiber veröffentlicht).
  - `platformRevertHandler(registry, check)` über `makeRevertHandler`.
- Produces (`projectors.ts`): `platformProjector(): StateProjector<PlatformState>` – schreibt nach jedem Befehl `platform_bans` (DELETE + INSERT aus `state.bans`), `platform_warnings` (UPSERT je Eintrag, `withdrawn` für fehlende), `platform_terms` (INSERT ON CONFLICT DO NOTHING je neuem Ereignis `terms_published`: Text aus dem Ereignis, darum `Projector` auf `terms_published` statt StateProjector für diese Tabelle).
- Produces (`terms.ts`): `TERMS_FALLBACK_VERSION = 1`, `currentTerms(db): Promise<{ version: number; text: string | null; publishedAt: string | null }>`.
- Produces (`runtime.ts`): `attachPlatform(rt, o: { admins: AdminCheck }): PlatformHandlers { ban, unban, warn, withdrawWarning, publishTerms, revert }`; registriert Ereignisse und Projektoren genau einmal.

- [ ] **Step 1: Tests schreiben** (`setupGiveaway()`-Runtime plus `attachPlatform(rt, { admins: allAdmins })`, Akteur `user:<ADMIN>`)

```ts
it('config parses ADMIN_TWITCH_IDS into a trimmed list, default empty', ...);
it('ban writes streamer_banned with reason, projects platform_bans; second ban → already_banned; unban reverses with reversesEventId and clears the row', ...);
it('warn appends a warning with reason and at; withdraw marks it withdrawn and removes it from state; unknown → warning_not_found', ...);
it('publish_terms writes version 2 then 3 with text, platform_terms holds both, currentTerms returns the newest; empty text → invalid_terms', ...);
it('a non-admin actor gets not_admin on every platform command, system actors too; reason is required', ...);
it('revert of streamer_banned writes streamer_unbanned; revert of terms_published is rejected with the none reason', ...);
```

- [ ] **Step 2: Tests laufen lassen, sie scheitern**
- [ ] **Step 3: Implementieren**
- [ ] **Step 4: Prüfen**
- [ ] **Step 5: Commit** `feat(platform): Strom platform mit Sperren, Verwarnungen und Nutzungsbedingungen`

---

### Task 2: Wirkung: Rechte, Ingest, Nutzungsbedingungen aus der Datenbank

**Files:**
- Modify: `src/identity/account/authorizer.ts`, `src/identity/account/commands.ts`, `src/identity/terms.ts` (löschen), `src/api/me.ts`, `src/ingest/directory.ts`, `src/app/main.ts`, `src/scheduler/main.ts`, `src/ingest/main.ts`, `test/helpers/api.ts`
- Test: `test/account-authorizer.test.ts` (+), `test/account.test.ts` oder `test/api-me.test.ts` (+), `test/directory.test.ts` (+), `test/api-portal.test.ts` (+)

**Interfaces:**
- Produces (`authorizer.ts`): `accountOf` liest zusätzlich `platform_bans` (`LEFT JOIN`); `controls`/`canFound` → `reject('account_banned', \`Dein Konto ist gesperrt. Grund: ${reason}. Wende dich an den Betreiber.\`)` vor `onboarded`; `onboarded` vergleicht `terms_version` mit `currentTerms(c).version`.
- Produces (`commands.ts`): `acceptTermsHandler()` bekommt `prepare: (c) => currentTerms(c)` und lehnt in `decide` mit `terms_outdated` ab, wenn `cmd.version !== prepared.version` (Text bleibt: „Diese Fassung ist nicht aktuell. Lade die Seite neu.“).
- Produces (`me.ts`): `/api/me` liefert zusätzlich `admin: boolean` (`deps.admins.isAdmin`), `banned: { reason, since } | null`, `warnings: [{ eventId, reason, at }]` (nicht zurückgenommene), `currentTermsVersion` aus `currentTerms`.
- Produces (`directory.ts`): Kanalverzeichnis `WHERE … AND NOT EXISTS (SELECT 1 FROM platform_bans b WHERE b.pid = a.pid)`.
- Produces (`ApiDeps`): `admins: AdminCheck`, `platform: PlatformHandlers`. `app/main.ts`: `twitchIdAdmins(config.adminTwitchIds)`, `attachPlatform` in allen drei Prozessen (Ereignistypen müssen überall registriert sein, damit der Strom lesbar bleibt). `test/helpers/api.ts`: `setupApi({ admins? })`, Default `noAdmins`, `s.platform`.

- [ ] **Step 1: Tests schreiben**

```ts
// account-authorizer.test.ts
it('a banned streamer gets account_banned with the reason on controls and canFound; after unban both pass again', ...);   // Review Focus 1
it('after publish_terms the streamer needs the new version: controls → terms_required, accept_terms with the old version → terms_outdated, with the new one → ok', ...);   // Review Focus 2
// directory.test.ts
it('channel directory leaves out banned channels and lists them again after unban', ...);   // Review Focus 1
// api-portal.test.ts
it('a banned streamer can still register as a participant in another giveaway', ...);   // Review Focus 1
// api-me.test.ts
it('GET /me carries admin, banned, warnings and the current terms version from the database', ...);
```

- [ ] **Step 2: Tests laufen lassen, sie scheitern**
- [ ] **Step 3: Implementieren**
- [ ] **Step 4: Prüfen**
- [ ] **Step 5: Commit** `feat(platform): Sperren wirken in Rechten und Ingest, Nutzungsbedingungen aus dem Strom`

---

### Task 3: Betriebsdaten und Admin-API

**Files:**
- Create: `src/platform/ops.ts`, `src/api/admin.ts`, `src/api/public.ts`
- Modify: `src/scheduler/maintenance.ts`, `src/app/build-app.ts`, `src/api/http.ts` (`not_admin` → 403)
- Test: `test/api-admin.test.ts`, `test/maintenance.test.ts` (+)

**Interfaces:**
- Produces (`ops.ts`): `BROWSER_ERROR_RETENTION_DAYS = 30`, `recordBrowserError(db, e: { message; stack?; url?; userAgent? }, at)` (kürzt auf die Grenzen aus Festlegung 6), `listBrowserErrors(db, limit = 50)`, `purgeBrowserErrors(db, now): Promise<number>`, `addFeedback(db, pid, text, at)` (`invalid_feedback` bei leer oder > 2000), `listFeedback(db, o: { done?: boolean; limit?: number })`, `setFeedbackDone(db, id, done)`, `opsView(db, now): Promise<OpsView>` (Festlegung 7; `warning` über `channelWarning`), `searchStreamers(db, q, limit = 50): Promise<AdminStreamer[]>` (Festlegung 8).
- Produces (`maintenance.ts`): `runMaintenance` ruft `purgeBrowserErrors`, Ergebnis `browserErrorsPurged`.
- Produces (`public.ts`, `registerPublicRoutes(app, deps, pool)`): `GET /api/terms` → `currentTerms`; `POST /api/errors` (`bodyLimit: 8192`, ohne Sitzung, speichert ohne IP und ohne pid, antwortet 202 leer); `POST /api/feedback { text }` (Sitzung, 201 `{ id }`).
- Produces (`admin.ts`, `registerAdminRoutes(app, deps, pool)`): `preHandler` `requireSession` + `requireAdmin` (403 `not_admin`, kein `logRead`). Routen: `GET /api/admin/ops` (`logRead` `admin_view_ops`), `GET /api/admin/streamers?q=` (`logRead` `admin_search`), `POST /api/admin/bans { pid, reason }`, `DELETE /api/admin/bans/:pid { reason }` (Body bei DELETE: stattdessen `POST /api/admin/bans/:pid/lift { reason }`), `POST /api/admin/warnings { pid, reason }`, `POST /api/admin/warnings/:eventId/withdraw { pid, reason }`, `POST /api/admin/terms { text }`, `GET /api/admin/feedback?done=` (`logRead` `admin_view_feedback`, Namen aus `identities`), `PUT /api/admin/feedback/:id { done }`, `POST /api/admin/revert { eventId, reason }`. Befehle über `executeAs`.
- Produces (`build-app.ts`): `registerPublicRoutes`, `registerAdminRoutes` im `/api`-Plugin.

- [ ] **Step 1: Tests schreiben** (`setupApi({ admins: twitchIdAdmins([ALICE.id]) })`)

```ts
it('every /api/admin route answers 403 not_admin for a non-admin and writes no read entry; without session 401', ...);   // Review Focus 3
it('admin bans, warns, withdraws and lifts with reasons; search shows banned and warnings; GET /me of the streamer shows them', ...);
it('ops view lists channels with warnings, denied commands of the last 24 h and browser errors', ...);
it('POST /api/errors stores message, url and user agent without pid or ip even with a session cookie; a 9 KiB body → 413; GET /api/terms works without session', ...);   // Review Focus 4
it('feedback: POST stores text for the session pid, admin list shows display names and marks done; maintenance purges browser errors older than 30 days', ...);
it('admin publishes terms: GET /api/terms shows version 2 with text, the streamer needs to accept again', ...);
```

- [ ] **Step 2: Tests laufen lassen, sie scheitern**
- [ ] **Step 3: Implementieren**
- [ ] **Step 4: Prüfen**
- [ ] **Step 5: Commit** `feat(api): Verwaltung mit Betrieb, Sperren, Verwarnungen, Nutzungsbedingungen, Rückmeldungen und Browser-Fehlern`

---

### Task 4: Web: Verwaltung, Rückmeldung, Fehlerbericht, Hinweise für Streamer

**Files:**
- Create: `src/hooks.client.ts`, `src/routes/admin/+layout.ts`, `src/routes/admin/+layout.svelte`, `src/routes/admin/+page.*`, `src/routes/admin/streamers/+page.*`, `src/routes/admin/terms/+page.*`, `src/routes/admin/feedback/+page.*`, `src/routes/feedback/+page.*`, `src/lib/components/{StreamerRow,WarningList}.svelte`
- Modify: `src/lib/api/types.ts`, `src/lib/guard.ts`, `src/routes/+layout.svelte`, `src/routes/terms/+page.ts`, `+page.svelte`, `src/routes/giveaways/+page.svelte`, `src/lib/texts/*`
- Test: `src/lib/guard.test.ts` (+), `src/hooks.client.test.ts`, `src/routes/admin/streamers/page.test.ts`, `src/routes/giveaways/overview.test.ts`

**Interfaces:**
- Produces (`types.ts`): `Me.admin: boolean`, `Me.banned: { reason: string; since: string } | null`, `Me.warnings: { eventId: string; reason: string; at: string }[]`; `Terms { version; text: string | null; publishedAt: string | null }`; `OpsView`, `AdminStreamer`, `FeedbackRow { id; pid; displayName; text; at; done }`.
- Produces (`guard.ts`): `requireAdmin(me, url): Me` → ohne Sitzung `redirect` wie `requireSession`, mit Sitzung ohne `admin` `error(403, S.admin.forbidden)`.
- Produces (`hooks.client.ts`): `handleError = ({ error, event }) => { void report(error, event.url) }` mit `reportBrowserError(fetchFn, e: { message; stack?; url })` in `src/lib/errors.ts` (höchstens 10 Meldungen je Seite, `navigator.sendBeacon` falls da, sonst `fetch` mit `keepalive`), Rückgabe `{ message: S.serverError }`.
- Produces (`/admin/+layout.ts`): `requireAdmin`; `+layout.svelte`: Unternavigation Betrieb · Streamer · Nutzungsbedingungen · Rückmeldungen.
- Produces (`/admin`): Betrieb aus `GET /api/admin/ops`: Health-Zeile, Worker, Kanäle als Tabelle mit `ChannelStatus` (Name = Streamer), Giveaway-Zahlen, abgelehnte Befehle (Aktion, Grund, Zahl, zuletzt), Browser-Fehler (Zeit, Text, URL). Knopf „Neu laden“ (einziges Kupfer).
- Produces (`/admin/streamers`): Suchfeld (`?q=` in der URL), `StreamerRow` je Treffer: Name, Login, Kanal verbunden, Fassung, Sperre mit Grund, Verwarnungen (`WarningList` mit Rücknahme), Knöpfe „Verwarnen“, „Sperren“ / „Sperre aufheben“ jeweils mit `Confirm` samt Grund. Sperren ist `danger`.
- Produces (`/admin/terms`): aktuelle Fassung (Version, Datum, Text), Textfeld für die neue Fassung, „Fassung veröffentlichen“ (Kupfer) mit `Confirm` („Alle Streamer müssen die neue Fassung annehmen, bevor sie weiter Giveaways steuern.“).
- Produces (`/admin/feedback`): Liste mit Filter offen/erledigt, Haken „erledigt“.
- Produces (`/feedback`): Textfeld (≤ 2000), „Senden“ (Kupfer), Bestätigung.
- Produces (`/terms`): lädt `GET /api/terms`; mit Text zeigt die Seite ihn (`white-space: pre-wrap`), ohne Text die Pflichten-Liste; Knopf „Annehmen“ sendet `version` aus `/api/terms`.
- Produces (`/giveaways`): `me.banned` → roter Warnstreifen `S.account.banned(reason)`, Startknopf gesperrt; `me.warnings` → gelber Streifen je Verwarnung mit Datum und Grund.
- Produces (`+layout.svelte`): Navigationseintrag `L.nav.admin` nur mit `data.me.admin`; Fußzeile mit Link `/feedback` (`L.nav.feedback`).

- [ ] **Step 1: Tests schreiben**

```ts
// guard.test.ts
it('requireAdmin redirects without session, throws 403 for a non-admin, passes an admin', ...);   // Review Focus 5
// hooks.client.test.ts
it('reportBrowserError posts message, stack and url to /api/errors without credentials and stops after 10 reports', ...);
// admin/streamers/page.test.ts
it('shows search results with ban and warnings, asks for a reason before banning and calls POST /api/admin/bans', ...);
// giveaways/overview.test.ts
it('shows the ban reason in a red stripe and disables the start button; shows each warning with its reason', ...);   // Review Focus 5
```

- [ ] **Step 2: Tests laufen lassen, sie scheitern**
- [ ] **Step 3: Implementieren**
- [ ] **Step 4: Prüfen** (`npm run typecheck`, `npm run lint`, `npm test`, `npm run test:e2e`)
- [ ] **Step 5: Commit** `feat(web): Verwaltung, Rückmeldung, Fehlerbericht und Hinweise für gesperrte oder verwarnte Streamer`

---

### Task 5: Doku und Stand

**Files:**
- Modify: `README.md`, `CLAUDE.md`, `.env.example`

- [ ] **Step 1:** README: Prozesse (Admin-Routen, `/api/terms`, `/api/errors`, `/api/feedback`), Begriffe (Superadmin, Plattform-Strom, Sperre des Streamers, Verwarnung, Fassung, Rückmeldung, Browser-Fehler), Entwickeln (`ADMIN_TWITCH_IDS`), Stand „8c fertig, als Nächstes Chat-Ansagen (10.3)“. CLAUDE.md: Abschnitt **Plattform** (Strom, Admin-Prüfung, Betriebsdaten, Fristen), Befehle (`ADMIN_TWITCH_IDS`), Web-Seiten `/admin/*`, Stand. `.env.example`: `ADMIN_TWITCH_IDS=`.
- [ ] **Step 2: Prüfen** (`npm run lint`)
- [ ] **Step 3: Commit** `docs: Verwaltung, Plattform-Strom, Stand Teilprojekt 8c`

---

## Selbstprüfung gegen die Spec

- 11.4 Betrieb: Health, Ingest je Kanal, Fehler (abgelehnte Befehle aus `access_log`), Browser-Fehler (Task 3, 4). Sperren und Verwarnungen für Streamer (Task 1, 2, 4). Rückmeldungen (Task 3, 4).
- 5.1 Strom `platform` mit Sperren, Verwarnungen, Nutzungsbedingungen (Task 1); 5.3 Umkehrarten je Typ (Task 1); 5.5 Lesezugriffe mit Namen im Zugriffslog (Task 3).
- 9.2 Nutzungsbedingungen versioniert und erzwungen: Fassung aus dem Strom, Annahme Pflicht (Task 2, 4).
- 12.4 Browser-Fehler 30 Tage ohne Personenbezug (Task 3). 12.1 Ablehnungen in Klartext (Task 4).
- 3.3 Ein Schreibweg: alle Nachweise über `CommandBus.execute`; Betriebsdaten-Tabellen sind keine Nachweise (Festlegung 6, wie `channel_status`).
