# Teilprojekt 8b: SvelteKit-Oberflächen (Streamer-App, Teilnehmer-Portal) – Umsetzungsplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Die Oberflächen aus NEW_DESIGN.md 11.1–11.3 und 11.5 als SvelteKit-Paket `packages/web`: Streamer-App (Übersicht, Giveaway-Detail mit Statusblock, Warnstreifen, Aktionsleiste, Teilnehmerliste, Verlauf mit Rückgängig, Start-Assistent, Team, Kanäle, Rechtstexte, Streamermodus), Teilnehmer-Portal (eigene Giveaways, Bedingungen, Chance live, Teilnehmen, Tickets, Gewinn, Meine Daten) und eine öffentliche Giveaway-Seite, im RDOC-Design, mit Live-Push und Playwright-E2E.

**Architecture:** `web` spricht nur mit `api` (Spec 3.4). Alle Server-Routen außer `/healthz` wandern unter das Präfix `/api`, damit Seiten- und API-Pfade nicht kollidieren; der Browser ruft same-origin `/api/*`, im Dev-Modus leitet Vite weiter, beim Server-Rendern schreibt `handleFetch` auf `API_URL` um und reicht das Sitzungs-Cookie durch. Jede Seite lädt ihre Daten in `load` über einen kleinen Client (`$lib/api`), Befehle laufen als `POST` und antworten `{ events }`, danach lädt die Seite ihre Daten neu. Live-Push: ein WebSocket-Client abonniert die Ströme der sichtbaren Seite und ruft `invalidate` je Ereignis. Alle UI-Texte stehen in zwei Modulen (`labels.ts`, `sentences.ts`), die der Text-Linter aus 8a prüft. Design: Tokens aus `brand.css` als `app.css` (Überschriften 400 statt 500, Spec 11.5), Schriften selbst gehostet (fontsource), Dark Standard, ein Kupfer-Element je Ansicht, Zustände als Wort + Icon.

**Tech Stack:** SvelteKit 3 (Svelte 5 Runes) mit `@sveltejs/adapter-node`, Vite 8, TypeScript 6, Vitest (jsdom + `@testing-library/svelte` für Komponenten), Playwright für E2E, `eslint-plugin-svelte`, `svelte-check`, `@fontsource/ibm-plex-sans`, `@fontsource/ibm-plex-mono`, `@fontsource/michroma`. Server: nur Fastify-Präfix, drei Lese-Erweiterungen, Linter-Modus.

**Spec:** `NEW_DESIGN.md` 3.2, 3.4 (`web` nutzt nur `api`), 5.3 (Rückgängig in der UI), 6.5 (Status laufend), 7.1–7.3, 9.2–9.4, 11.1–11.3, 11.5, 11.6, 12.1 („verbindet neu“), 12.2 (E2E Playwright). Nicht hier: 11.4 Verwaltung (8c), 10.3 Chat-Ansagen (eigener Plan), Caddy und Produktions-Compose (Teilprojekt 10).

## Global Constraints

- `web` importiert nichts aus `packages/server`. Antworttypen stehen als eigene Typen in `packages/web/src/lib/api/types.ts` (Spec 3.4).
- Jede Zustandsänderung aus der Oberfläche ist ein API-Aufruf, der Server führt sie über `CommandBus.execute` aus. Die Oberfläche hält keinen eigenen Zustand über den Server hinaus (außer Streamermodus und Theme im `localStorage`).
- Keine Browser-Dialoge: kein `alert`, `confirm`, `prompt`. ESLint-Regel `no-restricted-globals` in `packages/web/eslint.config.js`.
- Alle UI-Texte deutsch, aktiv, Anweisungen höchstens 20 Wörter, kein Semikolon, Glossar-Begriffe, Fehlertext = was passiert ist + was zu tun ist. Jeder Text steht in `src/lib/texts/labels.ts` oder `src/lib/texts/sentences.ts`, nie im Markup. Der Linter prüft beide Dateien in `npm run lint`.
- Design (11.5): Tokens aus `brand.css` (Werte verbatim), Überschriften `font-weight: 400`, Michroma nur für Überschriften, IBM Plex Sans 400/600, IBM Plex Mono für Labels. Genau ein `btn-primary` (Kupfer) je Ansicht. Patina nur für Tabellenköpfe, Abschnittsmarken, aktive Navigation. Zustände als Wort + Icon. Keine Schatten, Verläufe, Glüheffekte. Gedämpfter Text (`--muted`) nur auf `--bg`, nie auf `--surface`.
- Streamermodus maskiert jeden Teilnehmer-Namen (Teilnehmerliste, Gewinner, Verlauf, Team-Sperren). Kanalnamen (Streamer) bleiben sichtbar. Tokens zeigt die Oberfläche nie.
- Kontrast nach WCAG: Text 4,5:1, große Schrift und UI 3:1. Light-Mode nutzt die Light-Werte aus `brand.css`.
- Tests ohne Netz. Komponenten-Tests in jsdom, E2E gegen einen lokalen Stack mit Twitch-Stub und Testcontainers.
- Je Task erst den Code fertig schreiben, dann einmal `npm run typecheck`, `npm run lint`, `npm test` von der Wurzel.

## Entscheidungen, die die Spec offen lässt (meine Festlegungen)

