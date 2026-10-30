# Teilprojekt 4: Ingest – Umsetzungsplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ein dritter Prozess `ingest` holt Signale (Anwesenheit, Chat, Follow, Live-Status) von Twitch oder vom Simulator, bündelt sie je Kanal und Minute und gibt sie als Befehl `apply_signals` an den Rahmen. Der Statusblock bekommt je Kanal live/offline, letztes Signal, Zuschauerzahl und Abdeckung.

**Architecture:** Neues Modul `src/ingest` mit der Adapter-Schnittstelle aus Spec 10.1, zwei Adaptern (`simulator`, `twitch`), einem Bündler je Kanal und Minute und einem Dispatcher, der je offenem Giveaway des Kanals `CommandBus.execute(applySignals)` mit Akteur `system:ingest` ruft. Der Rahmen bekommt den Befehl `apply_signals` auf dem Strom `giveaway:<id>`: Er prüft Rechte und Zustand, löst Twitch-IDs über `identities` zu `pid`s auf und liefert in diesem Teilprojekt noch keine Ereignisse. Teilprojekt 5 hängt dort Zuschauzeit und Chat-Bonus an. Signalqualität je Kanal liegt als Betriebsdaten in der Tabelle `channel_status`, nicht im Journal. Twitch-Anbindung: EventSub über WebSocket mit einem Conduit je Plattform und einem Shard je Worker, Helix `Get Chatters` je Minute und Live-Kanal mit dem Token des Streamers, `Get Streams` je Minute für Live-Abgleich und Zuschauerzahl, `Send Chat Message` und `channel.chat.message` mit App-Token über den Plattform-Bot.

**Tech Stack:** TypeScript, Node 24 (globales `fetch` und `WebSocket`), pg, zod, Fastify 5. Tests mit Vitest, Testcontainers und aufgezeichneten Twitch-Payloads als Fixtures. Keine neuen Abhängigkeiten.

**Spec:** `NEW_DESIGN.md` Abschnitte 3.1, 3.3, 3.4, 6.1 (nur die Signalseite), 9.2, 10.1, 10.2, 11.2, 12.1, 12.2, 12.4, 14 (Punkt 4).

## Global Constraints

- Jede Zustandsänderung läuft durch `CommandBus.execute` (CLAUDE.md). Der Ingest schreibt nie ins Journal und nie in Lesetabellen des Journals. Er sendet Befehle mit Akteur `system:ingest` (Spec 3.4, 5.1).
- Payloads enthalten nur `pid` (`assertNoTwitchIdentity`). Befehle dürfen Twitch-Daten tragen, Ereignisse nicht.
- Ein Kern importiert nur `kernel-api`. Neu: `src/ingest/**` importiert nie `journal/journal.js` (kein `appendLocked`). ESLint erzwingt beides.
- Neue Tabellen nur über `packages/server/migrations/005_ingest.sql`.
- Scopes des Kanals: `moderator:read:followers`, `moderator:read:chatters`, `channel:bot` (Spec 9.2). Scopes des Plattform-Bots: `user:bot`, `user:read:chat`, `user:write:chat`.
- Twitch-API-Fehler: Wiederholung mit Backoff, nach 3 Versuchen Warnung im Statusblock (Spec 12.1). Backoff 1 s, 2 s, 4 s.
- Statusblock je Kanal: live/offline, letztes Signal, Zuschauerzahl, Abdeckung = Chatters ÷ Zuschauer (Spec 11.2). Warnungen: Live-Kanal ohne Signal > 2 min → gelb „Kanal neu verbinden“; Token abgelaufen oder Scope fehlt → rot „Kanal neu verbinden“; Abdeckung unter 50 % → Hinweis.
- Anwesenheit: Helix `Get Chatters` einmal je Minute je Live-Kanal mit dem Token des Streamers (Spec 6.1, 10.2). Token-Refresh läuft automatisch, Fehlschlag → Kanal rot (Spec 10.2).
- Kanäle werden per konsistentem Hash auf Worker verteilt (Spec 10.2).
- UI- und Fehlertexte deutsch, aktiv, höchstens 20 Wörter, was passiert ist + was zu tun ist (Spec 11.6).
- Tests nur gegen Testcontainers. Kein Netz in Tests: `fetch` und `WebSocket` werden injiziert.
- Vor dem Typecheck ganze Aufgaben fertig schreiben, dann `npm run typecheck`, `npm run lint`, `npm test` einmal je Aufgabe.

## Entscheidungen, die die Spec offen lässt (meine Festlegungen)

1. **`channel_status` ist Betriebsdaten** wie `sessions`, `access_log` und `timers`: Signalqualität je Kanal ändert sich jede Minute für bis zu 1.000 Kanäle, ist abgeleitet, hat keinen Nachweiswert und baut sich aus dem Livebetrieb neu auf. Darum schreibt der Ingest sie direkt, nicht über das Journal. Der Nachweis, was gezählt wurde, entsteht in Teilprojekt 5 über Ereignisse.
2. **Kanalverzeichnis** liest der Ingest aus Lesetabellen (`accounts`, `channel_tokens`, `identities`, `giveaways`), alle 30 s. Lesen ist erlaubt, Spec 3.4 beschränkt nur das Schreiben. Zwei Beobachtungsstufen: `state` für jeden verbundenen Kanal (Live-Status, Zuschauerzahl), `full` für Kanäle in mindestens einem Giveaway im Zustand Offen (zusätzlich Chat, Follow, Anwesenheit je Minute). Pausierte Giveaways sammeln nichts (Spec 7.1), darum reicht `state`.
3. **Befehl `apply_signals`** geht je offenem Giveaway des Kanals an dessen Strom. In diesem Teilprojekt erzeugt `decide` keine Ereignisse, prüft aber Rechte, Zustand und Kanalzugehörigkeit und löst Twitch-IDs zu `pid`s auf. Teilprojekt 5 ergänzt `watch_credited` und `chat_credited` an derselben Stelle. Unbekannte Twitch-Nutzer fallen hier weg, die Zählweise „ab erstem Erscheinen“ legt erst Teilprojekt 5 an.
4. **`identities.last_seen_at`** setzt `apply_signals.prepare` für aufgelöste Anwesende, höchstens einmal je Stunde je Person.
5. **Plattform-Bot:** Ein Twitch-Konto des Betreibers erteilt der App einmalig `user:bot user:read:chat user:write:chat` über `GET /auth/twitch/bot`. Danach reichen App-Access-Tokens (Client Credentials) für Chat lesen und senden. Konfiguration `TWITCH_BOT_USER_ID`, Pflicht nur bei `INGEST_ADAPTER=twitch`.
6. **Worker-Verteilung:** `INGEST_WORKERS` (Default 1) und `INGEST_WORKER_INDEX` (Default 0). Ein Conduit je Plattform mit `shard_count = INGEST_WORKERS`, Worker 0 legt es an oder passt die Shard-Zahl an, jeder Worker bindet Shard `INGEST_WORKER_INDEX` an seine WebSocket-Sitzung. Ein Kanal „gehört“ dem Worker `fnv1a(pid) mod workers`: nur er pollt Anwesenheit und legt Abonnements an. Chat- und Live-Benachrichtigungen kommen über das Conduit bei jedem Shard an und werden dort gebündelt. Zwei Worker können darum in derselben Minute je ein Chat-Bündel für denselben Kanal senden. Teilprojekt 5 muss das beim Cooldown über den Zustand abfangen.
7. **Bündelung:** Schlüssel ist (Kanal, Minute). Ein Bündel fließt 5 s nach Minutenende ab. `stream_state`-Signale gehen nicht ins Bündel, sondern direkt in `channel_status`. Ein Bündel ohne Anwesenheit, Chat und Follows wird nicht gesendet.
8. **Zuschauerzahl** reist als optionales Feld `viewers` im `stream_state`-Signal. Der Twitch-Adapter erzeugt `stream_state` aus EventSub `stream.online`/`stream.offline` und je Minute aus `Get Streams` (gleicht verpasste Ereignisse ab).
9. **Refreshed Tokens** schreibt der Ingest direkt (`updateChannelToken`), wie heute `markTokenInvalid`. Beides ist Betriebsdaten, der Zustand „Kanal verbunden“ bleibt im Konto-Strom.
10. **Simulator:** In-Process-Adapter mit festem Seed. Je gestartetem Kanal: `stream_state live`, je Minute Anwesenheit aus 80–100 % der Fake-Zuschauer, alle `chatEveryMs` eine Chatnachricht, alle 5 Minuten ein Follow. Fake-Nutzer `sim-<k>` haben keine Identität und fallen im Rahmen weg, bis Teilprojekt 5 Zählweise „ab erstem Erscheinen“ bringt. Für Tests gibt es `inject(signal)`.

