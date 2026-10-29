# Teilprojekt 3: Konten + Identität – Umsetzungsplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Streamer und Zuschauer melden sich per Twitch an, bekommen genau eine `pid`, akzeptieren Nutzungsbedingungen, verbinden ihren Kanal, hinterlegen Rechtstexte, sehen und löschen ihre Daten. Ein Giveaway öffnet nur mit vollständigen, eingefrorenen Rechtstexten.

**Architecture:** Neuer Strom `account:<pid>` mit eigenem Reducer, Befehlen und Lesetabelle `accounts`. Twitch-Daten liegen nur in `identities`, Tokens AES-256-GCM-verschlüsselt in `channel_tokens`. Beides schreibt der Rahmen in `prepare` beziehungsweise in Projektoren innerhalb der Befehls-Transaktion, es gibt keinen zweiten Schreibweg. HTTP-Routen unter `/auth/*` und `/me/*` in einem neuen Modul `src/api`. Der Giveaway-Rahmen bekommt einen `GiveawayAuthorizer` auf Basis von `accounts` und einen Öffnen-Befehl, der Rechtstexte prüft und einfriert.

**Tech Stack:** TypeScript, Fastify 5 (ohne Zusatz-Plugins, Cookies von Hand), pg, zod, `node:crypto`, globales `fetch`. Tests mit Vitest und Testcontainers.

**Spec:** `NEW_DESIGN.md` Abschnitte 3.3, 3.4, 5.1, 5.5, 6.4, 9.1, 9.2, 9.4, 10.2, 11.3, 12.4, 14 (Punkt 3).

## Global Constraints

- Jede Zustandsänderung läuft durch `CommandBus.execute`. Auch `identities`, `channel_tokens` und Löschungen (CLAUDE.md).
- Payloads enthalten nur `pid`, nie Twitch-Name oder Twitch-ID. `assertNoTwitchIdentity` verbietet die Schlüssel `twitch_id`, `twitchId`, `login`, `user_name`, `display_name`, `displayName` (`journal/guard.ts`).
- Neue Tabellen nur über `packages/server/migrations/004_identity.sql`.
- UI- und Fehlertexte deutsch, kurz, aktiv, höchstens 20 Wörter (Spec 11.6). Fehlertext = was passiert ist + was zu tun ist.
- Scopes für „Kanal verbinden“: `moderator:read:followers`, `moderator:read:chatters`, `channel:bot` (Spec 9.2).
- Tokens AES-256-GCM, Master-Schlüssel außerhalb der Datenbank in einer Secret-Datei (Spec 10.2).
- `identities (pid, twitch_id, login, display_name, created_at)` ist die einzige Stelle mit Twitch-Daten (Spec 9.1). Löschen = Zeile entfernen, das Journal zeigt danach „gelöschter Teilnehmer #<kurz-id>“ (Spec 12.4).
- Inaktives Konto: 12 Monate → Zuordnung entfernt (Spec 12.4). Hinweis: `last_seen_at` in `identities` ist mein Zusatz, damit die Frist messbar ist. Ingest (TP4) und Anmeldung (TP5) setzen es später ebenfalls.
- Ohne Impressum, Teilnahmebedingungen und Datenschutzhinweis öffnet kein Giveaway. Beim Öffnen friert der Rahmen ein: Text als Kopie, URL mit SHA-256 des Inhalts (Spec 9.4).
- Tests nur gegen Testcontainers. Nie `appendLocked` direkt außer in `journal.test.ts`/`projections.test.ts`.
- Vor dem Typecheck ganze Aufgaben fertig schreiben, dann `npm run typecheck`, `npm run lint`, `npm test` einmal je Aufgabe.

## Entscheidungen, die die Spec offen lässt (meine Festlegungen)

1. **Solo-Team-ID** entsteht beim ersten Anmelden als UUID im Ereignis `account_created {soloTeamId}`. Teilprojekt 7 legt dazu später den Strom `team:<soloTeamId>` an.
2. **Sitzungen** liegen in PG (`sessions`), nicht in Redis, damit ein Redis-Ausfall niemanden abmeldet. Sitzungen und `access_log` sind Betriebsdaten, keine Zustandsänderung im Sinn von 3.3 (dieselbe Einordnung wie `access_log`).
3. **Nutzungsbedingungen** der Plattform sind versioniert als Konstante `PLATFORM_TERMS_VERSION = 1` im Code. Text liefert der Betreiber in TP8 (UI). Streamer-Befehle verlangen die aktuelle Version.
4. **Rechtstexte** gibt es im Profil (`profile_updated`) und je Giveaway (`settings.legal`). Beim Öffnen gilt je Feld: Giveaway-Wert, sonst Profil-Wert des handelnden Streamers. Eingefroren wird nur beim Übergang Entwurf → Offen. Wieder öffnen und Fortsetzen frieren nicht neu ein.
5. **`settings.legal`** ist im Schema optional (`nullable().optional()`), alte Ereignisse bleiben gültig ohne Upcaster. Der Reducer normalisiert fehlendes `legal` zu `null`.
6. **Fehler im OAuth-Callback** antworten mit JSON `400 {code, message}`. TP8 leitet dann auf eine Fehlerseite um.
7. **Kanal trennen** löscht die Tokens. Die Umkehrung von `channel_disconnected` ist darum `none`.
8. **Zwei OAuth-Flüsse**: `login` ohne Scopes (Zuschauer und Streamer gleich), `connect` mit den drei Kanal-Scopes. `connect` verlangt, dass das Twitch-Konto zur Sitzung passt.

## Review Focus