1. **API-Präfix `/api`:** Alle Routen außer `/healthz` registriert `buildApp` in einem Plugin mit `prefix: '/api'`. Redirect-URI der Twitch-App wird `PUBLIC_URL/api/auth/twitch/callback`. Der Einladungslink bleibt `PUBLIC_URL/teams/join/<inviteId>` (das ist jetzt eine Seite der Web-App). `/ws` wird `/api/ws`. Die Server-Tests ziehen die Pfade nach.
2. **Zwei Prozesse, ein Ursprung:** `web` läuft als eigener Node-Prozess (adapter-node, `PORT` 3001). Produktion: Caddy leitet `/api/*` und `/healthz` an `app`, alles andere an `web` (Teilprojekt 10 schreibt Caddyfile und Compose). Dev: Vite-Proxy `/api` → `API_URL` (Default `http://localhost:3000`, `ws: true`). Server-Rendern: `hooks.server.ts` `handleFetch` schreibt Anfragen an `<origin>/api/*` auf `API_URL` um und setzt den `cookie`-Header der Seitenanfrage.
3. **Daten laden:** universelle `load`-Funktionen (`+page.ts`, `+layout.ts`) mit `depends('api:<pfad>')`. Nach jedem Befehl `invalidate` der betroffenen Abhängigkeit. Ein 401 beim Laden einer geschützten Seite leitet auf `/?return=<pfad>`; 403/404 zeigen die Fehlerseite mit der Meldung des Servers.
4. **Live-Push-Client** (`$lib/ws.ts`): verbindet zu `/api/ws`, abonniert Ströme je Seite, ruft je `event` `invalidate('api:stream:<stream>')`. Wiederverbinden nach Schließen mit Backoff 1 s, 2 s, 4 s … 30 s; Code 4401 (keine Sitzung) → kein Wiederverbinden, Weiterleitung auf `/`. Zustand `verbunden | verbindet neu` zeigt der Kopfbereich (12.1).
5. **Texte und Linter:** `labels.ts` exportiert `L` (kurze Beschriftungen für Knöpfe, Spalten, Navigation, höchstens 6 Wörter, Endsatzzeichen nicht nötig), `sentences.ts` exportiert `S` (ganze Sätze, auch Vorlagen als Funktionen mit Template-Literalen). Der Server-Linter bekommt zwei Dateimodi: `--labels <datei>` prüft jede Zeichenkette mit `checkLabel` (Bannliste, Semikolon, höchstens 6 Wörter), `--texts <datei>` mit `checkText`. Ohne Argumente läuft er wie bisher über `src/**/*.ts`.
6. **Streamermodus:** Schalter im Kopfbereich, `localStorage` `ccg.streamerMode`. Komponente `Name.svelte` zeigt im Streamermodus `Teilnehmer ·<erste 4 Zeichen der pid>` statt des Namens. Theme-Schalter daneben (`ccg.theme`: `system | dark | light`), setzt `data-theme` auf `<html>`.
7. **Tätigkeit im Statusblock:** Der Server liefert keinen Tätigkeits-Feed. Die Oberfläche leitet die Tätigkeit ab: Offen → „Sammelt Signale.“, Pausiert → „Pausiert. Zählt nichts.“, Geschlossen → „Wartet auf die Ziehung.“, Gezogen → „Gewinner melden sich.“, während ein Ziehungsbefehl läuft → „Prüft Bedingungen bei Twitch.“ mit unbestimmtem Fortschrittsbalken. „Letzte Berechnung“ = Zeitpunkt des letzten Ereignisses (Push `at` oder `updatedAt`).
8. **Ziehungsvorschau (7.2 Schritt 2):** Vor der Ziehung zeigt ein Panel den Topf (Einträge mit `inPool`, Chance) und die Zahl der Nicht-Berechtigten mit dem Hinweis, dass Bedingungen erst bei der Ziehung verbindlich geprüft werden. Nach der Ziehung zeigt der Ziehungsnachweis Gewinner, geprüfte Bedingungen je Person mit Gründen und Ausschlüsse (aus dem `giveaway_drawn`-Payload des Verlaufs).
9. **Start-Assistent:** sechs Schritte wie das Artboard (Kern → Preis und Regeln → Kanäle → Bedingungen → Rechtstexte → Prüfen und öffnen). Die Seitenleiste rechts zeigt die Zusammenfassung der bisherigen Eingaben statt der Live-Vorschau (8a-Festlegung 12, kommt mit Teilprojekt 10 oder entfällt). Der letzte Schritt bietet „Als Entwurf speichern“ (`POST /api/giveaways`) und „Prüfen und öffnen“ (`POST` + `POST …/open`). Eine Ablehnung des Servers erscheint am Schritt, zu dem das Feld gehört (`keyword_reserved` → Schritt 2, `invalid_gate` → Schritt 4, `legal_*` → Schritt 5, sonst Schritt 6).
10. **Übersicht-Erweiterung (Server):** `GET /api/giveaways` liefert je Kachel zusätzlich `claimDays`, `drawnAt` (Zeitpunkt der gültigen Ziehung, sonst null) und `winnerStatuses` (`Record<WinnerStatus, number>`), damit „Abgeschlossene mit Meldefrist“ ohne Detail-Aufruf geht. `GET /api/giveaways/:id` liefert zusätzlich `drawnAt`.
11. **Verlaufstexte:** `GET /api/giveaways/:id/history` liefert zusätzlich `names: Record<pid, displayName>` für alle UUIDs in den Payloads der Seite, die in `identities` stehen. Die Oberfläche bildet je Ereignistyp einen deutschen Satz (`$lib/history-text.ts`), unbekannte Typen zeigen den Typ und die Payload-Schlüssel.
12. **Einstellungen ändern im Detail:** ein Panel mit denselben Formularen wie Assistent Schritt 2 und 4 (plus Kanäle, Kontaktweg), nur in Entwurf, Offen, Pausiert. Es sendet `PUT …/settings` mit dem ganzen `settings`-Objekt.
13. **Kern-Befehle in der Oberfläche:** Knöpfe für `commands` mit `issuer: 'streamer'` erscheinen in der Aktionsleiste (Label aus dem Katalog, Argumente leer); `issuer: 'participant'`-Befehle erscheinen im Portal, Argument `count` als Zahlenfeld, wenn `chat` gesetzt ist (Ticketkauf). Weitere Argument-Formen gibt es in Version 1 nicht.
14. **Leerer JSON-Body:** Der Client setzt `content-type: application/json` nur, wenn ein Body mitgeht (Fastify lehnt leeren JSON-Body ab).
15. **E2E (12.2):** `packages/web/e2e/` mit Playwright. `stack.ts` startet PostgreSQL per Testcontainers, Migrationen, `createRuntime` + `attachAccounts` + `buildApp` mit Twitch-Stub (dessen `authorizeUrl` direkt auf den Callback zeigt) und `LocalBus` auf Port 3100 plus eine Steuerroute `POST /__e2e/user { login }` für die Person der nächsten Anmeldung. Ein Spec deckt ab: anmelden, Nutzungsbedingungen, Kanal verbinden, Rechtstexte, Assistent (Kern B), öffnen, Teilnehmer meldet sich im Portal an, pausieren, fortsetzen, schließen, ziehen, Rückgängig, Konto löschen. CI installiert Chromium und führt `npm run test:e2e` nach den Unit-Tests aus.
16. **Nicht hier:** Verwaltung 11.4 (8c), Chat-Ansagen (10.3), Caddy/Compose (10), Live-Vorschau im Assistenten (10), Übernahme (9).

## Review Focus

1. Streamermodus: Teilnehmerliste, Gewinner, Verlauf und Team-Sperren zeigen keinen Namen, Kanalnamen bleiben. Test in Task 4 (Teilnehmerliste, Verlauf) und Task 3 (Team).
2. Abgelaufene Sitzung mitten in der Arbeit: 401 einer `load`-Anfrage leitet auf `/?return=…`, WebSocket-Code 4401 verbindet nicht neu. Test in Task 2.
3. Ablehnung eines Befehls (`pool_changed`, `reason_required`, `not_open`) erscheint als Text am Knopf, kein Dialog, Seite bleibt bedienbar. Test in Task 4 (Detail) und Task 6 (Portal).
4. WebSocket-Schließen mit 1012 verbindet mit Backoff neu und lädt die abonnierten Ströme neu. Test in Task 2.
5. Assistent: `follow` mit `mode: 'channel'` braucht einen gewählten Kanal, `min` höchstens so viele wie Kanäle, `presence.minChannels` ebenso; die Oberfläche verhindert ungültige Werte vor dem Senden. Test in Task 5.

---

## Dateistruktur

```
packages/server/src/app/build-app.ts                     Präfix /api für alle Routen außer /healthz
packages/server/src/api/giveaways.ts                      Kacheln: claimDays, drawnAt, winnerStatuses
packages/server/src/api/giveaways-read.ts                 GiveawayDetail.drawnAt, historyPage(...).names, drawnAtOf
packages/server/src/shared/text-rules.ts                  checkLabel, extractAllStrings, LABEL_MAX_WORDS
packages/server/scripts/text-lint.ts                      Modi --labels, --texts
packages/server/test/*.ts                                 Pfade /api/…, neue Tests
packages/web/package.json                                 @ccg/web: dev, build, preview, typecheck, lint, lint:text, test, test:e2e, start
packages/web/svelte.config.js, vite.config.ts, tsconfig.json, eslint.config.js, playwright.config.ts
packages/web/src/app.html, app.css, app.d.ts, hooks.server.ts
packages/web/src/lib/api/client.ts                        api.get/post/put/del, ApiError, UNAUTHORIZED → redirect
packages/web/src/lib/api/types.ts                         Antworttypen (Me, Tile, GiveawayDetail, ParticipantView, HistoryPage, Portal*, Team*, KernelInfo, ChannelStatus)
packages/web/src/lib/ws.ts                                LiveClient: connect, subscribe, backoff, onEvent → invalidate
packages/web/src/lib/texts/labels.ts, sentences.ts         L, S
packages/web/src/lib/format.ts                            percent, duration, dateTime, relative, number (de-DE)
packages/web/src/lib/mask.ts                              maskName(pid), Streamermodus-Store
packages/web/src/lib/theme.ts                             Theme-Store
packages/web/src/lib/status.ts                            STATUS_VIEW (Wort, Icon, Farbe), activityOf(status, busy), actionsOf(status, kernelCommands)
packages/web/src/lib/history-text.ts                      historyText(entry, names)
packages/web/src/lib/wizard.ts                            WizardDraft, defaults aus KernelInfo, validateStep, toSettings, stepOfRejection
packages/web/src/lib/components/                          Icon, StateBadge, Button, Confirm, Name, Panel, Field, ConfigForm, GatesForm, LegalForm, ChannelStatus, LiveDot
packages/web/src/routes/+layout.svelte, +layout.ts        Kopfbereich, Navigation, Streamermodus, Theme, Live-Zustand
packages/web/src/routes/+page.svelte, +page.ts            Start: Anmelden oder Weiterleitung
packages/web/src/routes/+error.svelte
packages/web/src/routes/terms/, legal/, channel/          Nutzungsbedingungen, Rechtstexte, Kanal
packages/web/src/routes/teams/, teams/[id]/, teams/join/[inviteId]/
packages/web/src/routes/giveaways/                        Übersicht
packages/web/src/routes/giveaways/new/                    Start-Assistent
packages/web/src/routes/giveaways/[id]/, [id]/history/    Detail, ganzer Verlauf
packages/web/src/routes/portal/, portal/giveaways/[id]/, portal/data/
packages/web/src/routes/g/[id]/                           öffentliche Giveaway-Seite
packages/web/src/**/*.test.ts                             Vitest (jsdom)
packages/web/e2e/stack.ts, e2e/giveaway.spec.ts
.github/workflows/ci.yml                                  Playwright-Schritt
.env.example, README.md, CLAUDE.md
```