## Review Focus

1. Ein Signal für einen Kanal, der zu keinem offenen Giveaway gehört, darf keinen Befehl auslösen und keinen Fehler werfen, nur `channel_status` aktualisieren. Test in Aufgabe 5.
2. `apply_signals` von einem Akteur, der nicht `system:ingest` ist, wird abgelehnt (`not_ingest`), auch für den Streamer des Teams. Test in Aufgabe 3.
3. Ein ungültiges Token des Streamers darf Anwesenheit nie mit Fehlerflut quittieren: nach `twitch_denied` beim Refresh wird das Token `invalid`, der Kanal rot, kein weiterer Helix-Aufruf bis zum nächsten Verbinden. Test in Aufgabe 6.
4. Ein Helix-Ausfall (Netzfehler oder 5xx) in drei Versuchen setzt `channel_status.problem = 'twitch_error'`, der nächste Minutenlauf versucht es wieder. Test in Aufgabe 8.
5. Eine EventSub-Benachrichtigung für einen Broadcaster, den das Verzeichnis nicht kennt, wird verworfen und nicht als Signal weitergegeben. Test in Aufgabe 7.

---

## Dateistruktur

```
packages/server/migrations/005_ingest.sql               channel_status, GIN-Index giveaways.channels
packages/server/src/config/config.ts                    + INGEST_ADAPTER, INGEST_WORKERS, INGEST_WORKER_INDEX, TWITCH_BOT_USER_ID, INGEST_SIM_VIEWERS, INGEST_SIM_SEED
packages/server/src/ingest/signals.ts                   Signal, SignalUser, ChannelRef, IngestAdapter, AdapterHealth, SendResult, FollowResult (Spec 10.1)
packages/server/src/ingest/bundler.ts                   minuteOf, SignalBundle, Bundler
packages/server/src/ingest/shard.ts                     fnv1a, shardOf
packages/server/src/ingest/backoff.ts                   withBackoff
packages/server/src/ingest/channel-status.ts            Tabelle channel_status: upsert, read, StatusBuffer
packages/server/src/ingest/status-view.ts               channelWarning (rein), channelStatusView (Join für den Statusblock)
packages/server/src/ingest/directory.ts                 ChannelSource, pgChannelSource, Directory (Diff → adapter.start/stop)
packages/server/src/ingest/dispatch.ts                  GiveawayLookup, pgGiveawayLookup, dispatcher
packages/server/src/ingest/worker.ts                    createIngestWorker (Komposition, testbar)
packages/server/src/ingest/main.ts                      Prozess ingest
packages/server/src/ingest/simulator.ts                 SimulatorAdapter
packages/server/src/ingest/twitch/helix.ts              HelixClient, appTokenSource, HelixError
packages/server/src/ingest/twitch/tokens.ts             channelTokenProvider (Refresh, invalid)
packages/server/src/ingest/twitch/eventsub.ts           EventSubSocket, parseMessage, toSignal
packages/server/src/ingest/twitch/conduit.ts            ensureConduit, bindShard
packages/server/src/ingest/twitch/adapter.ts            twitchAdapter
packages/server/src/framework/giveaway/signals.ts       ApplySignalsCmd, IdentityResolver, noIdentities, applySignalsHandler
packages/server/src/framework/runtime.ts                + identities?: IdentityResolver, handlers.applySignals
packages/server/src/identity/identities.ts              + findPidsByTwitchIds, touchIdentities
packages/server/src/identity/tokens.ts                  + updateChannelToken
packages/server/src/identity/resolver.ts                identityResolver(): IdentityResolver
packages/server/src/api/auth.ts                         + Fluss bot, GET /auth/twitch/bot
packages/server/src/api/me.ts                           + GET /me/channel
packages/server/eslint.config.js                        + Regel für src/ingest/**
packages/server/package.json                            + dev:ingest, start:ingest
packages/server/test/fixtures/twitch/*.json             aufgezeichnete Payloads
README.md                                               Prozess ingest, Bot einrichten
```

---

### Task 1: Signale, Adapter-Schnittstelle, Bündler, Shard-Hash, Backoff, Lint-Regel

**Files:**
- Create: `src/ingest/signals.ts`, `src/ingest/bundler.ts`, `src/ingest/shard.ts`, `src/ingest/backoff.ts`
- Modify: `eslint.config.js`, `test/architecture.test.ts`
- Test: `test/ingest-bundler.test.ts`, `test/ingest-shard.test.ts`, `test/ingest-backoff.test.ts`

**Interfaces:**
- Consumes: `Pid` aus `kernel-api`.
- Produces:
  - `signals.ts`:
    - `interface SignalUser { id: string; login: string; displayName: string }` (strukturgleich `TwitchUser`)
    - `interface ChannelRef { pid: Pid; twitchId: string; watch: 'state' | 'full'; owned: boolean }`
    - `type Signal = | { kind: 'presence'; channel: Pid; minute: string; users: SignalUser[] } | { kind: 'chat'; channel: Pid; at: string; user: SignalUser; text: string; messageId: string } | { kind: 'follow'; channel: Pid; at: string; user: SignalUser } | { kind: 'stream_state'; channel: Pid; at: string; live: boolean; viewers?: number }` (Zeiten ISO)
    - `type SendResult = { ok: true; messageId: string } | { ok: false; reason: string }`
    - `interface FollowResult { userId: string; follows: boolean; since: string | null }`
    - `interface AdapterHealth { channel: Pid; ok: boolean; lastSignalAt: string | null; problem: string | null }`
    - `interface IngestAdapter { start(channels: ChannelRef[]): Promise<void>; stop(channel: ChannelRef): Promise<void>; onSignal(handler: (s: Signal) => void): void; sendChat(channel: ChannelRef, text: string): Promise<SendResult>; checkFollows(channel: ChannelRef, userIds: string[]): Promise<FollowResult[]>; health(): AdapterHealth[]; close(): Promise<void> }` – `start` ist idempotent und ersetzt die Beobachtung eines schon gestarteten Kanals (Wechsel `state`↔`full`).
  - `bundler.ts`:
    - `minuteOf(at: string | Date): string` → ISO auf volle Minute, z. B. `2026-10-15T12:00:00.000Z`
    - `interface SignalBundle { channel: Pid; minute: string; presence: SignalUser[] | null; chat: { user: SignalUser; at: string; text: string; messageId: string }[]; follows: { user: SignalUser; at: string }[] }`
    - `BUNDLE_GRACE_MS = 5_000`
    - `class Bundler { constructor(o: { flush: (b: SignalBundle) => Promise<void>; graceMs?: number; log: BusLogger }); add(s: Signal): void; tick(now: Date): Promise<void>; drain(): Promise<void>; size(): number }` – `add` ignoriert `stream_state`; eine zweite Anwesenheit derselben Minute ersetzt die erste; `tick` flusht alle Eimer mit `minute + 60 s + graceMs <= now` nacheinander, ein werfendes `flush` geht an `log.error` und der Eimer ist weg; `drain` flusht alles.
  - `shard.ts`: `fnv1a(text: string): number` (32 Bit, `& 0x7fffffff`), `shardOf(pid: string, workers: number): number`
  - `backoff.ts`: `BACKOFF_ATTEMPTS = 3`, `BACKOFF_BASE_MS = 1_000`, `withBackoff<T>(fn: (attempt: number) => Promise<T>, o?: { attempts?: number; baseMs?: number; sleep?: (ms: number) => Promise<void>; retryOn?: (e: unknown) => boolean }): Promise<T>` – wirft den letzten Fehler nach `attempts` Versuchen; Wartezeit `baseMs * 2^(attempt)`; `retryOn` Default `() => true`.
  - `eslint.config.js`: für `src/ingest/**/*.ts` `no-restricted-imports` mit Muster `^(\.\./)+journal/journal(\.js)?$` und Meldung „Der Ingest schreibt nie ins Journal. Er sendet Befehle (NEW_DESIGN.md 3.4).“