1. Zwei gleichzeitige erste Anmeldungen desselben Twitch-Kontos dürfen nur eine `pid` erzeugen. Test in Aufgabe 2 (`sign_in` mit fremder Kandidaten-pid lehnt `pid_mismatch` ab, Route wiederholt mit der gefundenen pid, Aufgabe 4).
2. Ein abgelaufenes oder fremdes Sitzungs-Cookie darf nie einen Nutzer ergeben. Test in Aufgabe 4 (`GET /me` mit abgelaufener Sitzung → 401).
3. Ein `state`-Parameter, der nicht zum Cookie passt, darf keinen Code eintauschen. Test in Aufgabe 4.
4. Nach `DELETE /me` darf kein Twitch-Datum zur `pid` mehr lesbar sein: `identities`, `sessions`, `channel_tokens` leer, Journal bleibt. Test in Aufgabe 2 und 4.
5. Ein Giveaway, dessen Rechtstext-URL beim Öffnen nicht erreichbar ist, bleibt im Entwurf und nennt die URL. Test in Aufgabe 6.

---

## Dateistruktur

```
packages/server/migrations/004_identity.sql          identities, sessions, channel_tokens, accounts
packages/server/src/config/config.ts                 + TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET, PUBLIC_URL, TOKEN_KEY_FILE
packages/server/src/identity/crypto.ts               AES-256-GCM, Schlüsseldatei
packages/server/src/identity/identities.ts           identities-Tabelle, displayNameOf
packages/server/src/identity/sessions.ts             sessions-Tabelle
packages/server/src/identity/tokens.ts               channel_tokens-Tabelle
packages/server/src/identity/terms.ts                PLATFORM_TERMS_VERSION
packages/server/src/identity/twitch.ts               OAuth-Client (authorizeUrl, exchangeCode, refresh, getUser)
packages/server/src/identity/account/state.ts        AccountState, Reducer, Ereignisnamen
packages/server/src/identity/account/events.ts       Ereignistypen mit Umkehrarten
packages/server/src/identity/account/commands.ts     signIn, acceptTerms, updateProfile, connectChannel, disconnectChannel, deleteAccount
packages/server/src/identity/account/projectors.ts   accounts (State), identity_cleanup (Event)
packages/server/src/identity/account/authorizer.ts   GiveawayAuthorizer auf Basis von accounts
packages/server/src/identity/account/legal-source.ts LegalSource: Profil-Rechtstexte des Akteurs
packages/server/src/identity/runtime.ts              attachAccounts(rt, {tokenKey}) → AccountHandlers
packages/server/src/identity/inactivity.ts           purgeInactiveAccounts
packages/server/src/framework/authorize.ts           UUID_RE, authorizeSelf (aus giveaway/authorize.ts gezogen)
packages/server/src/framework/legal.ts               LegalTexts, FrozenLegal, checkLegal, mergeLegal, LegalFetcher, fetchHash
packages/server/src/framework/giveaway/open.ts       openGiveawayHandler mit Einfrieren
packages/server/src/api/cookies.ts                   parseCookies, serializeCookie
packages/server/src/api/session.ts                   sessionOf(req), requireSession
packages/server/src/api/auth.ts                      /auth/twitch/login, /auth/twitch/connect, /auth/twitch/callback, /auth/logout
packages/server/src/api/me.ts                        /me, /me/terms, /me/profile, /me/channel, /me/data, DELETE /me
packages/server/src/api/http.ts                      rejectionToHttp
packages/server/src/app/build-app.ts                 Routen registrieren, wenn deps.api gesetzt
packages/server/src/app/main.ts, src/scheduler/main.ts  Verdrahtung
packages/server/src/scheduler/maintenance.ts         + Sitzungen, inaktive Konten
```

---

### Task 1: Migration, Konfiguration, Verschlüsselung, Tabellenzugriffe

**Files:**
- Create: `packages/server/migrations/004_identity.sql`
- Create: `packages/server/src/identity/crypto.ts`, `src/identity/identities.ts`, `src/identity/sessions.ts`, `src/identity/tokens.ts`, `src/identity/terms.ts`
- Modify: `packages/server/src/config/config.ts`, `test/config.test.ts`, `.env.example`
- Test: `packages/server/test/crypto.test.ts`, `test/identity-store.test.ts`

**Interfaces:**
- Produces:
  - `encrypt(plain: string, key: Buffer): Buffer` (12 Byte IV | 16 Byte Tag | Chiffrat), `decrypt(blob: Buffer, key: Buffer): string`, `loadTokenKey(path: string): Promise<Buffer>` (Datei mit 64 Hex-Zeichen, sonst `Error` „Die Schlüsseldatei <pfad> muss 64 Hex-Zeichen enthalten. Erzeuge sie mit: openssl rand -hex 32“).
  - `interface TwitchUser { id: string; login: string; displayName: string }` (in `identities.ts`, `twitch.ts` importiert von hier).
  - `interface Identity { pid: string; twitchId: string; login: string; displayName: string; createdAt: Date; lastSeenAt: Date }`
  - `upsertIdentity(c: pg.PoolClient, user: TwitchUser, candidatePid: string, now: Date): Promise<string>` – legt an oder aktualisiert `login`, `display_name`, `last_seen_at`; liefert die wirksame `pid` (bei vorhandener `twitch_id` die alte).
  - `findIdentity(db: Queryable, pid: string): Promise<Identity | null>`, `findPidByTwitchId(db, twitchId: string): Promise<string | null>`, `deleteIdentity(c, pid): Promise<void>`
  - `displayNameOf(identity: Identity | null, pid: string): string` → `identity.displayName` oder `gelöschter Teilnehmer #${pid.slice(0, 8)}`
  - `SESSION_TTL_DAYS = 30`, `SESSION_COOKIE = 'ccg_session'`, `createSession(db, pid, now): Promise<string>` (32 Zufallsbytes base64url), `findSession(db, id, now): Promise<{ pid: string } | null>` (nur nicht abgelaufene), `deleteSession(db, id)`, `deleteSessionsOf(db, pid)`, `purgeExpiredSessions(db, now): Promise<number>`
  - `interface StoredToken { accessToken: string; refreshToken: string; scopes: string[]; expiresAt: Date; status: 'ok' | 'invalid' }`, `saveChannelToken(c, pid, t: { accessToken; refreshToken; scopes; expiresAt }, key: Buffer, now: Date)`, `loadChannelToken(db, pid, key): Promise<StoredToken | null>`, `deleteChannelToken(c, pid)`, `markTokenInvalid(db, pid, now)`
  - `PLATFORM_TERMS_VERSION = 1`
  - `Config` + `twitchClientId`, `twitchClientSecret`, `publicUrl` (ohne Schrägstrich am Ende, `z.string().url()` und `.transform(s => s.replace(/\/+$/, ''))`), `tokenKeyFile`.