---

### Task 1: Server: API-Präfix, Lese-Erweiterungen, Linter-Modi

**Files:**
- Modify: `packages/server/src/app/build-app.ts`, `src/api/giveaways.ts`, `src/api/giveaways-read.ts`, `src/api/auth.ts` (nur Kommentar Redirect-URI), `src/shared/text-rules.ts`, `scripts/text-lint.ts`
- Modify (Pfade): `test/helpers/api.ts`, `test/api-auth.test.ts`, `test/api-me.test.ts`, `test/api-teams.test.ts`, `test/api-giveaways.test.ts`, `test/api-portal.test.ts`, `test/api-ws.test.ts`, `test/channel-status.test.ts`
- Test: `test/api-giveaways.test.ts`, `test/text-rules.test.ts`, `test/app.test.ts`

**Interfaces:**
- Produces (`build-app.ts`): alle Routen außer `/healthz` unter `/api` (`app.register(async (api) => { registerAuthRoutes(api, …); … }, { prefix: '/api' })`, WebSocket-Plugin innerhalb dieses Plugins, `registerNoPush` ebenso). `app.decorate('wsSockets', …)` bleibt auf der Wurzel-Instanz, `closeAllSockets(app)` unverändert.
- Produces (`auth.ts`): `redirectUri = \`${deps.publicUrl}/api/auth/twitch/callback\``. Einladungs-URL in `teams.ts` bleibt `${publicUrl}/teams/join/${inviteId}`.
- Produces (`giveaways-read.ts`):
  - `GiveawayDetail.drawnAt: string | null` (ISO des gültigen `giveaway_drawn`, über `readEvent` wie im Portal).
  - `drawnAtOf(c, registry, state): Promise<string | null>` exportiert, Portal und Kacheln nutzen es.
  - `historyPage(...)` liefert `{ entries, nextBeforeSeq, names: Record<string, string> }`; `names` = `displayNamesOf` aller UUID-Zeichenketten in `payload` (rekursiv über Objekte und Arrays), nur Treffer.
- Produces (`giveaways.ts`, Kacheln): zusätzlich `claimDays: number`, `drawnAt: string | null` (eine Abfrage für alle Kacheln: `SELECT stream, created_at, id FROM events WHERE type = 'giveaway_drawn' AND stream = ANY($1)`; gültig = nicht in `revertedIds`), `winnerStatuses: Record<WinnerStatus, number>` (eine Abfrage `GROUP BY giveaway_id, winner_status`).
- Produces (`text-rules.ts`): `LABEL_MAX_WORDS = 6`, `checkLabel(text): string[]` (Gründe `zu_lang`, `semikolon`, `bannwort:<wort>`, kein Satzzeichen-Zwang), `extractAllStrings(source): UiText[]` (jede `'…'`- und `` `…` ``-Zeichenkette außerhalb von Kommentaren und Importzeilen, Platzhalter bleiben als `${…}`).
- Produces (`text-lint.ts`): Argumente `--labels <datei>` und `--texts <datei>` (mehrfach, Pfade relativ zum Arbeitsverzeichnis); mit Argumenten prüft es nur diese Dateien, ohne Argumente wie bisher. Ausgabe und Exit-Code unverändert.

- [ ] **Step 1: Tests schreiben**

```ts
// app.test.ts: ergänzen
it('serves /healthz at the root and every other route under /api', async () => {
  // setupApi, GET /me → 404 (keine Route), GET /api/me → 401
});
// api-auth.test.ts: redirect_uri endet auf /api/auth/twitch/callback; alle url: '/auth/…' → '/api/auth/…'
// api-giveaways.test.ts: ergänzen
it('tiles carry claimDays, drawnAt of the valid draw and winnerStatuses counts', ...);
it('detail carries drawnAt, null before the draw', ...);
it('history page carries names for pids inside payloads (participant_registered.pid)', ...);
// text-rules.test.ts: ergänzen
it('checkLabel allows "Giveaway starten" without a period, rejects a semicolon, a banned word and 7 words', ...);
it('extractAllStrings finds single- and backtick-quoted strings, skips import lines and comments', ...);
```

- [ ] **Step 2: Pfade in den Tests umstellen** (`sed -i "s#url: '/#url: '/api/#; s#url: \`/#url: \`/api/#" test/api-*.test.ts test/channel-status.test.ts`, danach `/api/healthz` → `/healthz` zurück, `cookie`-Pfade und `location`-Erwartungen prüfen: `location` nach Login bleibt `/dashboard` bzw. `/`), WebSocket-URL in `api-ws.test.ts` auf `/api/ws`.
- [ ] **Step 3: Tests laufen lassen, sie scheitern**
- [ ] **Step 4: Implementieren** (Präfix-Plugin, Lese-Erweiterungen, Linter)
- [ ] **Step 5: Prüfen** (`npm run typecheck`, `npm run lint`, `npm test`)
- [ ] **Step 6: Commit** `feat(api): Routen unter /api, Kacheln mit Meldefrist, Verlauf mit Namen, Text-Linter mit Dateimodi`

---

### Task 2: Web-Grundgerüst: Paket, Design, API-Client, Live-Push, Texte, Kopfbereich, Start

**Files:**
- Create: `packages/web/**` (Scaffold mit `npx sv@latest create packages/web --template minimal --types ts --no-add-ons --no-install`, danach `@sveltejs/adapter-node`, Vitest, jsdom, `@testing-library/svelte`, `eslint-plugin-svelte`, `svelte-check`, fontsource-Pakete), `src/app.css`, `src/hooks.server.ts`, `src/lib/api/client.ts`, `src/lib/api/types.ts`, `src/lib/ws.ts`, `src/lib/texts/labels.ts`, `src/lib/texts/sentences.ts`, `src/lib/format.ts`, `src/lib/mask.ts`, `src/lib/theme.ts`, `src/lib/components/{Icon,StateBadge,Button,Confirm,Name,Panel,Field,LiveDot}.svelte`, `src/routes/+layout.svelte`, `+layout.ts`, `+page.svelte`, `+page.ts`, `+error.svelte`
- Modify: `package.json` (Wurzel: `test:e2e`), `.env.example` (`API_URL`, `WEB_PORT`), `packages/web/package.json`
- Test: `src/lib/format.test.ts`, `src/lib/mask.test.ts`, `src/lib/api/client.test.ts`, `src/lib/ws.test.ts`, `src/lib/components/StateBadge.test.ts`, `src/lib/components/Confirm.test.ts`