- [ ] **Step 1: Tests schreiben**

```ts
// ingest-bundler.test.ts
it('minuteOf floors to the full minute in UTC', ...);           // '2026-10-15T12:00:59.999Z' → '2026-10-15T12:00:00.000Z'
it('collects presence, chat and follows of one channel and minute into one bundle', ...);
it('keeps channels and minutes apart', ...);
it('flushes only after minute end plus grace, earliest minute first', ...);  // tick(AT+64s) flusht Minute 12:00 nicht, tick(AT+65s) schon
it('ignores stream_state signals', ...);
it('a throwing flush is logged and the bucket is dropped', ...);
it('drain flushes every bucket', ...);
// ingest-shard.test.ts
it('shardOf is stable and within [0, workers)', ...);           // 1000 zufällige UUIDs, workers 1 und 7
it('distributes 1000 pids over 4 workers with at most 35 % on one', ...);
// ingest-backoff.test.ts
it('returns on first success without sleeping', ...);
it('retries 3 times with 1 s, 2 s, 4 s and rethrows the last error', ...);  // sleep als vi.fn, erwartet [1000, 2000] (nach dem dritten Fehler kein Schlaf)
it('does not retry when retryOn says no', ...);
// architecture.test.ts, neuer describe('Ingest')
it('ingest darf journal/journal nicht importieren', ...);        // src/ingest/x.ts → '../journal/journal.js' restricted
it('ingest darf framework und identity importieren', ...);
```

- [ ] **Step 2: Tests laufen lassen, sie scheitern** (`npx vitest run test/ingest-bundler.test.ts test/ingest-shard.test.ts test/ingest-backoff.test.ts test/architecture.test.ts`)
- [ ] **Step 3: Implementieren** (Signaturen oben)
- [ ] **Step 4: Tests laufen lassen, sie bestehen**
- [ ] **Step 5: Commit** `feat(ingest): Signale, Adapter-Schnittstelle, Bündler, Backoff`

---

### Task 2: Migration, Konfiguration, `channel_status`, Statusblock-Sicht, `GET /me/channel`

**Files:**
- Create: `migrations/005_ingest.sql`, `src/ingest/channel-status.ts`, `src/ingest/status-view.ts`
- Modify: `src/config/config.ts`, `src/identity/tokens.ts`, `src/identity/identities.ts`, `src/api/me.ts`, `.env.example`
- Test: `test/config.test.ts`, `test/channel-status.test.ts`, `test/api-me.test.ts`

**Interfaces:**
- Produces:
  - `005_ingest.sql`:
    ```sql
    -- Signalqualität je Kanal (NEW_DESIGN.md 11.2). Betriebsdaten des Ingest, kein Nachweis: nicht im Journal.
    CREATE TABLE channel_status (
      pid              UUID PRIMARY KEY,
      live             BOOLEAN NOT NULL DEFAULT false,
      live_since       TIMESTAMPTZ,
      viewers          INTEGER,
      chatters         INTEGER,
      last_signal_at   TIMESTAMPTZ,
      last_presence_at TIMESTAMPTZ,
      problem          TEXT,
      worker           INTEGER,
      updated_at       TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX giveaways_channels ON giveaways USING GIN (channels jsonb_path_ops);
    ```
  - `config.ts` (alle optional, Default in Klammern): `INGEST_ADAPTER` enum `twitch|simulator` (`twitch`), `INGEST_WORKERS` int ≥ 1 (`1`), `INGEST_WORKER_INDEX` int ≥ 0 (`0`), `TWITCH_BOT_USER_ID` string (`''`), `INGEST_SIM_VIEWERS` int 1–5000 (`20`), `INGEST_SIM_SEED` int (`1`). `Config` bekommt `ingestAdapter`, `ingestWorkers`, `ingestWorkerIndex`, `twitchBotUserId`, `ingestSimViewers`, `ingestSimSeed`. `loadConfig` lehnt `INGEST_WORKER_INDEX >= INGEST_WORKERS` ab: „INGEST_WORKER_INDEX muss kleiner als INGEST_WORKERS sein.“
  - `channel-status.ts`:
    - `interface ChannelStatusRow { pid: Pid; live: boolean; liveSince: Date | null; viewers: number | null; chatters: number | null; lastSignalAt: Date | null; lastPresenceAt: Date | null; problem: string | null; worker: number | null; updatedAt: Date }`
    - `type ChannelStatusPatch = Partial<Omit<ChannelStatusRow, 'pid' | 'updatedAt'>>`
    - `upsertChannelStatus(db: Queryable, pid: Pid, patch: ChannelStatusPatch, now: Date): Promise<void>` – INSERT … ON CONFLICT DO UPDATE nur der Felder im Patch (`COALESCE`-frei: Felder, die im Patch fehlen, bleiben); `live: true` ohne `liveSince` setzt `live_since = now`, wenn vorher `live = false`; `live: false` setzt `live_since = NULL`.
    - `readChannelStatus(db: Queryable, pids: Pid[]): Promise<Map<Pid, ChannelStatusRow>>`
    - `deleteChannelStatus(db: Queryable, pid: Pid): Promise<void>`
    - `class StatusBuffer { note(pid: Pid, patch: ChannelStatusPatch): void; flush(db: Queryable, now: Date): Promise<number> }` – mischt Patches je pid (später gewinnt), `flush` schreibt jede pid einmal und leert den Puffer.
  - `status-view.ts`:
    - `type ChannelWarning = { level: 'rot' | 'gelb' | 'hinweis'; text: string } | null`
    - `interface ChannelStatusView { pid: Pid; connected: boolean; tokenStatus: 'ok' | 'invalid' | 'none'; live: boolean; liveSince: string | null; viewers: number | null; chatters: number | null; coverage: number | null; lastSignalAt: string | null; problem: string | null; warning: ChannelWarning }`
    - `SIGNAL_STALE_MS = 120_000`, `COVERAGE_MIN = 0.5`
    - `channelWarning(v: Pick<ChannelStatusView, 'connected' | 'tokenStatus' | 'live' | 'lastSignalAt' | 'coverage' | 'problem'>, now: Date): ChannelWarning` – Reihenfolge: nicht verbunden → `null`; `tokenStatus !== 'ok'` → rot „Kanal neu verbinden. Das Twitch-Token ist abgelaufen oder ein Recht fehlt.“; live und `lastSignalAt` älter als `SIGNAL_STALE_MS` (oder null) → gelb „Kanal neu verbinden. Seit über 2 Minuten kommt kein Signal.“; `problem === 'twitch_error'` → gelb „Twitch antwortet nicht. Der Ingest versucht es weiter.“; `coverage !== null && coverage < COVERAGE_MIN` → hinweis „Abdeckung unter 50 %. Twitch meldet nicht alle Zuschauer im Chat.“; sonst `null`.
    - `channelStatusView(db: Queryable, pids: Pid[], now: Date): Promise<ChannelStatusView[]>` – LEFT JOIN `accounts` (connected = `channel_connected AND NOT deleted`), `channel_tokens` (status, sonst `none`), `channel_status`; `coverage = chatters / viewers` wenn beide > 0, sonst null; Reihenfolge wie `pids`.
  - `tokens.ts`: `updateChannelToken(db: Queryable, pid: string, t: NewToken, key: Buffer, now: Date): Promise<boolean>` – UPDATE nur bestehender Zeile, `status = 'ok'`; liefert `false`, wenn es keine Zeile gibt.
  - `identities.ts`: `findPidsByTwitchIds(db: Queryable, twitchIds: string[]): Promise<Map<string, string>>`; `TOUCH_MIN_MS = 3_600_000`; `touchIdentities(db: Queryable, pids: string[], now: Date): Promise<number>` – `UPDATE … SET last_seen_at = $now WHERE pid = ANY($1) AND last_seen_at < $now - 1 h`, liefert `rowCount`.
  - `me.ts`: `GET /me/channel` (mit Sitzung) → `channelStatusView(pool, [pid], now())[0]` als JSON.