- [ ] **Step 1: Migration schreiben**

```sql
CREATE TABLE identities (
  pid          UUID PRIMARY KEY,
  twitch_id    TEXT NOT NULL UNIQUE,
  login        TEXT NOT NULL,
  display_name TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,
  pid        UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX sessions_pid ON sessions (pid);
CREATE INDEX sessions_expires ON sessions (expires_at);
CREATE TABLE channel_tokens (
  pid           UUID PRIMARY KEY,
  access_token  BYTEA NOT NULL,
  refresh_token BYTEA NOT NULL,
  scopes        TEXT[] NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('ok', 'invalid')),
  updated_at    TIMESTAMPTZ NOT NULL
);
CREATE TABLE accounts (
  pid               UUID PRIMARY KEY,
  solo_team_id      UUID NOT NULL UNIQUE,
  terms_version     INTEGER NOT NULL DEFAULT 0,
  channel_connected BOOLEAN NOT NULL DEFAULT false,
  legal             JSONB NOT NULL DEFAULT 'null',
  deleted           BOOLEAN NOT NULL DEFAULT false,
  last_seq          INTEGER NOT NULL,
  updated_at        TIMESTAMPTZ NOT NULL
);
```

- [ ] **Step 2: Tests schreiben** (`test/crypto.test.ts`, `test/identity-store.test.ts`, `test/config.test.ts` erweitern)

```ts
// crypto.test.ts
it('encrypt/decrypt round-trips and never repeats the IV', () => { const key = randomBytes(32); const a = encrypt('tok', key), b = encrypt('tok', key); expect(decrypt(a, key)).toBe('tok'); expect(a.equals(b)).toBe(false); expect(a.length).toBe(12 + 16 + 3); });
it('decrypt with the wrong key throws', ...);
it('loadTokenKey reads 64 hex chars and rejects anything else with a German hint', ...); // Datei im Scratch-Ordner (os.tmpdir)
// identity-store.test.ts (freshDb)
it('upsertIdentity creates with the candidate pid, then reuses the pid of the same twitch_id and updates login/last_seen_at', ...);
it('findSession ignores expired sessions, purgeExpiredSessions counts them', ...);
it('channel token round-trips encrypted, the table never holds the plaintext', ...); // SELECT access_token, prüfe Buffer enthält nicht 'secret'
it('displayNameOf falls back to „gelöschter Teilnehmer #<8 Zeichen>“', ...);
// config.test.ts: `valid` um TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET, PUBLIC_URL, TOKEN_KEY_FILE ergänzen; „lists every problem at once“ erwartet jetzt 8 Probleme; PUBLIC_URL 'https://x.de/' wird zu 'https://x.de'.
```

- [ ] **Step 3: Tests laufen lassen, sie scheitern** (`npx vitest run test/crypto.test.ts test/identity-store.test.ts test/config.test.ts`)

- [ ] **Step 4: Implementieren** (Signaturen oben; `encrypt` nutzt `createCipheriv('aes-256-gcm', key, iv)`; `createSession` nutzt `randomBytes(32).toString('base64url')`; `.env.example` ergänzen: `TWITCH_CLIENT_ID=`, `TWITCH_CLIENT_SECRET=`, `PUBLIC_URL=http://localhost:3000`, `TOKEN_KEY_FILE=./secrets/token.key`)

- [ ] **Step 5: Tests laufen lassen, sie bestehen**

- [ ] **Step 6: Commit** `feat(identity): Tabellen, Konfiguration, Token-Verschlüsselung`

---

### Task 2: Strom `account:<pid>` – Zustand, Ereignisse, Befehle, Lesetabelle

**Files:**
- Create: `src/identity/account/state.ts`, `events.ts`, `commands.ts`, `projectors.ts`, `src/identity/runtime.ts`
- Create: `src/framework/authorize.ts` (verschiebt `UUID_RE`, `INVALID_ID`, `authorizeSelf` aus `giveaway/authorize.ts`; dort per `export { … } from '../authorize.js'` weiter exportiert)
- Create: `src/framework/legal.ts` (nur Typen + `checkLegal`; Rest in Task 6)
- Test: `test/account.test.ts`