**Interfaces:**
- Produces (`packages/web/package.json`, Name `@ccg/web`): Skripte `dev` (`vite dev --port 3001`), `build` (`vite build`), `preview`, `start` (`node build`), `typecheck` (`svelte-check --tsconfig ./tsconfig.json`), `lint` (`eslint . && npm run lint:text`), `lint:text` (`tsx ../server/scripts/text-lint.ts --labels src/lib/texts/labels.ts --texts src/lib/texts/sentences.ts`), `test` (`vitest run`), `test:e2e` (`playwright test`, Task 7). Vitest in `vite.config.ts`: `environment: 'jsdom'`, `include: ['src/**/*.test.ts']`, `resolve: { conditions: ['browser'] }` nur im Testlauf.
- Produces (`vite.config.ts`): `server.proxy['/api'] = { target: process.env.API_URL ?? 'http://localhost:3000', ws: true, changeOrigin: false }`.
- Produces (`hooks.server.ts`): `handleFetch` schreibt `${event.url.origin}/api/…` auf `${env.API_URL}/api/…` um und setzt `cookie` aus `event.request.headers`. `API_URL` aus `$env/dynamic/private`, Default `http://localhost:3000`.
- Produces (`app.css`): Tokens aus `brand.css` verbatim als `--rdoc-*` auf `:root`, Light über `@media (prefers-color-scheme: light)` und `[data-theme="light"]`, `[data-theme="dark"]`; `h1,h2,h3 { font-weight: 400 }`; `@import '@fontsource/ibm-plex-sans/400.css'` usw.; Basisklassen `.lbl`, `.btn`, `.btn-primary`, `.btn-ghost`, `.panel`, `table` wie die Artboards (Radius 2 px, Rahmen 1 px, keine Schatten).
- Produces (`api/client.ts`):
  ```ts
  export class ApiError extends Error { constructor(readonly status: number, readonly code: string, message: string) }
  export interface Api { get<T>(path: string): Promise<T>; post<T>(path: string, body?: unknown): Promise<T>; put<T>(path: string, body: unknown): Promise<T>; del<T>(path: string): Promise<T>; }
  export function apiOf(fetchFn: typeof fetch): Api;   // in load: apiOf(fetch); im Browser: api = apiOf(globalThis.fetch)
  export function loadOrRedirect<T>(p: Promise<T>, url: URL): Promise<T>;  // ApiError 401 → redirect(303, `/?return=${pathname}`), 403/404 → error(status, message)
  ```
  Antworten ohne Body (204) liefern `undefined`. Fehler-Body `{ code, message }` → `ApiError`, ohne Body → `ApiError(status, 'http_error', S.serverError)`.
- Produces (`api/types.ts`): `Me`, `Tile`, `GiveawayDetail`, `ParticipantView`, `HistoryEntry`, `HistoryPage`, `KernelInfo`, `ConfigField`, `GateConfig`, `LegalTexts`, `FrozenLegal`, `ChannelStatus`, `TeamList`, `TeamDetail`, `Invite`, `PortalTile`, `PortalDetail`, `PublicGiveaway`, `GiveawayStatus`, `WinnerStatus`, `EventRef`, `CommandResult = { events: EventRef[] }` – Felder wie die Server-Antworten (8a-Plan Tasks 1–3 plus Task 1 hier).
- Produces (`ws.ts`):
  ```ts
  export type LiveState = 'connected' | 'reconnecting' | 'off';
  export interface LiveClient { subscribe(streams: string[]): () => void; state: Readable<LiveState>; close(): void }
  export function createLiveClient(o: { url: string; makeSocket: (url: string) => WebSocket; onEvent: (e: { stream: string; seq: number; type: string; id: string; at: string }) => void; onNoSession: () => void; backoffMs?: (attempt: number) => number }): LiveClient;
  export const defaultBackoff = (attempt: number) => Math.min(30_000, 1000 * 2 ** attempt);
  ```
  `subscribe` sendet `{ subscribe }` sofort oder nach dem Öffnen, die Rückgabe sendet `{ unsubscribe }`. Schließen mit 4401 → `onNoSession()`, kein Wiederverbinden. Jedes andere Schließen → Wiederverbinden mit Backoff, nach dem Öffnen alle Abos erneut senden. `live.ts` (Browser) verdrahtet `onEvent` mit `invalidate(\`api:stream:${e.stream}\`)` und `onNoSession` mit `goto('/')`.
- Produces (`texts/labels.ts`): `export const L = { nav: { overview, giveaways, team, channel, legal, portal }, actions: { start, pause, resume, close, reopen, draw, redraw, cancel, complete, boost, stopBoost, correct, revert, settings, back, next, save, openNow, join, withdraw, buyTickets, checkGates, reconnect, logout, login, download, deleteAll, confirm, abort }, columns: {...}, status: { draft, open, paused, closed, drawn, completed, cancelled }, winner: { pending, reported, shipped, done, forfeited }, streamerMode, theme: {...} } as const`.
- Produces (`texts/sentences.ts`): `export const S = { noSession, serverError, reconnecting, chanceHint, activity: { open, paused, closed, drawn, drawing, draft, completed, cancelled }, confirmRevert, reasonRequired, … , claimUntil: (name: string, date: string) => …, poolSummary: (ok: number, no: number) => … }`.
- Produces (`format.ts`): `percent(x: number | null): string` („0,23 %“, 2 Nachkommastellen, null → „–“), `duration(sec: number): string` (wie `formatDuration` im Kern: „1 h 23 min“), `dateTime(iso: string): string` (`de-DE`, „4. Okt., 18:02“), `date(iso)`, `relative(iso, now): string` („vor 8 s“, „vor 6 min“, „vor 3 Tagen“), `number(n)`.
- Produces (`mask.ts`): `maskName(pid: string): string` → `Teilnehmer ·${pid.slice(0, 4)}`, `streamerMode: Writable<boolean>` (localStorage `ccg.streamerMode`, in jsdom/SSR ohne Storage `false`).
- Produces (`theme.ts`): `theme: Writable<'system' | 'dark' | 'light'>`, `applyTheme(t)` setzt oder entfernt `data-theme` auf `document.documentElement`.
- Produces (Komponenten): `Icon { name: 'check' | 'pause' | 'play' | 'lock' | 'star' | 'warn' | 'bolt' | 'plus' | 'x' | 'circle' | 'dot' | 'undo' | 'live' }` (Inline-SVG, `aria-hidden`), `StateBadge { status: GiveawayStatus }` (Wort aus `L.status` + Icon, Farbe über Klasse `st-ok|st-info|st-warn|st-err|st-muted`), `Button { kind: 'primary' | 'default' | 'ghost', busy?, disabled?, onclick }`, `Confirm { title, text, reason?: boolean, confirmLabel, onconfirm(reason?: string), oncancel }` (Inline-Panel, Fokus auf das erste Element, Grund Pflicht, wenn `reason`), `Name { pid, displayName }` (maskiert im Streamermodus), `Panel { title?, tone?: 'warn' | 'error' | 'info' }`, `Field { label, help?, error? }`, `LiveDot { state: LiveState }`.
- Produces (`+layout.ts`): lädt `/api/me`; 401 → `me: null`. `+layout.svelte`: Kopfbereich wie die Artboards (Wortmarke, Navigation nur mit Sitzung: Übersicht, Giveaways, Team, Kanäle, Rechtstexte, Portal; aktive Seite mit Patina-Unterstrich), Streamermodus-Schalter, Theme-Schalter, `LiveDot`, Anzeigename, Abmelden (`POST /api/auth/logout`, dann `goto('/')`). Ohne Sitzung nur Wortmarke und „Mit Twitch anmelden“ (`/api/auth/twitch/login?return=…`).
- Produces (`+page.ts` `/`): mit Sitzung `redirect(303, searchParams.return ?? '/giveaways')`, ohne Sitzung Startseite mit Anmelde-Knopf (das Kupfer-Element) und zwei Zeilen: für Streamer, für Zuschauer (`/portal`).
- Produces (`+error.svelte`): Status + Meldung, Link zurück.