- [ ] **Step 1: Tests schreiben**

```ts
// config.test.ts: ergänzen
it('ingest defaults: twitch adapter, 1 worker, index 0, no bot id', ...);
it('rejects INGEST_WORKER_INDEX >= INGEST_WORKERS and an unknown INGEST_ADAPTER', ...);
// channel-status.test.ts (freshDb)
it('upsert creates a row with only the patched fields and keeps the rest on the next patch', ...);
it('live true sets live_since once, live false clears it', ...);
it('StatusBuffer merges patches per pid and writes each pid once', ...);
it('channelStatusView joins accounts, tokens and status and computes coverage', ...);
it('channelWarning: token invalid → rot, live without signal 2 min → gelb, twitch_error → gelb, coverage 0.4 → hinweis, healthy → null', ...);
it('updateChannelToken overwrites an existing row and returns false without one', ...);
it('touchIdentities updates only rows older than one hour', ...);
// api-me.test.ts: ergänzen
it('GET /me/channel returns connected false without a channel and the status view with one', ...);
```

- [ ] **Step 2: Tests laufen lassen, sie scheitern** (`npx vitest run test/config.test.ts test/channel-status.test.ts test/api-me.test.ts`)
- [ ] **Step 3: Implementieren** (`.env.example` ergänzen: `INGEST_ADAPTER=simulator`, `INGEST_WORKERS=1`, `INGEST_WORKER_INDEX=0`, `TWITCH_BOT_USER_ID=`)
- [ ] **Step 4: Tests laufen lassen, sie bestehen** (`npx vitest run test/config.test.ts test/channel-status.test.ts test/api-me.test.ts test/migrate.test.ts`)
- [ ] **Step 5: Commit** `feat(ingest): Tabelle channel_status, Statusblock-Sicht, Konfiguration`

---

### Task 3: Befehl `apply_signals` im Rahmen

**Files:**
- Create: `src/framework/giveaway/signals.ts`, `src/identity/resolver.ts`
- Modify: `src/framework/runtime.ts`, `src/app/main.ts`, `src/scheduler/main.ts` (beide: `identities: identityResolver()`)
- Test: `test/apply-signals.test.ts`

**Interfaces:**
- Consumes: `GiveawayDeps`, `authorizeControl`, `loadGiveawayRow`, `GIVEAWAY_NOT_FOUND` aus `giveaway/authorize.ts` und `lifecycle.ts`; `findPidsByTwitchIds`, `touchIdentities` aus Task 2; `SignalUser` aus `ingest/signals.ts` (Typ-Import).
- Produces:
  - `signals.ts`:
    - `interface IdentityResolver { resolve(c: Queryable, twitchIds: string[]): Promise<Map<string, Pid>>; touch(c: Queryable, pids: Pid[], now: Date): Promise<void> }`
    - `noIdentities: IdentityResolver` (leere Map, kein Touch)
    - `interface ApplySignalsCmd { giveawayId: string; channel: Pid; minute: string; presence: SignalUser[] | null; chat: { user: SignalUser; at: string; text: string; messageId: string }[]; follows: { user: SignalUser; at: string }[] }`
    - `interface ResolvedSignals { presence: Pid[] | null; chat: { pid: Pid; at: string; text: string; messageId: string }[]; follows: { pid: Pid; at: string }[]; unknown: number }` – `unknown` = Nutzer ohne Identität (weggefallen)
    - `MINUTE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/`
    - `applySignalsHandler(d: GiveawayDeps & { identities: IdentityResolver }): CommandHandler<ApplySignalsCmd, GiveawayState, ResolvedSignals>` mit `type: 'apply_signals'`:
      - `authorize`: `ctx.actor !== 'system:ingest'` → `reject('not_ingest', 'Signale nimmt nur der Ingest an.')`; `giveawayId`/`channel` keine UUID → `INVALID_ID()`; `minute` passt nicht auf `MINUTE_RE` → `reject('invalid_minute', 'Die Minute muss ein ISO-Zeitpunkt auf volle Minute sein.')`; `presence` weder null noch Array, `chat`/`follows` kein Array → `reject('invalid_signals', 'Die Signale sind ungültig.')`; Zeile aus `loadGiveawayRow` fehlt → `GIVEAWAY_NOT_FOUND()`; `row.status !== 'open'` → `NOT_OPEN()`.
      - `prepare`: Twitch-IDs aller Nutzer dedupliziert → `d.identities.resolve`; `touch` für aufgelöste Anwesende; liefert `ResolvedSignals`.
      - `decide`: `!state.exists` → `GIVEAWAY_NOT_FOUND()`; `status !== 'open'` → `NOT_OPEN()` = `reject('not_open', 'Das Giveaway sammelt gerade nicht. Signale gehen nur im Zustand Offen.')`; `!state.settings.channels.includes(cmd.channel)` → `reject('channel_not_in_giveaway', 'Dieser Kanal gehört nicht zum Giveaway.')`; sonst `[]` mit Kommentar `// Teilprojekt 5: Zuschauzeit und Chat-Bonus erzeugen hier Ereignisse aus prepared.`
  - `resolver.ts`: `identityResolver(): IdentityResolver` über `findPidsByTwitchIds` und `touchIdentities`.
  - `runtime.ts`: `RuntimeOptions.identities?: IdentityResolver` (Default `noIdentities`), `handlers.applySignals: Handler<ApplySignalsCmd, ResolvedSignals>`.

- [ ] **Step 1: Test schreiben** (`setupGiveaway({ identities })` mit einem Stub-Resolver, der `ALICE.id → P1` kennt; Helfer `signals(over)` baut einen gültigen Befehl für `GID`, Kanal `P1`, Minute `minuteOf(AT)`)

```ts
it('accepts signals for an open giveaway from system:ingest, writes no event, resolves known users and drops unknown ones', ...);  // r.ok, events [], Resolver-Spy mit ['12345','99']; touch mit [P1]
it('rejects any actor other than system:ingest with not_ingest, also the streamer', ...);
it('rejects a paused giveaway with not_open and a foreign channel with channel_not_in_giveaway', ...);
it('rejects a minute that is not on the full minute and a non-uuid channel', ...);
it('prepare touches last_seen_at only for present users', ...);  // chat-only Nutzer → touch mit []
it('identityResolver maps twitch ids to pids from identities and touches last_seen_at at most once per hour', ...);  // freshDb + upsertIdentity
```