**Interfaces:**
- Consumes: Task 1; `CommandHandler`, `StreamReducer`, `CommandBus` aus `framework/command-bus.ts`; `makeRevertHandler` aus `framework/revert.ts`; `Runtime` aus `framework/runtime.ts`.
- Produces:
  - `framework/legal.ts`: `interface LegalTexts { impressumUrl: string | null; terms: { text: string } | { url: string } | null; privacyUrl: string | null }`, `EMPTY_LEGAL: LegalTexts`, `legalSchema` (zod), `checkLegal(x: unknown): LegalTexts | Rejection` (URLs `http`/`https`, höchstens 500 Zeichen; Text höchstens 20000 Zeichen; Codes `invalid_url` „Ein Link ist ungültig. Gib eine vollständige Adresse mit https:// an.“, `terms_too_long` „Die Teilnahmebedingungen dürfen höchstens 20000 Zeichen haben.“, `invalid_legal` „Die Rechtstexte sind ungültig.“), `missingLegal(l: LegalTexts): string[]` → Namen `Impressum`, `Teilnahmebedingungen`, `Datenschutzhinweis` der leeren Felder.
  - `accountStream(pid): StreamId` = `account:${pid}`
  - `interface AccountState { exists: boolean; soloTeamId: string; termsVersion: number; channelConnected: boolean; channelScopes: string[]; legal: LegalTexts; deleted: boolean }`
  - `ACCOUNT_EVENTS = { created: 'account_created', termsAccepted: 'terms_accepted', termsWithdrawn: 'terms_withdrawn', profileUpdated: 'profile_updated', channelConnected: 'channel_connected', channelDisconnected: 'channel_disconnected', deleted: 'account_deleted' }`
  - Payloads: `account_created {soloTeamId: uuid}` (`none`: „Ein Konto entsteht beim Anmelden. Lösche es unter Meine Daten.“); `terms_accepted {version: int, previous: int}` (`compensate` → `terms_withdrawn` gleiche Felder, nur wenn `state.termsVersion === version`, sonst `not_latest`); `terms_withdrawn` (`compensate` → `terms_accepted`); `profile_updated {before: LegalTexts, after: LegalTexts}` (`compensate` wie `giveaway_settings_changed`); `channel_connected {scopes: string[]}` (`compensate` → `channel_disconnected {scopes}` nur wenn `state.channelConnected`); `channel_disconnected {scopes}` (`none`: „Zum Verbinden brauchst du eine neue Anmeldung bei Twitch.“); `account_deleted {}` (`none`: „Eine Löschung lässt sich nicht rückgängig machen.“).
  - `accountReducer: StreamReducer<AccountState>` mit `name: 'account'`, `version: 1`.
  - Befehle (alle `streamOf = accountStream(cmd.pid)`):
    - `signInHandler(): CommandHandler<SignInCmd, AccountState, { pid: string }>` mit `SignInCmd { pid: string; soloTeamId: string; user: TwitchUser }`. `authorize`: nur `system:twitch` oder `user:<pid>` (Anmeldung ist ein Systemvorgang nach Twitch-Callback; Route nutzt `system:twitch`). `prepare`: `upsertIdentity(c, user, cmd.pid, ctx.now)` → `{pid}`. `decide`: `prepared.pid !== cmd.pid` → `reject('pid_mismatch', 'Dieses Twitch-Konto hat schon eine pid. Melde dich erneut an.')`; `state.deleted` → `reject('account_deleted', 'Dieses Konto ist gelöscht.')`; `state.exists` → `[]`; sonst `[account_created {soloTeamId}]`.
    - `acceptTermsHandler()`: `AcceptTermsCmd { pid; version: number }`. `authorize`: `authorizeSelf(cmd.pid, actor)`. `decide`: `!exists`/`deleted` → `reject('no_account', 'Melde dich zuerst an.')`; `version !== PLATFORM_TERMS_VERSION` → `reject('terms_version_stale', 'Die Nutzungsbedingungen haben sich geändert. Lade die Seite neu.')`; schon aktuell → `[]`; sonst `terms_accepted {version, previous: state.termsVersion}`.
    - `updateProfileHandler()`: `UpdateProfileCmd { pid; legal: Partial<LegalTexts> }`. Mischt mit `state.legal`, `checkLegal`, gleich → `[]`, sonst `profile_updated {before, after}`.
    - `connectChannelHandler(o: { tokenKey: Buffer })`: `ConnectChannelCmd { pid; twitchId: string; token: { accessToken; refreshToken; expiresIn: number; scopes: string[] } }`. `authorize`: `authorizeSelf`. `prepare`: `findIdentity` → `mismatch = !id || id.twitchId !== cmd.twitchId`; wenn nicht mismatch: `saveChannelToken(c, pid, {…, expiresAt: now + expiresIn s}, key, now)`; liefert `{mismatch}`. `decide`: `!exists`/`deleted` → `no_account`; `mismatch` → `reject('wrong_twitch_account', 'Dieses Twitch-Konto gehört nicht zu deiner Anmeldung. Melde dich mit dem Kanal-Konto an.')`; fehlende Scopes → `reject('scopes_missing', 'Twitch hat nicht alle Rechte erteilt. Verbinde den Kanal erneut und bestätige alle Rechte.')`; verbunden mit gleichen Scopes → `[]`; sonst `channel_connected {scopes: REQUIRED_CHANNEL_SCOPES-Reihenfolge, nur die drei}`.
    - `disconnectChannelHandler()`: `AccountCmd { pid }` → `!channelConnected` → `reject('not_connected', 'Es ist kein Kanal verbunden.')`; sonst `channel_disconnected {scopes}`.
    - `deleteAccountHandler()`: `AccountCmd { pid }`. `authorize`: `authorizeSelf` oder `system:scheduler`. `decide`: `!exists` → `no_account`; `deleted` → `reject('already_deleted', 'Dieses Konto ist schon gelöscht.')`; sonst `account_deleted {}`.
    - `accountRevertHandler(registry)`: `makeRevertHandler(accountReducer, registry, authorize)` mit `authorize`: Strom `account:<pid>` muss zum Akteur passen (`authorizeSelf`).
  - `accountsProjector(): StateProjector<AccountState>` (name `accounts`, reducer `account`): UPSERT aller Spalten; `reset` wie `giveawaysProjector`.
  - `identityCleanupProjector(): Projector` (name `identity_cleanup`, handles `account_deleted`, `channel_disconnected`): bei `account_deleted` `deleteIdentity`, `deleteSessionsOf`, `deleteChannelToken`; bei `channel_disconnected` `deleteChannelToken`.
  - `src/identity/runtime.ts`: `interface AccountHandlers { signIn; acceptTerms; updateProfile; connectChannel; disconnectChannel; deleteAccount; revert }`, `attachAccounts(rt: Runtime, o: { tokenKey: Buffer }): AccountHandlers` – registriert Ereignistypen in `rt.registry`, Projektoren in `rt.projections`, liefert Handler. Zweiter Aufruf wirft (Registry lehnt Doppelregistrierung ab).
  - `REQUIRED_CHANNEL_SCOPES` lebt in `src/identity/twitch.ts` (Task 3); Task 2 legt die Datei mit nur dieser Konstante an.

- [ ] **Step 1: Test `test/account.test.ts` schreiben** (Helfer `setupAccounts()` = `setupGiveaway()` + `attachAccounts(rt, { tokenKey: randomBytes(32) })`; `U = { id: '12345', login: 'alice', displayName: 'Alice' }`; `PID`, `SOLO` als feste UUIDs)

```ts
it('sign-in creates identity, account_created and the accounts row; second sign-in writes no event but updates last_seen_at', ...);
it('sign-in with a foreign candidate pid for a known twitch_id is rejected with pid_mismatch and writes nothing', ...);
it('payloads of the whole account stream contain neither login nor twitch id', ...); // JSON.stringify(events) enthält nicht 'alice', '12345'
it('accept terms: stale version rejected, current accepted once, second time no event; revert withdraws', ...);
it('update profile merges fields, rejects bad urls, no event on no change', ...);
it('connect channel stores encrypted token, requires all three scopes, rejects a foreign twitch account and rolls the token back', ...);
it('disconnect deletes the token, revert of channel_disconnected is not possible', ...);
it('delete removes identities, sessions and channel_tokens, keeps the journal, blocks every further command', ...);
it('only the user themself (or the allowed system actor) may run account commands', ...);
```

- [ ] **Step 2: Test laufen lassen, er scheitert** (`npx vitest run test/account.test.ts`)

- [ ] **Step 3: Implementieren** (Dateien und Signaturen oben; `authorize.ts`-Umzug mit Re-Export, bestehende Importe bleiben gültig)

- [ ] **Step 4: Tests laufen lassen, sie bestehen** (`npx vitest run test/account.test.ts test/lifecycle.test.ts test/registration.test.ts`)

- [ ] **Step 5: Commit** `feat(identity): Konto-Strom mit Anmeldung, Nutzungsbedingungen, Profil, Kanal, Löschung`

---

### Task 3: Twitch-OAuth-Client

**Files:**
- Modify: `src/identity/twitch.ts`
- Test: `test/twitch.test.ts`

**Interfaces:**
- Produces:
  - `REQUIRED_CHANNEL_SCOPES = ['moderator:read:followers', 'moderator:read:chatters', 'channel:bot'] as const`
  - `interface TokenSet { accessToken: string; refreshToken: string; expiresIn: number; scopes: string[] }`
  - `class TwitchError extends Error { constructor(readonly code: string, message: string) }` – Codes `twitch_unreachable` („Twitch antwortet nicht. Versuche es gleich noch einmal.“), `twitch_denied` („Twitch hat die Anmeldung abgelehnt. Starte die Anmeldung neu.“), `twitch_invalid` („Twitch hat unerwartet geantwortet. Versuche es gleich noch einmal.“).
  - `interface TwitchAuthClient { authorizeUrl(p: { redirectUri: string; scopes: readonly string[]; state: string }): string; exchangeCode(code: string, redirectUri: string): Promise<TokenSet>; refresh(refreshToken: string): Promise<TokenSet>; getUser(accessToken: string): Promise<TwitchUser> }`
  - `twitchAuthClient(o: { clientId: string; clientSecret: string; fetch?: typeof fetch; idBase?: string; helixBase?: string }): TwitchAuthClient` – Defaults `https://id.twitch.tv`, `https://api.twitch.tv/helix`. `authorizeUrl` → `${idBase}/oauth2/authorize?response_type=code&client_id=…&redirect_uri=…&scope=…(space, URL-codiert)&state=…&force_verify=true`. `exchangeCode` POST `${idBase}/oauth2/token` (form-urlencoded, `grant_type=authorization_code`), `refresh` dito mit `grant_type=refresh_token`; Antwortfelder `access_token`, `refresh_token`, `expires_in`, `scope` (Array). `getUser` GET `${helixBase}/users` mit `Authorization: Bearer`, `Client-Id`; nimmt `data[0]` → `{ id, login, displayName: display_name }`.
  - Statuscodes: Netzfehler → `twitch_unreachable`; 400/401/403 → `twitch_denied`; alles andere ungleich 200 oder fehlende Felder → `twitch_invalid`.

- [ ] **Step 1: Test schreiben** (Stub-`fetch`, der Aufrufe mitschreibt)

```ts
it('authorizeUrl carries client id, redirect, scopes, state and force_verify', ...);
it('exchangeCode posts the form body and maps the token set', ...);
it('getUser sends Bearer and Client-Id and maps display_name', ...);
it('maps 401 to twitch_denied, 500 to twitch_invalid, network error to twitch_unreachable', ...);
```

- [ ] **Step 2: Test laufen lassen, er scheitert**
- [ ] **Step 3: Implementieren**
- [ ] **Step 4: Test laufen lassen, er besteht**
- [ ] **Step 5: Commit** `feat(identity): Twitch-OAuth-Client`

---

### Task 4: HTTP-Routen `/auth/*` und `/me/*`, Verdrahtung in `app`

**Files:**
- Create: `src/api/cookies.ts`, `src/api/session.ts`, `src/api/http.ts`, `src/api/auth.ts`, `src/api/me.ts`
- Modify: `src/app/build-app.ts`, `src/app/main.ts`
- Test: `test/api-auth.test.ts`, `test/api-me.test.ts`

**Interfaces:**
- Consumes: Task 1–3, `Runtime`, `AccountHandlers`.
- Produces:
  - `parseCookies(header: string | undefined): Record<string, string>`, `serializeCookie(name, value, o: { maxAgeSec?: number; secure: boolean; path?: string }): string` (immer `HttpOnly; SameSite=Lax; Path=/`).
  - `interface ApiDeps { rt: Runtime; accounts: AccountHandlers; twitch: TwitchAuthClient; publicUrl: string; secureCookies: boolean; now?: () => Date }`
  - `sessionOf(req, pool, now): Promise<{ pid: string; sessionId: string } | null>`; `requireSession` als Fastify-preHandler, antwortet `401 { code: 'no_session', message: 'Melde dich an.' }`.
  - `rejectionToHttp(r: Rejection): { status: number; body: { code; message } }` – `no_session` 401; `not_you`, `no_accounts`, `not_your_team` 403; `*_not_found`, `no_account` 404; sonst 400.
  - `registerAuthRoutes(app, deps, pool)`:
    - `GET /auth/twitch/login?return=<pfad>` → Cookie `ccg_oauth` = `${state}.login.${base64url(return)}` (10 min), 302 auf `authorizeUrl` mit `scopes: []`, `redirectUri = ${publicUrl}/auth/twitch/callback`. `return` nur relative Pfade, die mit `/` beginnen, sonst `/`.
    - `GET /auth/twitch/connect` → Sitzung nötig, Flow `connect`, `scopes: REQUIRED_CHANNEL_SCOPES`.
    - `GET /auth/twitch/callback?code&state` (oder `?error`) → Cookie fehlt oder `state` passt nicht → `400 { code: 'oauth_state', message: 'Die Anmeldung ist abgelaufen. Starte sie neu.' }`; `error` → `400 { code: 'twitch_denied' }`; `exchangeCode`, `getUser`. Flow `login`: `pid = findPidByTwitchId ?? randomUUID()`, `signIn` mit Akteur `system:twitch`; bei `pid_mismatch` einmal mit `findPidByTwitchId` wiederholen; `createSession`, Cookie `ccg_session` (30 Tage), 302 auf `return`. Flow `connect`: `connectChannel` mit Akteur `user:<pid>` (pid der Sitzung), 302 auf `return`. Ablehnung → `rejectionToHttp`. `TwitchError` → 502 bei `twitch_unreachable`, sonst 400, Body `{code, message}`. OAuth-Cookie wird immer gelöscht (`maxAgeSec: 0`).
    - `POST /auth/logout` → `deleteSession`, Cookie löschen, 204.
  - `registerMeRoutes(app, deps, pool)` (alle mit `requireSession`, Akteur `user:<pid>`, `ip: req.ip`):
    - `GET /me` → `{ pid, login, displayName, soloTeamId, termsVersion, currentTermsVersion: PLATFORM_TERMS_VERSION, channelConnected, legal }` (aus `identities` + `accounts`).
    - `POST /me/terms { version }` → `acceptTerms`, 204.
    - `PUT /me/profile { legal }` → `updateProfile`, 204.
    - `DELETE /me/channel` → `disconnectChannel`, 204.
    - `GET /me/data` → `{ identity: { pid, twitchId, login, displayName, createdAt }, account: AccountState, events: EventRecord[] (Strom account:<pid>), participations: giveaway_participants-Zeilen der pid }`, davor `logRead(pool, { actor, action: 'export_data', target: accountStream(pid), ip, at })`; Header `Content-Disposition: attachment; filename="meine-daten.json"`.
    - `DELETE /me` → `deleteAccount`, Cookie löschen, 204.
  - `buildApp(deps: { pool: pg.Pool; api?: ApiDeps }, opts)` – registriert die Routen nur, wenn `api` gesetzt ist. `main.ts`: `tokenKey = await loadTokenKey(config.tokenKeyFile)`, `accounts = attachAccounts(rt, { tokenKey })`, `twitch = twitchAuthClient({ clientId, clientSecret })`, `secureCookies = config.nodeEnv === 'production'`.

- [ ] **Step 1: Tests schreiben** (Helfer `test/helpers/api.ts`: `setupApi()` → freshDb, Runtime mit `allowAll`, `attachAccounts`, Stub-`TwitchAuthClient` mit einstellbarem `user` und `scopes`, `buildApp({ pool, api })`; `login(app, user)` spielt login→callback durch und liefert das Sitzungs-Cookie)

```ts
// api-auth.test.ts
it('login redirects to twitch with state cookie, callback creates identity + session, GET /me answers', ...);
it('callback with wrong state is rejected and exchanges no code', ...);
it('callback with ?error answers twitch_denied', ...);
it('second login of the same twitch user reuses the pid', ...);
it('connect requires a session, stores the token, GET /me shows channelConnected', ...);
it('connect with another twitch account is rejected with wrong_twitch_account', ...);
it('logout deletes the session, GET /me is 401 afterwards; expired session is 401', ...);
it('return path outside the site falls back to /', ...);
// api-me.test.ts
it('terms, profile, channel disconnect run through the bus and show in GET /me', ...);
it('GET /me/data exports identity, account state, events and participations and writes a read entry in access_log', ...);
it('DELETE /me removes identity, session and token, journal keeps account_deleted, cookie is cleared', ...);
it('rejections map to status codes: 401 no session, 400 terms_version_stale, 404 after deletion', ...);
```

- [ ] **Step 2: Tests laufen lassen, sie scheitern**
- [ ] **Step 3: Implementieren**
- [ ] **Step 4: Tests laufen lassen, sie bestehen** (`npx vitest run test/api-auth.test.ts test/api-me.test.ts test/app.test.ts`)
- [ ] **Step 5: Commit** `feat(api): Twitch-Anmeldung, Kanal verbinden, Meine Daten`

---

### Task 5: Rechte für Giveaway-Befehle aus `accounts`

**Files:**
- Create: `src/identity/account/authorizer.ts`
- Modify: `src/app/main.ts`, `src/scheduler/main.ts` (`denyUsers` → `accountAuthorizer()`), `src/framework/giveaway/authorize.ts` (`denyUsers` entfernen, Kommentar „Konten kommen erst in Teilprojekt 3“ entfernen)
- Test: `test/account-authorizer.test.ts`

**Interfaces:**
- Produces: `accountAuthorizer(): GiveawayAuthorizer`. `controls(c, actor, teamId)`: `system:*` → `null`; `user:<pid>`: Zeile aus `accounts`; fehlt oder `deleted` → `reject('no_account', 'Melde dich zuerst an.')`; `solo_team_id !== teamId` → `reject('not_your_team', 'Dieses Giveaway gehört nicht zu deinem Team.')`; `terms_version !== PLATFORM_TERMS_VERSION` → `reject('terms_required', 'Akzeptiere zuerst die Nutzungsbedingungen.')`; `!channel_connected` → `reject('channel_required', 'Verbinde zuerst deinen Kanal.')`; sonst `null`. Hinweis für TP7: Mitgliedschaften in echten Teams kommen hier dazu.

- [ ] **Step 1: Test schreiben** (Runtime mit `auth: accountAuthorizer()`, Konto über `signIn`/`acceptTerms`/`connectChannel`)

```ts
it('create_giveaway as a stranger: no_account; own solo team without terms: terms_required; without channel: channel_required; complete: ok', ...);
it('foreign team is not_your_team even with a complete account', ...);
it('system actors pass', ...);
it('a deleted account loses control', ...);
```

- [ ] **Step 2–4: scheitern, implementieren, bestehen**
- [ ] **Step 5: Commit** `feat(identity): Rechte für Giveaway-Befehle aus dem Konto`

---

### Task 6: Rechtstexte je Giveaway, Öffnen friert ein

**Files:**
- Modify: `src/framework/legal.ts` (+ `FrozenLegal`, `mergeLegal`, `LegalFetcher`, `fetchHash`), `src/framework/giveaway/state.ts`, `events.ts`, `lifecycle.ts`, `runtime.ts`, `src/framework/kernel-registry.ts` (`FRAMEWORK_REDUCER_VERSION = 4`)
- Create: `src/framework/giveaway/open.ts`, `src/identity/account/legal-source.ts`
- Modify: `test/helpers/giveaway.ts` (`setupGiveaway` setzt `legalSource: fullLegalSource`, `fetcher: fakeFetcher`), `src/app/main.ts`, `src/scheduler/main.ts`
- Test: `test/legal.test.ts`, `test/lifecycle.test.ts` (Erwartung `settings` + `legal: null` in `giveaway_created`)

**Interfaces:**
- Produces:
  - `legal.ts`: `interface FrozenLegal { impressum: { url: string; hash: string }; terms: { text: string } | { url: string; hash: string }; privacy: { url: string; hash: string }; frozenAt: string }`, `mergeLegal(giveaway: LegalTexts | null, profile: LegalTexts | null): LegalTexts` (je Feld Giveaway vor Profil), `type LegalFetcher = (url: string) => Promise<{ ok: true; hash: string } | { ok: false }>`, `fetchHash(url, o?: { timeoutMs?: number; fetch?: typeof fetch }): ReturnType<LegalFetcher>` (GET, Timeout 5000 ms, SHA-256 hex des Bodys, Status ≠ 2xx → `ok: false`).
  - `interface LegalSource { profileOf(c: pg.PoolClient, actor: Actor): Promise<LegalTexts | null> }`, `noProfile: LegalSource` (immer `null`), `accountLegalSource(): LegalSource` (liest `accounts.legal` zur pid des Akteurs).
  - `GiveawaySettings.legal: LegalTexts | null` (Reducer normalisiert `?? null`; `checkSettings` prüft mit `checkLegal`, wenn nicht `null`). `settingsSchema.legal = legalSchema.nullable().optional()`.
  - `GiveawayState.legal: FrozenLegal | null`, `GiveawayState.legalEventId: string | null`, `registered[pid].legalEventId: string | null`.
  - Ereignis `giveaway_legal_frozen` (= `GIVEAWAY_EVENTS.legalFrozen`), Payload `FrozenLegal`, Umkehrart `none` „Eingefrorene Rechtstexte sind ein Nachweis und bleiben.“
  - `OpenDeps extends GiveawayDeps { legalSource: LegalSource; fetcher: LegalFetcher; loadState(c, stream): Promise<GiveawayState> }`, `openGiveawayHandler(d: OpenDeps): CommandHandler<GiveawayCmd, GiveawayState, OpenPrepared>` mit `type: 'open_giveaway'`. `prepare`: Zustand laden; nicht Entwurf → `{ kind: 'skip' }`; `merged = mergeLegal(state.settings.legal, await legalSource.profileOf(c, ctx.actor))`; `missingLegal(merged)` nicht leer → `{ kind: 'missing', names }`; URLs holen (Impressum, Datenschutz, Teilnahmebedingungen-URL falls URL) → erste nicht erreichbare → `{ kind: 'unreachable', url }`; sonst `{ kind: 'ready', frozen }`. `decide`: `!exists` → `GIVEAWAY_NOT_FOUND`; Status ≠ Entwurf → `invalid_transition` (Text wie `transitionHandler`); `missing` → `reject('legal_required', \`Hinterlege zuerst: ${names.join(', ')}.\`)`; `unreachable` → `reject('legal_unreachable', \`Die Seite ${url} ist nicht erreichbar. Prüfe den Link.\`)`; sonst `[legal_frozen, status_changed {from: 'draft', to: 'open'}]`.
  - `RuntimeOptions` + `legalSource?: LegalSource` (Default `noProfile`), `fetcher?: LegalFetcher` (Default `fetchHash`). `handlers.open` = `openGiveawayHandler`.
  - Mains: `legalSource: accountLegalSource()`.

- [ ] **Step 1: Tests schreiben** (`test/legal.test.ts`; Fetcher-Stub mit Tabelle URL → hash | unreachable)

```ts
it('checkLegal accepts https urls and text, rejects javascript: and over-long text', ...);
it('mergeLegal takes giveaway fields first, profile fields second', ...);
it('open without legal texts is rejected with legal_required naming the missing ones, giveaway stays draft', ...);
it('open with giveaway legal texts freezes hashes and text, writes legal_frozen before status_changed', ...);
it('open takes missing fields from the actor profile (accountLegalSource)', ...);
it('unreachable url rejects with legal_unreachable naming the url, nothing written', ...);
it('registration after opening records the legalEventId in state', ...);
it('reopen after close does not freeze again, revert of legal_frozen is not possible', ...);
it('fetchHash hashes the body of a local http server and reports a 404 as unreachable', ...); // node:http Server auf Port 0
```

- [ ] **Step 2: Tests laufen lassen, sie scheitern**
- [ ] **Step 3: Implementieren** (`transitionHandler(d, 'open_giveaway')` bleibt für `TRANSITION_SPEC`, wird aber von der Runtime nicht mehr genutzt; `open_giveaway` aus `TransitionType` entfernen, wenn kein Aufrufer bleibt)
- [ ] **Step 4: Gesamte Suite laufen lassen** (`npm test`)
- [ ] **Step 5: Commit** `feat(giveaway): Öffnen verlangt Rechtstexte und friert sie ein`

---

### Task 7: Wartung (Sitzungen, inaktive Konten), Doku

**Files:**
- Create: `src/identity/inactivity.ts`
- Modify: `src/scheduler/maintenance.ts`, `src/scheduler/main.ts`, `test/maintenance.test.ts`, `README.md`, `.env.example`
- Test: `test/inactivity.test.ts`

**Interfaces:**
- Produces: `INACTIVE_DAYS = 365`, `purgeInactiveAccounts(pool, rt, accounts: AccountHandlers, now): Promise<{ deleted: string[]; failed: number }>` – `SELECT pid FROM identities WHERE last_seen_at < now - 365 d`, je pid `deleteAccount` mit Akteur `system:scheduler`; Ablehnung oder Fehler zählt `failed`, der Lauf geht weiter.
  - `runMaintenance(pool, now, o?: { rt: Runtime; accounts: AccountHandlers })` → `{ partitions, ipsPurged, sessionsPurged, accountsPurged }`. Ohne `o` bleiben `accountsPurged = 0`.

- [ ] **Step 1: Tests schreiben**

```ts
it('purgeInactiveAccounts deletes accounts unseen for 365 days and leaves recent ones', ...);
it('runMaintenance purges expired sessions and reports counts', ...);
```

- [ ] **Step 2–4: scheitern, implementieren, bestehen**
- [ ] **Step 5: README** – Abschnitt „Prozesse“: app bekommt `/auth/*` und `/me/*`; Scheduler-Wartung räumt Sitzungen und inaktive Konten; Begriffe „Sitzung“, „Kanal-Token“, „Solo-Team“, „Rechtstexte einfrieren“ ergänzen. `.env.example` Hinweis: `openssl rand -hex 32 > secrets/token.key`.
- [ ] **Step 6: Commit** `feat(scheduler): Sitzungen und inaktive Konten aufräumen, Doku Teilprojekt 3`

---

### Task 8: Abschluss

- [ ] `npm run typecheck && npm run lint && npm test && npm run build`
- [ ] Review der gesamten Änderung (superpowers:requesting-code-review oder `/code-review`)
- [ ] README-Zeile „Teilprojekt 1 ‚Fundament‘ ist fertig“ → „Teilprojekte 1–3 sind fertig“.