- [ ] **Step 1: Scaffold anlegen und Abhängigkeiten installieren** (`npx sv@latest create …`, `npm install -w packages/web -D @sveltejs/adapter-node vitest jsdom @testing-library/svelte @testing-library/jest-dom eslint-plugin-svelte svelte-check @playwright/test && npm install -w packages/web @fontsource/ibm-plex-sans @fontsource/ibm-plex-mono @fontsource/michroma`), `npm run dev -w packages/web` startet.
- [ ] **Step 2: Tests schreiben**

```ts
// format.test.ts
it('percent formats 0.0023 as "0,23 %" and null as "–"', ...);
it('duration renders 0, 37 min, 1 h 23 min, 100 h', ...);
it('relative renders seconds, minutes, days in German', ...);
// mask.test.ts
it('maskName uses the first four characters of the pid', ...);
// client.test.ts (fetch-Stub)
it('post sends JSON content-type only with a body', ...);   // Festlegung 14
it('maps {code,message} errors to ApiError with status; 204 → undefined', ...);
it('loadOrRedirect turns 401 into redirect(303, "/?return=…") and 403 into error(403, message)', ...);   // Review Focus 2
// ws.test.ts (FakeSocket)
it('sends subscribe after open, re-sends all subscriptions after reconnect with backoff', ...);   // Review Focus 4
it('close code 4401 calls onNoSession and does not reconnect', ...);   // Review Focus 2
it('event messages reach onEvent, error messages do not throw', ...);
// StateBadge.test.ts
it('renders the German word and an icon for every status', ...);
// Confirm.test.ts
it('requires a reason when reason is true and never calls window.confirm', ...);
```

- [ ] **Step 3: Tests laufen lassen, sie scheitern**
- [ ] **Step 4: Implementieren** (app.css, Client, Live-Client, Texte, Komponenten, Layout, Start)
- [ ] **Step 5: Prüfen** (`npm run typecheck`, `npm run lint`, `npm test` von der Wurzel; `lint:text` meldet 0 Verstöße)
- [ ] **Step 6: Commit** `feat(web): SvelteKit-Paket mit RDOC-Design, API-Client, Live-Push, Texten und Kopfbereich`

---

### Task 3: Streamer-App: Übersicht, Nutzungsbedingungen, Rechtstexte, Kanal, Team

**Files:**
- Create: `src/routes/giveaways/+page.ts`, `+page.svelte`, `src/routes/terms/+page.*`, `src/routes/legal/+page.*`, `src/routes/channel/+page.*`, `src/routes/teams/+page.*`, `src/routes/teams/[id]/+page.*`, `src/routes/teams/join/[inviteId]/+page.*`, `src/lib/components/{ChannelStatus,LegalForm,Tile}.svelte`, `src/lib/guard.ts`
- Test: `src/lib/components/Tile.test.ts`, `src/lib/components/ChannelStatus.test.ts`, `src/lib/components/LegalForm.test.ts`, `src/lib/guard.test.ts`, `src/routes/teams/[id]/page.test.ts`

**Interfaces:**
- Consumes: `apiOf`, `loadOrRedirect`, `L`, `S`, `format`, `Name`, `StateBadge`, `Panel`, `Button` (Task 2).
- Produces (`guard.ts`): `requireStreamer(me: Me | null, url: URL): Me` → ohne Sitzung `redirect(303, '/?return=…')`, mit `termsVersion < currentTermsVersion` `redirect(303, '/terms?return=…')` (Spec 9.2 Schritt 3, erzwungen). Portal-Seiten nutzen `requireSession(me, url)` (nur Sitzung).
- Produces (`/giveaways`): lädt `/api/giveaways` und `/api/me/channel`, `depends('api:giveaways')`. Abschnitte wie das Artboard: Kopf mit Team-Zeile („Solo“ ohne das Wort Team, Spec 9.3) und Kupfer-Knopf „Giveaway starten“ (`/giveaways/new`); Zeile „Verbindung“ mit `ChannelStatus` des eigenen Kanals und Link „Kanal neu verbinden“ (`/api/auth/twitch/connect?return=/giveaways`) bei Warnung; Kacheln (`Tile`) für `draft|open|paused|closed`: Kern-Label, `StateBadge`, Gewinn, Teilnehmer, Im Topf, „Zuletzt aktiv“ (`relative(updatedAt)`), erste Warnung; Liste „Gezogen und abgeschlossen“ für `drawn|completed`: Gewinn, Kern, „gezogen <date>“, Meldefrist `drawnAt + claimDays` („Meldefrist läuft: noch n Tage“ gelb oder „abgelaufen“), Gewinnerstatus-Zusammenfassung aus `winnerStatuses`; `cancelled` am Ende, gedämpft. Live: abonniert `giveaway:<id>` aller Kacheln.
- Produces (`/terms`): zeigt `currentTermsVersion`, Checkliste der Pflichten (Spec 9.4 Plattform-Seite: Impressum, Datenschutz, Nutzungsbedingungen), Knopf „Annehmen“ (`POST /api/me/terms { version }`), danach `goto(return)`.
- Produces (`/legal`): `LegalForm { value: LegalTexts, onsubmit }` mit Impressum-URL, Teilnahmebedingungen (Text oder URL, Umschalter), Datenschutz-URL, Checkliste der nötigen Inhalte (Spec 9.4, keine Mustertexte), `PUT /api/me/profile { legal }`. Hinweis, dass ohne die drei Angaben kein Giveaway öffnet.
- Produces (`/channel`): `ChannelStatus { v: ChannelStatus, name? }` (live/offline Wort + Icon, letztes Signal relativ, Zuschauer, Abdeckung in %, Warnung als `Panel` mit Text aus `warning.text`), Knöpfe „Kanal verbinden“ / „Kanal neu verbinden“ (Connect-Flow) und „Verbindung trennen“ (`DELETE /api/me/channel`, mit `Confirm`). Scopes als Liste.
- Produces (`/teams`): `/api/me/teams`: Solo-Zeile, Teams mit Mitgliederzahl, aktiv; „Team gründen“ (Name, `POST /api/teams`). `/teams/[id]`: Name (umbenennen inline), Mitglieder (`Name`, Review Focus 1: Mitglieder sind Streamer, nicht maskiert), Einladungen (Link anzeigen, kopieren, widerrufen, neuer Link), Sperren (`Name` maskiert, entsperren), verlassen/deaktivieren/reaktivieren mit `Confirm`. `/teams/join/[inviteId]`: `GET /api/teams/join/:id` ohne Sitzung; ohne Sitzung Anmelde-Knopf mit `return`, mit Sitzung „Beitreten“ (`POST`), ungültig → Hinweis.

- [ ] **Step 1: Tests schreiben**

```ts
// guard.test.ts
it('requireStreamer redirects without session to /?return and without accepted terms to /terms?return', ...);
// Tile.test.ts
it('shows kernel label, status word with icon, counts and the first warning', ...);
it('drawn tile shows claim deadline from drawnAt + claimDays and winner status counts', ...);
// ChannelStatus.test.ts
it('shows live word, relative last signal, coverage percent and the warning text; token invalid renders red', ...);
// LegalForm.test.ts
it('switches terms between text and url and submits a LegalTexts object with nulls for empty fields', ...);
// teams/[id]/page.test.ts
it('masks banned pids in streamer mode but not member names', ...);   // Review Focus 1
```