- [ ] **Step 2: Test laufen lassen, er scheitert** (`npx vitest run test/apply-signals.test.ts`)
- [ ] **Step 3: Implementieren**
- [ ] **Step 4: Tests laufen lassen, sie bestehen** (`npx vitest run test/apply-signals.test.ts test/lifecycle.test.ts test/app.test.ts`)
- [ ] **Step 5: Commit** `feat(giveaway): Befehl apply_signals mit Identitätsauflösung`

---

### Task 4: Simulator-Adapter

**Files:**
- Create: `src/ingest/simulator.ts`
- Test: `test/ingest-simulator.test.ts`

**Interfaces:**
- Consumes: Task 1.
- Produces:
  - `mulberry32(seed: number): () => number` (rein, in `simulator.ts` exportiert)
  - `interface SimulatorOptions { viewersPerChannel?: number /*20*/; seed?: number /*1*/; chatEveryMs?: number /*4_000*/; followEveryMs?: number /*300_000*/ }`
  - `class SimulatorAdapter implements IngestAdapter { constructor(o?: SimulatorOptions); inject(s: Signal): void; tick(now: Date): void; readonly sent: { channel: Pid; text: string }[]; channels(): ChannelRef[] }`
    - `start`: merkt die Kanäle (nur `owned`), erzeugt je Kanal `viewersPerChannel` Fake-Nutzer `{ id: 'sim-<k>', login: 'sim<k>', displayName: 'Sim <k>' }` mit `k` fortlaufend über alle Kanäle, sendet sofort `stream_state { live: true, viewers: viewersPerChannel }`.
    - `stop`: sendet `stream_state { live: false }`, vergisst den Kanal.
    - `tick(now)`: je Kanal mit `watch: 'full'`: beim ersten Tick einer neuen Minute `presence` mit 80–100 % der Nutzer (per PRNG); alle `chatEveryMs` ein `chat` eines zufälligen Nutzers (`text` aus einer festen Liste von 5 Sätzen, `messageId` = `sim-<zähler>`); alle `followEveryMs` ein `follow`. Je Kanal mit `watch: 'state'`: nur alle 60 s `stream_state { live: true, viewers }`.
    - `sendChat` → `sent.push`, `{ ok: true, messageId: 'sim-sent-<n>' }`; `checkFollows` → alle `follows: true, since: '2026-01-01T00:00:00.000Z'`; `health` → je Kanal `ok: true`, `lastSignalAt` = letzter Tick; `close` → leert alles.

- [ ] **Step 1: Test schreiben**

```ts
it('start emits stream_state live, stop emits offline', ...);
it('emits presence once per minute with 80–100 % of the viewers, deterministic by seed', ...);  // zwei Adapter, gleicher Seed, gleiche Signale
it('emits chat every chatEveryMs with a message id and a user from the channel', ...);
it('state-only channels get no presence or chat', ...);
it('inject passes a signal through to the handler unchanged', ...);
it('sendChat records the message', ...);
```

- [ ] **Step 2: Test laufen lassen, er scheitert** (`npx vitest run test/ingest-simulator.test.ts`)
- [ ] **Step 3: Implementieren**
- [ ] **Step 4: Test laufen lassen, er besteht**
- [ ] **Step 5: Commit** `feat(ingest): Simulator-Adapter`

---

### Task 5: Kanalverzeichnis, Dispatcher, Worker-Komposition

**Files:**
- Create: `src/ingest/directory.ts`, `src/ingest/dispatch.ts`, `src/ingest/worker.ts`
- Test: `test/ingest-directory.test.ts`, `test/ingest-worker.test.ts`

**Interfaces:**
- Consumes: Tasks 1–4; `scheduleLoop` aus `scheduler/loop.ts`; `Runtime`.
- Produces:
  - `directory.ts`:
    - `interface ChannelSource { list(): Promise<{ pid: Pid; twitchId: string; watch: 'state' | 'full' }[]> }`
    - `pgChannelSource(pool: pg.Pool): ChannelSource` – SQL: `accounts a JOIN identities i USING (pid) JOIN channel_tokens t USING (pid) WHERE a.channel_connected AND NOT a.deleted AND t.status = 'ok'`; `watch = 'full'`, wenn `EXISTS (SELECT 1 FROM giveaways g WHERE g.status = 'open' AND g.channels @> to_jsonb(ARRAY[a.pid::text]))`, sonst `'state'`.
    - `DIRECTORY_INTERVAL_MS = 30_000`
    - `class Directory { constructor(o: { source: ChannelSource; adapter: IngestAdapter; workers: number; index: number; log: BusLogger }); refresh(): Promise<{ started: number; stopped: number }>; byTwitchId(id: string): ChannelRef | undefined; current(): ChannelRef[] }` – `owned = shardOf(pid, workers) === index`; `refresh` ruft `adapter.start` mit allen neuen oder geänderten Refs (Vergleich `twitchId`, `watch`, `owned`) in einem Aufruf und `adapter.stop` je weggefallenem Ref; wirft `source.list`, bleibt der alte Stand, Fehler geht an `log.error`.
  - `dispatch.ts`:
    - `interface GiveawayLookup { openGiveawaysFor(channel: Pid): Promise<string[]> }`
    - `pgGiveawayLookup(pool: pg.Pool): GiveawayLookup` – `SELECT id FROM giveaways WHERE status = 'open' AND channels @> $1::jsonb ORDER BY id` mit `JSON.stringify([channel])`.
    - `interface DispatchResult { giveaways: number; rejected: number; failed: number }`
    - `dispatcher(o: { rt: Runtime; lookup: GiveawayLookup; status: StatusBuffer; log: BusLogger; now: () => Date }): { handle(b: SignalBundle): Promise<DispatchResult> }` – notiert im `StatusBuffer` `lastSignalAt = now`, bei Anwesenheit `lastPresenceAt = now, chatters = presence.length`; je Giveaway `rt.bus.execute(rt.handlers.applySignals, { giveawayId, channel, minute, presence, chat, follows }, { actor: 'system:ingest', correlationId: randomUUID(), now })`; Ablehnung → `rejected++` (kein Log, der Bus schreibt `access_log`); Wurf → `failed++` + `log.error`, weiter mit dem nächsten Giveaway.
  - `worker.ts`:
    - `interface IngestWorkerOptions { adapter: IngestAdapter; source: ChannelSource; lookup: GiveawayLookup; rt: Runtime; pool: pg.Pool; workers: number; index: number; log: BusLogger; now?: () => Date; directoryIntervalMs?: number; tickMs?: number /*1_000*/; onTick?: (now: Date) => void | Promise<void> }` – `onTick` ist der Takt des Adapters: `main.ts` reicht `sim.tick` (Task 4) oder `adapter.pollPresence` bei voller Minute (Task 8) durch.
    - `createIngestWorker(o: IngestWorkerOptions): { start(): Promise<void>; stop(): Promise<void>; tick(now: Date): Promise<void>; refresh(): Promise<void> }` – `start`: `adapter.onSignal(handle)`, erster `refresh`, Schleifen `scheduleLoop(refresh, directoryIntervalMs)` und `scheduleLoop(tick, tickMs)`. `handle(s)`: `stream_state` → `status.note(pid, { live, viewers, lastSignalAt: now, worker: index })`; sonst `bundler.add(s)` und `status.note(pid, { lastSignalAt: now })`. `tick(now)`: erst `await o.onTick?.(now)`, dann `bundler.tick(now)`, dann je `adapter.health()` mit `ok: false` `status.note(pid, { problem })`, mit `ok: true` `problem: null`, dann `status.flush(pool, now)`. `stop`: Schleifen stoppen, `bundler.drain()`, `status.flush`, `adapter.close()`.

- [ ] **Step 1: Tests schreiben**

```ts
// ingest-directory.test.ts (freshDb + setupApi/attachAccounts: Konto anlegen, Kanal verbinden, Giveaway öffnen)
it('pgChannelSource lists connected channels with a valid token, watch full only with an open giveaway', ...);
it('Directory starts new refs, restarts changed ones and stops removed ones, only owned ones poll', ...);  // Fake-Adapter mit Spies; workers 2 → genau ein Index owned je pid
it('a failing source keeps the last state and logs', ...);
// ingest-worker.test.ts (freshDb, setupGiveaway + attachAccounts, SimulatorAdapter)
it('presence of a simulator channel reaches apply_signals of every open giveaway with that channel', ...);  // 2 Giveaways offen mit P1, 1 pausiert → Bus-Spy: 2 Aufrufe mit actor system:ingest, rejected 0
it('a channel without open giveaway only updates channel_status', ...);
it('stream_state updates live, viewers and last_signal_at without any command', ...);
it('adapter health problems land in channel_status.problem and clear again', ...);
it('stop drains pending bundles', ...);
```

- [ ] **Step 2: Tests laufen lassen, sie scheitern** (`npx vitest run test/ingest-directory.test.ts test/ingest-worker.test.ts`)
- [ ] **Step 3: Implementieren**
- [ ] **Step 4: Tests laufen lassen, sie bestehen**
- [ ] **Step 5: Commit** `feat(ingest): Kanalverzeichnis, Dispatcher, Worker`

---

### Task 6: Helix-Client, App-Token, Kanal-Token-Provider

**Files:**
- Create: `src/ingest/twitch/helix.ts`, `src/ingest/twitch/tokens.ts`, `test/fixtures/twitch/get-chatters.json`, `get-chatters-page2.json`, `get-streams.json`, `followers.json`, `send-chat.json`, `conduits.json`, `subscriptions.json`
- Test: `test/ingest-helix.test.ts`, `test/ingest-tokens.test.ts`

**Interfaces:**
- Consumes: `TwitchAuthClient`, `TwitchError`, `HELIX_BASE`, `ID_BASE` aus `identity/twitch.ts`; `loadChannelToken`, `updateChannelToken`, `markTokenInvalid` aus `identity/tokens.ts`; `withBackoff`.
- Produces:
  - `helix.ts`:
    - `type HelixErrorCode = 'helix_unauthorized' | 'helix_forbidden' | 'helix_ratelimited' | 'helix_unreachable' | 'helix_error'`
    - `class HelixError extends Error { constructor(readonly code: HelixErrorCode, readonly status: number | null, readonly retryAfterMs: number | null) }` – 401 → unauthorized, 403 → forbidden, 429 → ratelimited (`retryAfterMs` aus `Ratelimit-Reset`), Netzfehler → unreachable, sonst error. `retryable(e): boolean` = ratelimited, unreachable, 5xx.
    - `interface AppTokenSource { get(): Promise<string>; invalidate(): void }`
    - `appTokenSource(o: { clientId: string; clientSecret: string; fetch?: typeof fetch; idBase?: string; now?: () => Date }): AppTokenSource` – `POST ${idBase}/oauth2/token` `grant_type=client_credentials`, cached bis `expires_in - 60 s`.
    - `interface StreamInfo { userId: string; live: true; viewers: number; startedAt: string }`
    - `interface HelixClient { getStreams(userIds: string[]): Promise<StreamInfo[]>; getChatters(broadcasterId: string, userToken: string): Promise<SignalUser[]>; isFollower(broadcasterId: string, userId: string, userToken: string): Promise<FollowResult>; sendChatMessage(broadcasterId: string, senderId: string, text: string): Promise<SendResult>; listConduits(): Promise<{ id: string; shardCount: number }[]>; createConduit(shardCount: number): Promise<{ id: string; shardCount: number }>; updateConduit(id: string, shardCount: number): Promise<void>; bindShard(conduitId: string, shardId: number, sessionId: string): Promise<void>; subscribe(type: string, version: string, condition: Record<string, string>, conduitId: string): Promise<'created' | 'exists'> }`
    - `helixClient(o: { clientId: string; appToken: AppTokenSource; fetch?: typeof fetch; helixBase?: string; sleep?: (ms: number) => Promise<void> }): HelixClient` – jeder Aufruf mit `withBackoff(…, { retryOn: retryable })`; 401 mit App-Token → `appToken.invalidate()` und ein zweiter Versuch; `getStreams` in Blöcken zu 100 (`user_id` mehrfach); `getChatters` `first=1000` und Seiten über `pagination.cursor`, Felder `user_id`, `user_login`, `user_name` → `{ id, login, displayName }`; `isFollower` `GET /channels/followers?broadcaster_id&user_id` → `data[0]?.followed_at`; `sendChatMessage` `POST /chat/messages` `{ broadcaster_id, sender_id, message }` → `data[0].is_sent`, sonst `{ ok: false, reason: drop_reason.message }`; `subscribe` → 409 = `'exists'`.
  - `tokens.ts`:
    - `TOKEN_REFRESH_BEFORE_SEC = 300`
    - `interface ChannelTokenProvider { accessTokenFor(pid: Pid): Promise<string | null>; invalidate(pid: Pid): Promise<void> }`
    - `channelTokenProvider(o: { pool: pg.Pool; key: Buffer; auth: TwitchAuthClient; now: () => Date; log: BusLogger }): ChannelTokenProvider` – `loadChannelToken`; keine Zeile oder `status: 'invalid'` → `null`; `expiresAt - now < 300 s` → `auth.refresh`, Erfolg → `updateChannelToken`, `TwitchError('twitch_denied')` → `markTokenInvalid` + `null`, `twitch_unreachable`/`twitch_invalid` → bisheriges Token, wenn noch nicht abgelaufen, sonst `null`; Refresh je pid nie parallel (Promise-Map). `invalidate` → `markTokenInvalid`.
  - Fixtures: JSON-Dateien im Format der Twitch-Doku (`data`, `pagination`, `total`), Logins durch `alice`, `bob`, `carol` ersetzt, IDs `12345`, `67890`, `11111`.

- [ ] **Step 1: Tests schreiben** (Stub-`fetch`, der Aufrufe mitschreibt und Fixtures liefert; `sleep` als Spy)

```ts
// ingest-helix.test.ts
it('appTokenSource fetches once and caches until shortly before expiry', ...);
it('getChatters follows the pagination cursor and maps the users', ...);
it('getStreams splits 150 ids into two requests', ...);
it('retries 5xx and network errors with backoff, gives up after 3 with HelixError', ...);  // sleep: [1000, 2000]
it('401 with the app token invalidates it and retries once', ...);
it('429 waits Ratelimit-Reset', ...);
it('sendChatMessage maps is_sent false to the drop reason', ...);
it('subscribe treats 409 as exists', ...);
// ingest-tokens.test.ts (freshDb, saveChannelToken)
it('returns the stored token while it is fresh', ...);
it('refreshes a token that expires within 5 minutes and stores the new one', ...);
it('twitch_denied on refresh marks the token invalid and returns null, later calls do not call twitch again', ...);
it('twitch_unreachable keeps the old token until it is expired', ...);
```

- [ ] **Step 2: Tests laufen lassen, sie scheitern** (`npx vitest run test/ingest-helix.test.ts test/ingest-tokens.test.ts`)
- [ ] **Step 3: Implementieren**
- [ ] **Step 4: Tests laufen lassen, sie bestehen**
- [ ] **Step 5: Commit** `feat(ingest): Helix-Client, App-Token, Kanal-Token-Refresh`