- [ ] **Step 2: Tests laufen lassen, sie scheitern**
- [ ] **Step 3: Implementieren**
- [ ] **Step 4: Prüfen**
- [ ] **Step 5: Commit** `feat(web): Übersicht, Nutzungsbedingungen, Rechtstexte, Kanal und Team`

---

### Task 4: Giveaway-Detail: Statusblock, Aktionen, Teilnehmer, Verlauf, Ziehung

**Files:**
- Create: `src/routes/giveaways/[id]/+page.ts`, `+page.svelte`, `src/routes/giveaways/[id]/history/+page.*`, `src/lib/status.ts`, `src/lib/history-text.ts`, `src/lib/components/{StatusBlock,ActionBar,Participants,History,DrawPanel,BoostForm,CorrectionForm,SettingsPanel,WinnerStatusSelect}.svelte`
- Test: `src/lib/status.test.ts`, `src/lib/history-text.test.ts`, `src/lib/components/Participants.test.ts`, `src/lib/components/History.test.ts`, `src/lib/components/ActionBar.test.ts`

**Interfaces:**
- Consumes: Typen und Client (Task 2), `ConfigForm`/`GatesForm` (Task 5 liefert sie; dieser Task baut `SettingsPanel` mit einfachen Feldern und bindet die Formulare in Task 5 ein – Reihenfolge: Task 4 vor Task 5, `SettingsPanel` nutzt bis dahin `Field`-Eingaben für Gewinn, Sponsor, Keyword, Kontaktweg, Kanäle; Task 5 ergänzt Kern-Konfiguration und Bedingungen).
- Produces (`status.ts`):
  ```ts
  export const STATUS_VIEW: Record<GiveawayStatus, { word: string; icon: IconName; tone: 'ok' | 'info' | 'warn' | 'err' | 'muted' | 'text' }>;
  export function activityOf(status: GiveawayStatus, busy: 'draw' | 'redraw' | null): string;   // Festlegung 7
  export type Action = 'open' | 'pause' | 'resume' | 'close' | 'reopen' | 'draw' | 'redraw' | 'complete' | 'cancel' | 'boost' | 'stopBoost' | 'correct' | 'settings' | `kernel:${string}`;
  export function actionsOf(d: Pick<GiveawayDetail, 'status' | 'boost' | 'kernel' | 'winners'>): { primary: Action | null; others: Action[]; hints: Partial<Record<Action, string>> };
  ```
  Genau eine Hauptaktion je Zustand: Entwurf → `open`, Offen → `pause`, Pausiert → `resume`, Geschlossen → `draw`, Gezogen → `complete` nur, wenn jeder Gewinner `done` oder `forfeited` ist, sonst `null` mit Hinweis (Spec 7.1); `others` je `TRANSITIONS` (Spec 7.1: Geschlossen → `reopen`, überall vor Abgeschlossen → `cancel`), `boost`/`stopBoost` nur mit Dienst `boost` und Offen/Pausiert, `correct` nur mit Dienst `watchtime`, `settings` in Entwurf/Offen/Pausiert, `kernel:<type>` für `commands` mit `issuer: 'streamer'` nur in Offen. `hints`: „Ziehen geht erst nach dem Schließen.“ auf `draw` in Offen/Pausiert.
- Produces (`history-text.ts`): `historyText(e: HistoryEntry, names: Record<string, string>, mask: boolean): string` für `giveaway_created`, `giveaway_status_changed` (`to`), `giveaway_settings_changed`, `giveaway_legal_frozen`, `participant_registered`, `participant_withdrawn`, `watch_credited` (Summe Sekunden, Zahl der Personen), `chat_credited`, `watch_corrected` (Person, ±Zeit), `boost_started`, `boost_ended`, `giveaway_drawn` (Gewinner), `winner_status_set`, `event_voided`, `unregistered_purged`, `instant_window_opened|closed`, `tickets_bought|refunded`; sonst `${type}` + Schlüssel. Namen über `names[pid] ?? S.deletedParticipant(pid)` und `maskName` im Streamermodus.
- Produces (`/giveaways/[id]`): `load` lädt Detail, Teilnehmer, erste Verlaufsseite (`limit=20`) parallel, `depends('api:stream:giveaway:<id>')`; Live-Abo auf `giveaway:<id>`. Aufbau wie das Artboard: Kopfzeile (Kern-Label, Kanäle, Gewinn als `h1`, Sponsor, offen seit, Keyword), `StateBadge`; `StatusBlock` (Tätigkeit, Topf „n berechtigt · m nicht berechtigt“, Gewicht mit `display.unit`, letzte Berechnung relativ, je Kanal `ChannelStatus` kompakt); Warnstreifen je Kanalwarnung mit Knopf „Kanal neu verbinden“ (nur für den eigenen Kanal), Boost-Zeile, wenn aktiv (Faktor, Ende); `ActionBar` aus `actionsOf` (Hauptaktion Kupfer, `cancel` und `redraw` und `revert` mit `Confirm` samt Grund wo der Server ihn verlangt, Ablehnungstext inline unter der Leiste, Review Focus 3); `DrawPanel` (vor der Ziehung Vorschau aus den Teilnehmern, Festlegung 8; nach der Ziehung Nachweis aus dem `giveaway_drawn`-Eintrag des Verlaufs: Gewinner mit `WinnerStatusSelect` (`PUT …/winners/:pid`), Bedingungen je Person mit Gründen, Ausschlüsse, „Ersatzziehung“ je Gewinner mit Grund); `Participants` (Suche nach Name, Spalten: Teilnehmer (`Name`), Status (im Topf · angemeldet · gesehen · Gewinner mit Wort + Icon), Gewicht mit Einheit, Chance, Kern-Zeilen aus `lines` als Spalten nach `display.columns`), Hinweistext `S.chanceHint`; `History` (Eintrag: Zeit · Akteur, Satz aus `historyText`, „Rückgängig“ für `compensate|void` ohne `reverted`, Grund für `none`, aufgehobene durchgestrichen mit „aufgehoben“), Link „Ganzen Verlauf ansehen“ → `/giveaways/[id]/history` (seitenweise mit „Ältere laden“ über `nextBeforeSeq`); `BoostForm` (Faktor 2–10, Dauer in Minuten), `CorrectionForm` (Kanal, Teilnehmer aus der Liste, ±Minuten, Grund), `SettingsPanel`.
- Produces: Rückgängig sendet `POST …/revert { eventId, reason }`.

- [ ] **Step 1: Tests schreiben**

```ts
// status.test.ts
it('actionsOf yields exactly one primary action per status and complete only when all winners are done or forfeited', ...);
it('boost actions only with service boost in open/paused; kernel streamer commands only when open', ...);
it('activityOf names the drawing activity while busy', ...);
// history-text.test.ts
it('renders German sentences for registered, withdrawn, status change, corrected, drawn, voided; masks names in streamer mode', ...);   // Review Focus 1
it('falls back to type and payload keys for unknown types', ...);
// Participants.test.ts
it('filters by name, shows weight with unit and chance as percent, masks names in streamer mode', ...);   // Review Focus 1
// History.test.ts
it('shows Rückgängig for compensate/void entries, the why for none, strikes through reverted entries', ...);
// ActionBar.test.ts
it('renders the rejection message inline after a failed command and keeps buttons enabled', ...);   // Review Focus 3
it('cancel asks for confirmation inline, never via window.confirm', ...);
```

- [ ] **Step 2: Tests laufen lassen, sie scheitern**
- [ ] **Step 3: Implementieren**
- [ ] **Step 4: Prüfen**
- [ ] **Step 5: Commit** `feat(web): Giveaway-Detail mit Statusblock, Aktionen, Teilnehmern, Verlauf und Ziehung`

---

### Task 5: Start-Assistent und Einstellungsformulare