---

### Task 7: EventSub-Socket und Conduit

**Files:**
- Create: `src/ingest/twitch/eventsub.ts`, `src/ingest/twitch/conduit.ts`, `test/fixtures/twitch/eventsub-welcome.json`, `eventsub-keepalive.json`, `eventsub-reconnect.json`, `eventsub-chat.json`, `eventsub-online.json`, `eventsub-offline.json`, `eventsub-follow.json`, `eventsub-revocation.json`
- Test: `test/ingest-eventsub.test.ts`, `test/ingest-conduit.test.ts`

**Interfaces:**
- Consumes: `HelixClient` aus Task 6; `ChannelRef`, `Signal` aus Task 1.
- Produces:
  - `eventsub.ts`:
    - `EVENTSUB_URL = 'wss://eventsub.wss.twitch.tv/ws'`, `KEEPALIVE_GRACE_SEC = 10`
    - `type EventSubMessage = | { type: 'session_welcome'; sessionId: string; keepaliveSec: number } | { type: 'session_keepalive' } | { type: 'session_reconnect'; url: string } | { type: 'notification'; subscriptionType: string; event: Record<string, unknown> } | { type: 'revocation'; subscriptionType: string; status: string } | { type: 'unknown' }`
    - `parseMessage(raw: string): EventSubMessage` – nie werfen, Unlesbares → `unknown`.
    - `toSignal(m: Extract<EventSubMessage, { type: 'notification' }>, channelOf: (twitchId: string) => ChannelRef | undefined, botUserId: string): Signal | null` – `channel.chat.message` → `chat` (`chatter_user_id`, `chatter_user_login`, `chatter_user_name`, `message.text`, `message_id`; Nachrichten des Bots selbst → `null`); `stream.online` → `stream_state live: true`; `stream.offline` → `stream_state live: false`; `channel.follow` → `follow` (`user_id`, `user_login`, `user_name`, `followed_at`); unbekannter Broadcaster oder Typ → `null`. `at` = jetzt, injiziert über Parameter `now: () => Date` (vierter Parameter).
    - `interface SocketLike { send(data: string): void; close(): void; addEventListener(type: 'open' | 'message' | 'close' | 'error', fn: (ev: { data?: unknown; code?: number; reason?: string }) => void): void }` – Teilmenge des globalen `WebSocket`.
    - `class EventSubSocket { constructor(o: { url?: string; connect?: (url: string) => SocketLike /*Default: new WebSocket(url)*/; onSession: (sessionId: string) => Promise<void>; onMessage: (m: EventSubMessage) => void; log: BusLogger; setTimer?: typeof setTimeout; clearTimer?: typeof clearTimeout }); start(): Promise<void>; close(): Promise<void>; readonly sessionId: string | null }` – `start` verbindet und löst mit der ersten `session_welcome` auf (dann `onSession`); Keepalive-Timer `keepaliveSec + KEEPALIVE_GRACE_SEC`, Ablauf → neu verbinden mit `url`; `session_reconnect` → neue Verbindung zur `url`, nach deren Welcome die alte schließen, `onSession` erneut; `close`-Ereignis ohne `close()`-Aufruf → neu verbinden nach `withBackoff`-Wartezeiten (1 s, 2 s, 4 s, dann weiter 4 s).
  - `conduit.ts`:
    - `ensureConduit(helix: HelixClient, o: { workers: number; index: number; sleep: (ms: number) => Promise<void>; attempts?: number /*30*/ }): Promise<string>` – Worker 0: `listConduits`, keins → `createConduit(workers)`, eins mit anderer Shard-Zahl → `updateConduit`, liefert id. Andere Worker: alle 2 s `listConduits`, bis eines mit `shardCount >= workers` da ist, sonst nach `attempts` `Error('Kein Conduit. Starte Worker 0 zuerst.')`.
    - `subscribeChannel(helix: HelixClient, conduitId: string, ref: ChannelRef, botUserId: string): Promise<void>` – `watch: 'state'`: `stream.online` v1, `stream.offline` v1 (`broadcaster_user_id`); `watch: 'full'`: zusätzlich `channel.chat.message` v1 (`broadcaster_user_id`, `user_id: botUserId`) und `channel.follow` v2 (`broadcaster_user_id`, `moderator_user_id: broadcaster`). `'exists'` ist kein Fehler.

- [ ] **Step 1: Tests schreiben** (Fake-Socket mit `emit(type, data)`; `setTimer`/`clearTimer` über `vi.useFakeTimers`)

```ts
// ingest-eventsub.test.ts
it('parseMessage maps welcome, keepalive, reconnect, notification, revocation and garbage', ...);
it('toSignal maps chat, online, offline and follow fixtures to signals with the channel pid', ...);
it('toSignal drops an unknown broadcaster and the bots own messages', ...);
it('start resolves after welcome and calls onSession with the session id', ...);
it('reconnects when no keepalive arrives in time', ...);
it('session_reconnect opens the new url first, then closes the old socket', ...);
it('an unexpected close reconnects with backoff', ...);
// ingest-conduit.test.ts
it('worker 0 creates a conduit when none exists and resizes a wrong one', ...);
it('worker 1 waits for a conduit and gives up after attempts', ...);
it('subscribeChannel subscribes state channels to online/offline and full channels additionally to chat and follow', ...);
```

- [ ] **Step 2: Tests laufen lassen, sie scheitern** (`npx vitest run test/ingest-eventsub.test.ts test/ingest-conduit.test.ts`)
- [ ] **Step 3: Implementieren**
- [ ] **Step 4: Tests laufen lassen, sie bestehen**
- [ ] **Step 5: Commit** `feat(ingest): EventSub-WebSocket und Conduit`

---

### Task 8: Twitch-Adapter

**Files:**
- Create: `src/ingest/twitch/adapter.ts`
- Test: `test/ingest-twitch-adapter.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 6, 7.
- Produces:
  - `PRESENCE_INTERVAL_MS = 60_000`
  - `interface TwitchAdapterOptions { helix: HelixClient; tokens: ChannelTokenProvider; botUserId: string; workers: number; index: number; socket: (o: { onSession: (id: string) => Promise<void>; onMessage: (m: EventSubMessage) => void }) => Pick<EventSubSocket, 'start' | 'close'>; sleep: (ms: number) => Promise<void>; now: () => Date; log: BusLogger }`
  - `twitchAdapter(o: TwitchAdapterOptions): IngestAdapter & { pollPresence(now: Date): Promise<void> }`:
    - `start(channels)`: merkt alle Refs (Map nach `twitchId` und `pid`); beim ersten Aufruf Socket starten, `onSession` → `ensureConduit` (einmal) + `bindShard(conduitId, index, sessionId)` + für jeden `owned` Ref `subscribeChannel`; spätere `start`-Aufrufe abonnieren neue oder geänderte `owned` Refs sofort. Der Adapter hat keine eigene Schleife: `pollPresence(now)` ruft der Worker über `onTick` (Task 5), wenn `now` auf einer vollen Minute liegt.
    - `pollPresence(now)`: `getStreams` für alle `owned` Refs → je Ref `stream_state { live, viewers }` (`live: false` für Refs ohne Treffer); für `owned` + `full` + live: Token über `tokens.accessTokenFor(pid)`, `null` → `health` des Kanals `problem: 'token_invalid'`, kein Aufruf; sonst `getChatters` → `presence { minute: minuteOf(now), users }`; `HelixError('helix_unauthorized')` → `tokens.invalidate(pid)`; andere `HelixError` nach Backoff → `problem: 'twitch_error'`, Erfolg löscht `problem`. Kanäle laufen parallel in Gruppen zu 20 (`Promise.all` je Gruppe).
    - `onMessage`: `notification` → `toSignal` → Handler; `revocation` → `log.error` + `problem: 'revoked'` für den Kanal.
    - `stop(ref)`: vergisst den Ref (Abonnements bleiben bei Twitch, Benachrichtigungen werden ab jetzt verworfen).
    - `sendChat(ref, text)`: `helix.sendChatMessage(ref.twitchId, botUserId, text)`.
    - `checkFollows(ref, userIds)`: Token des Streamers, je `userId` `isFollower`, `null`-Token → alle `follows: false, since: null` und `problem: 'token_invalid'`.
    - `health()`: je Ref `{ channel, ok: problem === null, lastSignalAt, problem }`.
    - `close()`: Socket schließen.

- [ ] **Step 1: Test schreiben** (Fake-`HelixClient` als Objekt aus `vi.fn()`, Fake-Socket, Fake-Token-Provider)

```ts
it('start binds the shard after the session and subscribes only owned channels', ...);
it('pollPresence emits stream_state from getStreams and presence from getChatters for live full channels', ...);
it('pollPresence skips channels without a valid token and reports token_invalid in health', ...);
it('a HelixError after backoff sets twitch_error in health, the next poll clears it on success', ...);
it('helix_unauthorized on getChatters invalidates the channel token', ...);
it('a chat notification becomes a chat signal, an unknown broadcaster is dropped', ...);
it('sendChat uses the bot as sender', ...);
```

- [ ] **Step 2: Test laufen lassen, er scheitert** (`npx vitest run test/ingest-twitch-adapter.test.ts`)
- [ ] **Step 3: Implementieren**
- [ ] **Step 4: Tests laufen lassen, sie bestehen** (`npx vitest run test/ingest-twitch-adapter.test.ts test/ingest-worker.test.ts`)
- [ ] **Step 5: Commit** `feat(ingest): Twitch-Adapter mit EventSub und Anwesenheits-Polling`

---

### Task 9: Prozess `ingest`, Bot-Anmeldung, Skripte, Doku

**Files:**
- Create: `src/ingest/main.ts`
- Modify: `src/api/auth.ts`, `package.json`, `README.md`, `NEW_DESIGN.md` (nur 3.4: Zeile `ingest` um „liest Lesetabellen“ und `identity` ergänzen, keine Regeländerung)
- Test: `test/api-auth.test.ts`, `test/ingest-main.test.ts`

**Interfaces:**
- Consumes: alles aus Tasks 1–8; `loadConfig`, `loadTokenKey`, `createPool`, `runMigrations`, `createRuntime`, `attachAccounts`, `identityResolver`, `denyUsers`, `RedisPublisher`.
- Produces:
  - `auth.ts`: `BOT_SCOPES = ['user:bot', 'user:read:chat', 'user:write:chat'] as const`; `type Flow = 'login' | 'connect' | 'bot'`; `GET /auth/twitch/bot` startet den Fluss `bot` mit `BOT_SCOPES`; im Callback läuft `bot` wie `login` (Anmeldung + Sitzung), Rücksprung `/`.
  - `main.ts`: `buildIngest(config: Config, deps: { pool: pg.Pool; rt: Runtime; tokenKey: Buffer; log: BusLogger; fetch?: typeof fetch }): { worker: ReturnType<typeof createIngestWorker>; adapter: IngestAdapter }` – wählt nach `config.ingestAdapter`: `simulator` → `SimulatorAdapter({ viewersPerChannel: config.ingestSimViewers, seed: config.ingestSimSeed })` mit `onTick: sim.tick`; `twitch` → `twitchBotUserId` leer → `ConfigError(['TWITCH_BOT_USER_ID: Pflichtwert fehlt, wenn INGEST_ADAPTER=twitch.'])`, sonst `appTokenSource`, `helixClient`, `channelTokenProvider`, `twitchAdapter` mit `socket: (h) => new EventSubSocket({ ...h, log })`, `onTick: (now) => now.getSeconds() === 0 ? adapter.pollPresence(now) : undefined`. `main()`: Config, Token-Schlüssel, Migrationen wie in `scheduler/main.ts`, `createRuntime({ auth: denyUsers, identities: identityResolver(), … })`, `attachAccounts`, `buildIngest`, `worker.start()`, SIGTERM/SIGINT → `worker.stop()`, Pool und Redis schließen.
  - `package.json`: `"dev:ingest": "tsx watch src/ingest/main.ts"`, `"start:ingest": "node dist/ingest/main.js"`.
  - README: Abschnitt „Prozesse“ um `ingest` ergänzen (Adapter, Worker-Variablen, Bot einrichten: „Mit dem Bot-Konto bei Twitch anmelden, `PUBLIC_URL/auth/twitch/bot` öffnen, alle Rechte bestätigen, die Twitch-ID des Bot-Kontos als `TWITCH_BOT_USER_ID` setzen.“), Begriffe-Tabelle um `Bündel`, `Conduit`, `Shard`, `Plattform-Bot`, `Signalqualität` ergänzen; `.env.example` entsprechend.

- [ ] **Step 1: Tests schreiben**

```ts
// api-auth.test.ts: ergänzen
it('GET /auth/twitch/bot starts a login flow with the bot scopes and the callback signs the bot in', ...);
// ingest-main.test.ts
it('buildIngest with simulator wires sim.tick and needs no bot id', ...);
it('buildIngest with twitch and empty TWITCH_BOT_USER_ID throws a ConfigError naming the variable', ...);
```

- [ ] **Step 2: Tests laufen lassen, sie scheitern** (`npx vitest run test/api-auth.test.ts test/ingest-main.test.ts`)
- [ ] **Step 3: Implementieren**
- [ ] **Step 4: Alles prüfen** (`npm run typecheck`, `npm run lint`, `npm test`, `npm run build`; dann `INGEST_ADAPTER=simulator npm run dev:ingest -w packages/server` gegen den Dev-Stack kurz starten und im Log „Verzeichnis aktualisiert“ sehen)
- [ ] **Step 5: Commit** `feat(ingest): Prozess ingest, Bot-Anmeldung, Doku Teilprojekt 4`

---

## Selbstprüfung gegen die Spec

- 3.1 ingest-worker, Bündelung je Kanal und Minute → Tasks 1, 5, 9.
- 3.3/3.4 ein Schreibweg, Ingest sendet nur Befehle → Task 3 (Befehl), Task 1 (Lint), Entscheidung 1 (Betriebsdaten begründet).
- 6.1 Anwesenheit je Minute je Live-Kanal → Task 8; Ereignisse `watch_credited` bleiben Teilprojekt 5.
- 10.1 Adapter-Schnittstelle, zwei Adapter → Tasks 1, 4, 8.
- 10.2 EventSub Chat über Conduit, Get Chatters, stream.online/offline, Follows, Send Chat Message, Token-Refresh, Hash-Verteilung → Tasks 6, 7, 8.
- 11.2 Statusblock je Kanal und Warnungen → Task 2 (Daten und Sicht), Tasks 5, 8 (Befüllung).
- 12.1 Backoff, Warnung nach 3 Versuchen → Tasks 1, 6, 8.
- 12.2 Simulator + aufgezeichnete Payloads → Tasks 4, 6, 7.
- 12.4 `last_seen_at` → Task 3.
- Offen für Teilprojekt 5: Ereignisse aus `ResolvedSignals`, Zählweise „ab erstem Erscheinen“ (Identität für Unbekannte), Chat-Cooldown über mehrere Worker, Chat-Ansagen (10.3) über `adapter.sendChat`.