**Files:**
- Create: `src/routes/giveaways/new/+page.ts`, `+page.svelte`, `src/lib/wizard.ts`, `src/lib/components/{ConfigForm,GatesForm,ChannelsForm,Summary}.svelte`
- Modify: `src/lib/components/SettingsPanel.svelte` (Kern-Konfiguration und Bedingungen einbinden)
- Test: `src/lib/wizard.test.ts`, `src/lib/components/ConfigForm.test.ts`, `src/lib/components/GatesForm.test.ts`

**Interfaces:**
- Consumes: `KernelInfo` (`/api/kernels`), `TeamList` (`/api/me/teams`), `TeamDetail` je Team (Mitglieder = Kanäle), `Me.legal`.
- Produces (`wizard.ts`):
  ```ts
  export interface WizardDraft { kernelId: string | null; teamId: string | null; prize: string; sponsor: string; winnersCount: number; claimDays: number; contact: string; config: Record<string, unknown>; counting: 'registered' | 'first_seen'; purgeDays: number; keyword: string; chatBonus: { enabled: boolean; sec: number; minWords: number; cooldownSec: number }; channels: string[]; gates: GateConfig[]; legal: 'profile' | LegalTexts; }
  export function emptyDraft(): WizardDraft;
  export function withKernel(d: WizardDraft, k: KernelInfo): WizardDraft;   // config = Defaults aus configSchema
  export function validateStep(step: 1 | 2 | 3 | 4 | 5, d: WizardDraft, k: KernelInfo | null, channels: string[]): Record<string, string>;   // Feld → Fehlertext aus S
  export function toSettings(d: WizardDraft): CreateSettings;   // sponsor/keyword/contact leer → null, legal 'profile' → null
  export function stepOfRejection(code: string): 2 | 4 | 5 | 6;   // Festlegung 9
  ```
  Regeln (Review Focus 5): Schritt 2: Gewinn Pflicht, `winnersCount` ≥ 1, `claimDays` 1–365, Konfig-Felder im Bereich `min..max`, Keyword passt auf `^\S{2,32}$` oder leer, Kontaktweg ≤ 200; Schritt 3: mindestens ein Kanal, Kanäle ⊆ Team; Schritt 4: `follow.mode === 'channel'` braucht `channel ∈ channels`, `follow.min` 1..channels.length, `presence.minChannels` 1..channels.length, `days` 1–3650, nur `supportedGates` des Kerns; Schritt 5: `legal === 'profile'` nur, wenn `Me.legal` alle drei Angaben hat, sonst eigene Texte mit allen drei Angaben.
- Produces (`ConfigForm { schema: Record<string, ConfigField>; value; onchange; errors }`): je Feld `Field` mit `label`, `help`; `int` als Zahlenfeld mit `min`/`max` und Einheit (`sec` → Minuten-Eingabe mit Umrechnung, `coins` → „Coins“), `bool` als Schalter, `text` mit `maxLength`.
- Produces (`GatesForm { supported: GateId[]; channels: { pid; displayName }[]; value: GateConfig[]; onchange; errors }`): Gruppen wie das Artboard (Follow mit drei Modi, Mindestalter Konto, Mindestalter Follow, Anwesenheit), nur `supported` sichtbar.
- Produces (`ChannelsForm`): Team wählen (Solo zuerst), Mitglieder als Kanäle mit `ChannelStatus` kompakt, Haken.
- Produces (`/giveaways/new`): Schritte in der linken Leiste mit Haken für erledigte, `aria-current="step"`; Hauptbereich je Schritt; rechte `Summary` (Festlegung 9); Schritt 6 zeigt alle Werte, Rechtstext-Checkliste, Knöpfe „Als Entwurf speichern“ und „Prüfen und öffnen“ (Kupfer); Erfolg → `goto('/giveaways/<id>')`; Ablehnung → `stepOfRejection`, Text am Schritt.

- [ ] **Step 1: Tests schreiben**

```ts
// wizard.test.ts
it('withKernel fills config defaults from configSchema', ...);
it('validateStep 4 rejects follow channel outside the giveaway, min above channel count and presence above channel count', ...);   // Review Focus 5
it('validateStep 5 accepts profile legal only when all three texts exist', ...);
it('toSettings turns empty strings into null and profile legal into null', ...);
it('stepOfRejection maps keyword_reserved→2, invalid_gate→4, legal_missing→5, others→6', ...);
// ConfigForm.test.ts
it('renders an int field with label, help, min/max and a bool switch from the schema', ...);
// GatesForm.test.ts
it('shows only supported gates and emits a follow gate with mode channel when a channel is chosen', ...);
```

- [ ] **Step 2: Tests laufen lassen, sie scheitern**
- [ ] **Step 3: Implementieren**
- [ ] **Step 4: Prüfen**
- [ ] **Step 5: Commit** `feat(web): Start-Assistent mit Kern-Konfiguration, Kanälen, Bedingungen und Rechtstexten`

---

### Task 6: Teilnehmer-Portal und öffentliche Giveaway-Seite

**Files:**
- Create: `src/routes/portal/+page.*`, `src/routes/portal/giveaways/[id]/+page.*`, `src/routes/portal/data/+page.*`, `src/routes/g/[id]/+page.*`, `src/lib/components/{PortalCard,GateList,ViewerLines,LegalLinks,TicketForm}.svelte`
- Test: `src/lib/components/PortalCard.test.ts`, `src/lib/components/GateList.test.ts`, `src/routes/portal/data/page.test.ts`

**Interfaces:**
- Consumes: `/api/portal/giveaways`, `/api/portal/giveaways/:id`, `…/gates`, `…/register|withdraw|kernel-commands`, `/api/public/giveaways/:id`, `/api/me/data`, `DELETE /api/me`.
- Produces (`/portal`): Liste „Laufend“ (`draft` erscheint nie, `open|paused|closed`) als `PortalCard` (Kern-Label, Status Wort + Icon, Gewinn, „Du bist im Topf.“ / „Du bist angemeldet.“ / „Du bist noch nicht angemeldet.“, Chance groß als `percent`, Knopf Rückzug oder Teilnehmen), „Vergangen“ (`drawn|completed|cancelled`: gewonnen / nicht gewonnen / abgebrochen), Karte „Meine Daten“ mit Links. Live-Abo auf alle Karten.
- Produces (`/portal/giveaways/[id]`): Detail wie das Artboard: Status, `ViewerLines` (Kern-Zeilen `view.lines`), Chance mit `S.chanceHint`, `GateList` (Bedingungen aus `gates` in Worten: „Follow bei allen n Kanälen“, „Konto älter als x Tage“ …, Status aus `lastGateResult` oder nach Klick „Bedingungen jetzt prüfen“ (`GET …/gates`, 502 → Hinweis „Twitch antwortet nicht. Versuche es später.“), Gründe in Worten: `follow:<pid>` → „Follow bei <Kanal> fehlt“, `follow_min`, `account_age`, `follow_age`, `presence`, `banned`, `not_registered`), Teilnehmen (Kupfer) / Rückzug, `TicketForm` für `commands` mit `issuer: 'participant'` (Anzahl, Hinweis auf Chat-Wort `!ticket <n>`), `LegalLinks` (Impressum, Teilnahmebedingungen als Link oder aufklappbarer Text, Datenschutz, Fassung aus `legalEventId`), Gewinn-Panel mit `claimDeadline` und `contact`.
- Produces (`/g/[id]`): öffentliche Seite ohne Sitzung: Gewinn, Sponsor, Kern, Status, Kanäle, Keyword, Rechtstexte, Meldefrist, Knopf „Mit Twitch anmelden und teilnehmen“ (`return=/portal/giveaways/<id>`), mit Sitzung Weiterleitung auf `/portal/giveaways/<id>`.
- Produces (`/portal/data`): „Alle meine Daten ansehen“ lädt `/api/me/data` und zeigt es als formatiertes JSON, „Als Datei herunterladen“ (Link auf `/api/me/data`, `download`), „Alles löschen“ mit `Confirm` (Text aus Spec 12.4: Zuordnung entfernt, Gewinne bleiben nachweisbar ohne Namen), danach `goto('/')`.

- [ ] **Step 1: Tests schreiben**

```ts
// PortalCard.test.ts
it('shows pool membership sentence, chance percent and the right button per registration state', ...);
it('shows the rejection text inline when register fails with not_open', ...);   // Review Focus 3
// GateList.test.ts
it('describes gates in German and maps reasons like follow:<pid> to channel names', ...);
// portal/data/page.test.ts
it('deleting asks for inline confirmation and calls DELETE /api/me only after confirm', ...);
```

- [ ] **Step 2: Tests laufen lassen, sie scheitern**
- [ ] **Step 3: Implementieren**
- [ ] **Step 4: Prüfen**
- [ ] **Step 5: Commit** `feat(web): Teilnehmer-Portal, Meine Daten und öffentliche Giveaway-Seite`

---

### Task 7: E2E mit Playwright, CI, Doku

**Files:**
- Create: `packages/web/playwright.config.ts`, `packages/web/e2e/stack.ts`, `packages/web/e2e/giveaway.spec.ts`
- Modify: `.github/workflows/ci.yml`, `package.json` (Wurzel: `"test:e2e": "npm run test:e2e -w packages/web"`), `.env.example`, `README.md`, `CLAUDE.md`

**Interfaces:**
- Produces (`e2e/stack.ts`, Start mit `tsx e2e/stack.ts`): startet `PostgreSqlContainer`, `runMigrations`, `ensurePartitions`, `createRuntime({ pool, publisher: bus, auth: accountAuthorizer(), legalSource: accountLegalSource(), teamAuth: accountTeamAuthorizer(), teamDirectory: pgTeamDirectory(), bans: pgBanDirectory(), log })`, `attachAccounts(rt, { tokenKey })`, `buildApp({ pool, api: { rt, accounts, auth: accountAuthorizer(), subscriber: bus, twitch: stub, publicUrl: 'http://localhost:3101', secureCookies: false } })` auf Port 3100; Twitch-Stub: `authorizeUrl(p) = \`${p.redirectUri}?code=${current.login}&state=${p.state}\``, `exchangeCode` liefert Tokens mit `REQUIRED_CHANNEL_SCOPES`, `getUser` liefert `current`; Steuerroute `POST /__e2e/user { login, displayName, id }` setzt `current`. Gibt `ready` auf stdout aus.
- Produces (`playwright.config.ts`): `webServer: [{ command: 'npx tsx e2e/stack.ts', port: 3100, timeout: 180_000 }, { command: 'API_URL=http://localhost:3100 npm run dev -- --port 3101', port: 3101 }]` (Windows: `cross-env` oder `env` über `webServer.env`), `use.baseURL = 'http://localhost:3101'`, Chromium, ein Worker.
- Produces (`giveaway.spec.ts`): ein Test: Alice meldet sich an (Startseite → Anmelden → Weiterleitung), nimmt Nutzungsbedingungen an, verbindet den Kanal, hinterlegt Rechtstexte, startet den Assistenten (Kern Sofortverlosung, Gewinn „E2E-Preis“, Keyword `!e2e`), öffnet; zweiter Browser-Kontext Bob: `/g/<id>` → anmelden → teilnehmen; Alice: pausieren → Zustand „Pausiert“, fortsetzen, schließen, ziehen → Nachweis zeigt Bob als Gewinner, Rückgängig der Pause im Verlauf ist mit „aufgehoben“ markiert (Rückgängig auf `giveaway_status_changed` zu `paused`… Hinweis: `compensate` der Pause = Fortsetzen; der Test nimmt stattdessen „Rückgängig“ auf `winner_status_set` nach dem Setzen von „gemeldet“), Bob: Portal zeigt „gewonnen“ mit Meldefrist, `/portal/data` → Alles löschen → Startseite; Alice: Teilnehmerliste zeigt „gelöschter Teilnehmer“.
- Produces (`ci.yml`): nach `npm test`: `npx playwright install --with-deps chromium` und `npm run test:e2e`.
- Produces (Doku): README „Entwickeln“ (Web-App starten: `npm run dev -w packages/web`, Port 3001, Vite-Proxy, `API_URL`; Twitch-Redirect-URL `PUBLIC_URL/api/auth/twitch/callback`), „Prozesse“ (alle Pfade unter `/api`, neuer Prozess **web** mit `start`, `PORT`, `ORIGIN`), neue Begriffe (Streamermodus, Live-Push-Client, Start-Assistent, Seiten), Stand „1–7, 8a und 8b fertig, als Nächstes 8c“. CLAUDE.md: Paket `packages/web`, Befehle (`typecheck` über `svelte-check`, `lint:text` mit Dateimodi, `test:e2e`), Regeln für `web` (nur `api`, Texte in `labels.ts`/`sentences.ts`, keine Browser-Dialoge, ein Kupfer-Element, Streamermodus), API-Präfix.

- [ ] **Step 1: Stack und Konfiguration schreiben, `npx playwright test` zeigt den Test als fehlend/rot**
- [ ] **Step 2: Spec schreiben, laufen lassen, Fehler der Oberfläche beheben, bis grün**
- [ ] **Step 3: CI, `.env.example`, README, CLAUDE.md nachziehen**
- [ ] **Step 4: Prüfen** (`npm run typecheck`, `npm run lint`, `npm test`, `npm run test:e2e`, `npm run build`)
- [ ] **Step 5: Commit** `test(web): Playwright-E2E über Anmeldung, Assistent, Ziehung, Rückgängig und Löschung` und `docs: Web-App, API-Präfix, Stand Teilprojekt 8b`

---

## Selbstprüfung gegen die Spec

- 11.1 Übersicht (Task 3), Detail mit Statusblock, Warnstreifen, Aktionsleiste, Teilnehmer mit Chance, Verlauf mit Rückgängig (Task 4), Start-Assistent sechs Schritte (Task 5, Live-Vorschau zurückgestellt per Festlegung 9), Team, Kanäle, Rechtstexte (Task 3), Chat-Ansagen (eigener Plan), Streamermodus (Task 2, 4), keine Browser-Dialoge (ESLint, Confirm).
- 11.2 Statusblock: Zustand Wort + Icon, Tätigkeit (abgeleitet, Festlegung 7), Topf, je Kanal live/offline, letztes Signal, Zuschauer, Abdeckung; Warnungen gelb/rot/Hinweis aus `warning` (Task 3, 4). Boost-Sperre: der Server lehnt `start_boost` ohne aktiven Kanal ab, der Text steht am Knopf (Task 4).
- 11.3 Portal: Liste laufend/vergangen, Status, Bedingungen mit Grund, eigene Zeit/Coins/Tickets je Kanal (`view.lines`), Chance live (Push), Teilnehmen, Rückzug, Tickets, Rechtstexte, Gewinn mit Frist und Kontaktweg, Meine Daten ansehen/herunterladen/löschen (Task 6).
- 11.5 Design: Tokens, Dark Standard, Light über Media Query und `data-theme`, ein Kupfer-Element, Patina für Struktur, Wort + Icon, Schriften und Gewichte, keine Schatten, Kontrast (Task 2).
- 11.6 Texte: alle in zwei Modulen, Linter in CI (Task 1, 2).
- 12.1 „verbindet neu“ (Task 2), Ablehnung in Klartext (Task 4, 6), Helix-Fehler bei der Ziehung als Text ohne Ereignis (Task 4).
- 12.2 E2E Playwright: Starten, Pausieren, Ziehen, Rückgängig, Löschen (Task 7).
- 9.2 Onboarding erzwungen (Task 3 `requireStreamer`), 9.3 Solo ohne das Wort Team (Task 3), 9.4 Checkliste ohne Mustertexte (Task 3, 5).
- 3.4 `web` nutzt nur `api` (eigene Typen, keine Importe aus `server`).
