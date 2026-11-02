# Teilprojekt 5: Rahmen-Dienste + Kern A – Umsetzungsplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Aus den Signalen des Ingest entstehen Ereignisse: Zuschauzeit je Kanal und Minute, Chat-Bonus mit Cooldown, Boost mit Faktor und Zeitgeber, Anmeldung per Keyword, Zählweise „ab Anmeldung“ oder „ab erstem Erscheinen“ mit Löschfrist. Die Bedingungen (Follow, Mindestalter Konto, Mindestalter Follow, Anwesenheit) werden bei der Ziehung verbindlich geprüft. Kern A `watchtime` rechnet Sekunden in Coins um.

**Architecture:** Die Rahmen-Dienste schreiben Rahmen-Ereignisse in den Strom `giveaway:<id>` (`watch_credited`, `chat_credited`, `watch_corrected`, `boost_started`, `boost_ended`, `unregistered_purged`). Ein Kern bekommt davon genau die Ereignisse der Dienste, die er in `usesServices` nennt (`SERVICE_EVENTS` in `kernel-api`). `apply_signals.decide` erzeugt die Zuschauzeit- und Chat-Ereignisse rein aus Zustand und aufgelösten Signalen. `prepare` legt in der Befehls-Transaktion Identitäten für Unbekannte an (nur Zählweise „ab erstem Erscheinen“ oder Keyword) und liest die Signalqualität der Kanäle. Die Bedingungen prüft der Rahmen in `pre` der Ziehung über Helix (außerhalb der Sperre), `prepare` stellt sicher, dass der Topf unverändert ist. Kern A ist rein: Sekunden je `pid` und Kanal, Coins = ⌊Sekunden ÷ Coin-Basis⌋, Topf = alle mit mindestens 1 Coin. Unangemeldete `pid`s löscht der Scheduler per Befehl `purge_unregistered` nach Schließen + Frist.

**Tech Stack:** TypeScript, Node 24, pg, zod, Vitest, Testcontainers. Keine neuen Abhängigkeiten.

**Spec:** `NEW_DESIGN.md` Abschnitte 4, 5.2, 5.3, 6.1–6.5, 7.2, 8.1, 11.3 (Daten), 12.1, 12.2, 12.4, 14 (Punkt 5), 15.3 (nur die Felder, die Kern A und die Zählweise später brauchen).

## Global Constraints

- Jede Zustandsänderung läuft durch `CommandBus.execute`. `identities` wird nur in `prepare` oder in Projektoren innerhalb der Befehls-Transaktion geschrieben (CLAUDE.md).
- `events` ist append-only. Korrektur = neues Ereignis (`watch_corrected`).
- Payloads enthalten nur `pid`, nie Twitch-Name oder Twitch-ID (`assertNoTwitchIdentity`). Auch keine Chat-Texte.
- Ein Kern importiert nur `kernel-api`. `kernel-api` importiert nichts. Kern-Ereignistypen tragen das Präfix `<kernelId>_`.
- Neue Spalten nur über `packages/server/migrations/006_services.sql`.
- Formatänderung eines Ereignistyps: `version` erhöhen, Upcaster `n → n+1`, Test dazu. Hier: `giveaway_created` und `giveaway_settings_changed` auf v2.
- Kern A: Coins = Zuschauzeit ÷ Coin-Basis, abgerundet. Topf = alle mit mindestens 1 Coin, Gewicht = Coins, `drawMode: 'weighted'`. Coin-Basis Default 2 h, Bereich 1 min – 100 h (Spec 8.1).
- Chat-Bonus Defaults: +2 s ab 4 Wörtern, 10 s Cooldown (Spec 6.2). Ab- und anschaltbar, Werte bleiben beim Abschalten.
- Zuschauzeit: ein Ereignis je Giveaway, Kanal und Minute. Nur Kanäle, die im Giveaway sind und live sind. Während einer Pause zählt nichts (Spec 6.1, 7.1).
- Boost: Faktor und Dauer, gehört einem Giveaway, startet nur mit mindestens einem Kanal, der live ist und Signale liefert. Stoppen geht immer. Das Ende setzt der Scheduler per Befehl (Spec 6.3).
- Bedingungen: alle optional je Giveaway, der Kern nennt `supportedGates`. Verbindlich bei der Ziehung, per Helix live. Helix nicht erreichbar → Ziehung bricht ab, Grund wird angezeigt, kein Ereignis (Spec 6.5, 12.1).
- Unangemeldete `pid` (Zählweise „ab erstem Erscheinen“): Schließen + 7 Tage (einstellbar) → Zuordnung entfernt (Spec 12.4).
- UI- und Fehlertexte deutsch, aktiv, höchstens 20 Wörter, was passiert ist + was zu tun ist.
- Tests nur gegen Testcontainers. Kein Netz in Tests.
- Vor dem Typecheck ganze Aufgaben fertig schreiben, dann `npm run typecheck`, `npm run lint`, `npm test` einmal je Aufgabe.

## Entscheidungen, die die Spec offen lässt (meine Festlegungen)

1. **Ereignisform:** `watch_credited { minute, channel, factor, entries: [{pid, sec}] }`. Die Spec skizziert `kanal` und `faktor` je Eintrag. Ein Bündel kommt je Kanal, der Boost gilt je Giveaway, darum stehen beide einmal am Ereignis. `chat_credited { minute, channel, factor, entries: [{pid, sec, lastAt}] }`, `lastAt` = Zeitpunkt der letzten belohnten Nachricht, damit der Reducer den Cooldown aus dem Journal kennt. `sec` ist die Rohzeit, der Kern multipliziert mit `factor`.
2. **Umkehrung der Gutschriften:** `watch_credited` und `chat_credited` sind `compensate`. Das Gegen-Ereignis ist `watch_corrected { channel, entries: [{pid, sec}] }` mit negierten wirksamen Sekunden (`-sec·factor`). `watch_corrected` ist selbst `compensate` (negiert) und braucht einen Grund. Der Befehl `correct_watch` schreibt es für den Streamer (Spec 15.6 „Korrektur über Zeit-Korrektur“).
3. **Kern A hält einen Topf je pid und Kanal** (wirksame Sekunden). Chat-Bonus und Zuschauzeit landen in derselben Zahl wie im Altsystem (Spec 15.3). Der Kern bekommt alle Ereignisse der Dienste `watchtime` und `chatBonus` über `SERVICE_EVENTS`. `participant_registered`/`participant_withdrawn` bekommt wie bisher jeder Kern.
4. **Rahmen-Zustand lernt Dienste kennen:** `seen` (pid → Kanäle mit Gutschrift, für Anwesenheitsbedingung und Löschfrist), `watchMinutes` (Kanal → letzte gebuchte Minute, gegen doppelte Bündel), `chatLast` (pid → `lastAt`), `boost`, `closedAt`, `purgedAt`. `FRAMEWORK_REDUCER_VERSION` steigt auf 5.
5. **Einstellungen je Giveaway:** `counting: 'registered' | 'first_seen'` (Default `registered`), `purgeDays` 1–90 (Default 7), `keyword` (null oder ein Wort ohne Leerzeichen, 2–32 Zeichen, Default null), `chatBonus: { enabled, sec 1–60, minWords 1–20, cooldownSec 1–600 }` (Default an, 2, 4, 10). Alle in `GiveawaySettings`, änderbar wie andere Regeln (wirkt ab jetzt). Alte Ereignisse bekommen die Defaults per Upcaster v2, der auch `legal: null` nachzieht (vertagter Punkt aus Teilprojekt 3).
6. **Zählweise „ab Anmeldung“:** Unbekannte Twitch-Nutzer fallen weg, außer sie schreiben das Keyword. „Ab erstem Erscheinen“: `prepare` legt eine Identität nur für Unbekannte an, die in diesem Befehl eine Anmeldung oder Gutschrift bekommen (`planSignals` rechnet mit Platzhalter-pids vor, Korrektur nach Review, 2026-11-02: Spec 6.1 „Für andere entsteht keine pid“). `first_seen` gibt es nur für Kerne mit Dienst `watchtime`. Unangemeldet = in `seen`, nicht in `registered`.
7. **Keyword-Anmeldung:** Erstes Wort der Nachricht gleich Keyword, Groß-/Kleinschreibung egal. Dieselben Regeln wie `register` (Zustand Offen, nicht schon angemeldet, `kernel.gateRegistration`). Ereignis `participant_registered` im selben Befehl wie die Gutschriften, Akteur `system:ingest`. Die Anmeldung hat Vorrang vor der Gutschrift derselben Minute.
8. **Chat-Cooldown über mehrere Worker:** Nachrichten werden nach `at` sortiert, belohnt nur, wenn `at − chatLast[pid] ≥ cooldown`. Zwei Bündel derselben Minute laufen nacheinander durch die Stromsperre, das zweite sieht den Stand des ersten. Ein Bündel mit älteren Nachrichten bekommt darum weniger Bonus, nie mehr.
9. **Live-Wissen des Rahmens:** `ChannelActivity.active(db, channels, now)` liefert Kanäle mit `channel_status.live = true` und `last_signal_at ≥ now − 2 min`. Die Umsetzung liegt beim Ingest (`ingest/channel-status.ts`), die Schnittstelle im Rahmen wie `IdentityResolver`. Chat-Bonus zählt nur für aktive Kanäle, der Boost startet nur mit mindestens einem aktiven Kanal. Anwesenheit setzt live voraus (der Adapter pollt nur Live-Kanäle). Default der Runtime: nichts aktiv.
10. **Boost:** Faktor ganzzahlig 2–10, Dauer 60 s – 24 h. Gilt für eine Minute, wenn `minute < until` und `since < minute + 60 s`. Läuft über eine Pause hinweg weiter ab. `boost_started` ist `compensate` (→ `boost_ended`), `boost_ended` ist `none` („Ein beendeter Boost bleibt beendet. Starte einen neuen Boost.“). Zeitgeber-Zeilen des Rahmens tragen `command.type = 'framework:stop_boost'`, der Scheduler ruft dafür den Rahmen-Befehl statt `kernel_command`. Kern-Befehlstypen dürfen keinen Doppelpunkt enthalten.
11. **Bedingungen:** `GateConfig` ist eine Union: `follow { mode: 'all' | 'min' | 'channel', min?, channel? }`, `account_age { days }`, `follow_age { days }`, `presence { minChannels }`. `follow_age` zählt nur Follows, die mindestens `days` alt sind, und wendet darauf die Follow-Regel an (ohne Follow-Regel: mindestens ein Kanal). Die Auswertung ist rein (`evaluateGates`), die Fakten holt ein `GateChecker`. Ein Teilnehmer ohne Identität (gelöscht) fällt mit Grund `identity_deleted` heraus. Fehlt ein Streamer-Token oder antwortet Helix nicht, bricht die Ziehung ab, kein Ereignis.
12. **Anmeldung als eingebaute Bedingung:** Nutzt der Kern den Dienst `registration`, filtert der Rahmen vor der Ziehung alle `pid`s heraus, die nicht angemeldet sind (Grund `not_registered`). Kern A legt darum alle mit Coins in den Topf (Spec 8.1), gewinnen können nur Teilnehmer (Glossar).
13. **Löschfrist:** Befehl `purge_unregistered` je Giveaway (Akteur `system:scheduler`, stündlich aus der Wartung) → Ereignis `unregistered_purged { pids }`, Umkehrart `none`. Gelöscht wird nur eine `pid` ohne Konto, die nirgends angemeldet oder Gewinner ist (auch nicht in abgeschlossenen Giveaways, Spec 7.3) und in keinem anderen laufenden Giveaway gesehen wurde (Korrektur nach Review, 2026-11-02). Die Zeile in `identities` entfernt ein Projektor im Modul `identity`. Zusätzlich darf `delete_account` vom Scheduler eine Identität ohne Konto-Strom löschen (Keyword-Anmelder ohne Login nach 12 Monaten), sonst bliebe sie ewig.
14. **Chat-Ansagen (10.3) und die laufende Anzeige des Bedingungsstatus (6.5) kommen mit den Oberflächen (Teilprojekt 8).** Die KI-Bewertung des Chat-Bonus hängt am Team (Schlüssel je Team) und kommt mit Teilprojekt 7. Follow-Signale aus dem Bündel bleiben ungenutzt, verbindlich ist die Prüfung bei der Ziehung.
15. **`prepare` bekommt den Zustand** als fünften Parameter (`prepare(c, cmd, ctx, pre, state)`), damit `apply_signals` nicht ein zweites Mal den Strom lädt. Bestehende Handler bleiben unverändert.

## Review Focus

1. Ein zweites Bündel für dieselbe (Kanal, Minute) mit Anwesenheit darf keine zweite Zuschauzeit buchen. Test in Aufgabe 3.
2. In der Zählweise „ab Anmeldung“ bekommt ein unbekannter Schreiber nur dann eine Identität, wenn er das Keyword schreibt. Ein anderer unbekannter Schreiber hinterlässt keine Zeile in `identities`. Test in Aufgabe 3.
3. Ist `boost.until` vorbei und der Scheduler noch nicht gelaufen, bucht `apply_signals` mit Faktor 1. Test in Aufgabe 3.
4. Eine Ziehung mit Follow-Bedingung und ungültigem Streamer-Token bricht mit Grund ab und schreibt kein Ereignis. Test in Aufgabe 5.
5. Die Löschung entfernt nie eine `pid`, die ein Konto hat oder in einem anderen laufenden Giveaway steht. Test in Aufgabe 6.

---

## Dateistruktur

```
packages/server/migrations/006_services.sql                 giveaways: counting, purge_days, closed_at, purged_at, boost; giveaway_participants: seen
packages/server/src/kernel-api/index.ts                     + FRAMEWORK_EVENTS (credited, corrected), SERVICE_EVENTS, formatDuration
packages/server/src/kernels/watchtime/index.ts              Kern A
packages/server/src/framework/kernel-registry.ts            + watchtimeKernel, Verbot ':' in Befehlstypen, FRAMEWORK_REDUCER_VERSION 5
packages/server/src/framework/giveaway/gates.ts             GateConfig, checkGateConfig, GateFacts, evaluateGates, GateChecker, GateCheckError, noGates
packages/server/src/framework/giveaway/services.ts          Dienst-Ereignistypen (Schemas, Umkehrung), boostFactor, Defaults der Dienste
packages/server/src/framework/giveaway/state.ts             + settings-Felder, seen, watchMinutes, chatLast, boost, closedAt, purgedAt, Dienst-Routing an den Kern
packages/server/src/framework/giveaway/events.ts            settingsSchema v2 + Upcaster, Registrierung der Dienst-Ereignisse
packages/server/src/framework/giveaway/lifecycle.ts         checkSettings prüft neue Felder und GateConfig
packages/server/src/framework/giveaway/signals.ts           apply_signals erzeugt Ereignisse, IdentityResolver.create, ChannelActivity
packages/server/src/framework/giveaway/boost.ts             start_boost, stop_boost, correct_watch
packages/server/src/framework/giveaway/purge.ts             purge_unregistered, dueForPurge, purgeUnregisteredAll
packages/server/src/framework/giveaway/draw.ts              Bedingungen in pre, Topf-Vergleich in prepare, Anmeldefilter
packages/server/src/framework/giveaway/projectors.ts        giveaways + participants (Batch, seen), timers mit Rahmen-Zeitgebern
packages/server/src/framework/command-bus.ts                prepare(c, cmd, ctx, pre, state)
packages/server/src/framework/runtime.ts                    + activity, handlers startBoost, stopBoost, correctWatch, purgeUnregistered
packages/server/src/identity/identities.ts                  + createIdentities, findTwitchIdsByPids
packages/server/src/identity/resolver.ts                    + create
packages/server/src/identity/purge.ts                       unregisteredPurgeProjector
packages/server/src/identity/account/commands.ts            delete_account vom Scheduler ohne Konto-Strom
packages/server/src/identity/runtime.ts                     registriert unregisteredPurgeProjector
packages/server/src/ingest/channel-status.ts                + pgChannelActivity
packages/server/src/ingest/twitch/helix.ts                  + getUsers
packages/server/src/ingest/twitch/gates.ts                  helixGateChecker
packages/server/src/scheduler/timers.ts                     Rahmen-Zeitgeber
packages/server/src/scheduler/maintenance.ts                + purgeUnregisteredAll
packages/server/src/app/main.ts, scheduler/main.ts, ingest/main.ts   Verdrahtung activity, gates
packages/server/test/fixtures/twitch/get-users.json
README.md, CLAUDE.md                                        Stand Teilprojekt 5
```

---

### Task 1: Kern-Vertrag erweitern, Kern A `watchtime`

**Files:**
- Create: `src/kernels/watchtime/index.ts`
- Modify: `src/kernel-api/index.ts`, `src/framework/kernel-registry.ts`
- Test: `test/watchtime-kernel.test.ts`, `test/kernel-api.test.ts`, `test/kernel-registry.test.ts`

**Interfaces:**
- Produces (`kernel-api`):
  - `FRAMEWORK_EVENTS = { registered, withdrawn, watchCredited: 'watch_credited', chatCredited: 'chat_credited', watchCorrected: 'watch_corrected' } as const`
  - `SERVICE_EVENTS: Record<ServiceId, readonly string[]>` = `watchtime: [watch_credited, watch_corrected]`, `chatBonus: [chat_credited]`, `boost: []`, `registration: [participant_registered, participant_withdrawn]`
  - `interface CreditedPayload { minute: string; channel: Pid; factor: number; entries: { pid: Pid; sec: number }[] }`, `interface CorrectedPayload { channel: Pid; entries: { pid: Pid; sec: number }[] }` (Typen für Kerne, Schemas liegen im Rahmen)
  - `formatDuration(sec: number): string` → `'0 min'`, `'37 min'`, `'1 h 23 min'`, `'100 h'` (ganze Minuten, Stunden ohne Minuten wenn 0; negativ → `'0 min'`)
- Produces (`kernels/watchtime`):
  - `interface WatchtimeConfig { coinBaseSec: number }` (`kind: 'int'`, label `Coin-Basis`, default `7200`, min `60`, max `360000`, unit `sec`)
  - `interface WatchtimeState { sec: Record<Pid, Record<Pid, number>>; registered: Pid[] }` (Kanal → wirksame Sekunden, kann durch Korrektur negativ werden)
  - `secondsOf(state, pid): number` (Summe über Kanäle), `coinsOf(state, config, pid): number` = `Math.floor(Math.max(0, seconds) / coinBaseSec)`
  - `watchtimeKernel: Kernel<WatchtimeConfig, WatchtimeState>` mit `id: 'watchtime'`, `version: 1`, `label: 'Zuschauzeit + Follow'`, `supportedGates: ['follow', 'account_age', 'follow_age', 'presence']`, `usesServices: ['watchtime', 'chatBonus', 'boost', 'registration']`, `drawMode: 'weighted'`, `events: []`, `commands: []`; `reduce`: credited → `sec[pid][channel] += sec · factor`, corrected → `+= sec`, registered/withdrawn wie Kern B; `pool`: alle mit `coinsOf ≥ 1`, sortiert nach pid, `weight = coins`; `viewerView`: `registered`, `inPool`, `weight = coins`, `lines`: `Zuschauzeit` (formatDuration der Summe), `Coins` (Zahl), `Bis zum nächsten Coin` (formatDuration der fehlenden Sekunden); `display: { icon: '⏱', unit: 'Coins', beta: true, emptyPool: 'Niemand hat genug Zuschauzeit für einen Coin.', columns: [{ key: 'watch', label: 'Zuschauzeit' }, { key: 'coins', label: 'Coins' }] }`.
- Produces (`kernel-registry`): `defaultKernels()` registriert `instant` und `watchtime`; `register` wirft bei Befehlstyp mit `:` („Der Befehlstyp ${type} darf keinen Doppelpunkt enthalten. Der ist für Rahmen-Zeitgeber reserviert.“); `FRAMEWORK_REDUCER_VERSION = 5`.

- [ ] **Step 1: Tests schreiben**

```ts
// kernel-api.test.ts: ergänzen
it('SERVICE_EVENTS names the framework events per service', ...);     // watchtime → ['watch_credited','watch_corrected'], boost → []
it('formatDuration renders minutes and hours', ...);                  // 0→'0 min', 2220→'37 min', 4980→'1 h 23 min', 360000→'100 h', -5→'0 min'
// watchtime-kernel.test.ts (rein, wie instant-kernel.test.ts)
it('initialState is empty', ...);
it('credits sec times factor per pid and channel, sums channels for coins', ...);  // 3600 s ×1 + 3600 s ×2 auf zwei Kanälen = 10800 s → coins 1 bei Basis 7200
it('chat_credited adds to the same bucket', ...);
it('watch_corrected can take time away, coins never go below 0', ...);
it('pool lists everyone with at least one coin, weight = coins, sorted by pid', ...);
it('viewerView shows total time, coins and time to the next coin', ...);     // 5400 s, Basis 7200 → '1 h 30 min', '0', '30 min'
it('property: weights are non-negative integers and pool is deterministic', ...); // 200 zufällige Ereignisse mit mulberry32-Seed
it('config range 60..360000, default 7200', ...);
// kernel-registry.test.ts: ergänzen
it('defaultKernels has instant and watchtime', ...);
it('refuses a kernel command type with a colon', ...);
```

- [ ] **Step 2: Tests laufen lassen, sie scheitern** (`npx vitest run test/kernel-api.test.ts test/watchtime-kernel.test.ts test/kernel-registry.test.ts`)
- [ ] **Step 3: Implementieren**
- [ ] **Step 4: Tests laufen lassen, sie bestehen** (dazu `npx vitest run test/architecture.test.ts`)
- [ ] **Step 5: Commit** `feat(kernel): Kern A Zuschauzeit, Dienst-Ereignisse im Kern-Vertrag`

---

### Task 2: Einstellungen, Zustand, Dienst-Ereignisse, Upcaster v2, Migration, Lesetabellen

**Files:**
- Create: `migrations/006_services.sql`, `src/framework/giveaway/services.ts`, `src/framework/giveaway/gates.ts` (nur Typen, `checkGateConfig`)
- Modify: `src/framework/giveaway/state.ts`, `src/framework/giveaway/events.ts`, `src/framework/giveaway/lifecycle.ts`, `src/framework/giveaway/projectors.ts`
- Test: `test/giveaway-state.test.ts`, `test/lifecycle.test.ts`, `test/giveaway-projections.test.ts`, `test/event-types.test.ts`

**Interfaces:**
- Produces (`services.ts`):
  - `SERVICE_DEFAULTS = { counting: 'registered', purgeDays: 7, keyword: null, chatBonus: { enabled: true, sec: 2, minWords: 4, cooldownSec: 10 } }`
  - `chatBonusSchema`, `countingSchema` (zod), `KEYWORD_RE = /^\S{2,32}$/`
  - `creditedSchema` = `z.object({ minute: z.string().regex(MINUTE_RE), channel: z.uuid(), factor: z.int().min(1).max(10), entries: z.array(z.object({ pid: z.uuid(), sec: z.int().min(1).max(3600) })).min(1) })`; `chatCreditedSchema` = dasselbe mit `lastAt: z.iso.datetime()` je Eintrag; `correctedSchema` = `{ channel, entries: [{ pid, sec: z.int().refine(≠0) }] min 1 }`
  - `SERVICE_EVENT_TYPES = { boostStarted: 'boost_started', boostEnded: 'boost_ended', unregisteredPurged: 'unregistered_purged' }` (die drei Gutschrift-Typen kommen aus `FRAMEWORK_EVENTS`)
  - `registerServiceEvents(registry: EventTypeRegistry): void` – `watch_credited`/`chat_credited`: `compensate` → `watch_corrected` mit `sec: -(sec·factor)` je Eintrag; `watch_corrected`: `requiresReason`, `compensate` → negiert; `boost_started { factor: int 2..10, until: iso }`: `compensate` → `boost_ended {}` wenn `state.boost?.eventId === target.id`, sonst `reject('boost_not_active', 'Dieser Boost läuft nicht mehr.')`; `boost_ended {}`: `none` (Text aus Entscheidung 10); `unregistered_purged { pids: uuid[] }`: `none`, why `'DSGVO-Löschung. Die Zuordnung ist entfernt.'`
  - `boostFactor(boost: GiveawayState['boost'], minute: string): number` – 1 ohne Boost oder außerhalb (Entscheidung 10)
- Produces (`gates.ts`, Teil 1): `type GateConfig = | { id: 'follow'; mode: 'all' | 'min' | 'channel'; min?: number; channel?: Pid } | { id: 'account_age'; days: number } | { id: 'follow_age'; days: number } | { id: 'presence'; minChannels: number }`; `checkGateConfig(gate: unknown, channels: Pid[]): GateConfig | Rejection` – `days` 1–3650, `min` 1..channels.length, `channel` ∈ channels, `minChannels` 1..channels.length; Ablehnung `invalid_gate` mit Text je Fall („Die Follow-Bedingung braucht einen Kanal des Giveaways.“ …).
- Produces (`state.ts`): `GiveawaySettings` + `counting`, `purgeDays`, `keyword`, `chatBonus` (Typen aus services.ts); `GateConfig` aus gates.ts; `GiveawayState` + `seen: Record<Pid, { since: string; channels: Pid[] }>`, `watchMinutes: Record<Pid, string>`, `chatLast: Record<Pid, string>`, `boost: { factor: number; since: string; until: string; eventId: string } | null`, `closedAt: string | null` (Zeitpunkt des letzten Übergangs nach closed/cancelled, null nach open), `purgedAt: string | null`; Reducer verarbeitet die sechs Dienst-Ereignisse; `applyKernel` gibt dem Kern `registered`/`withdrawn`, die Ereignisse seiner `usesServices` (`SERVICE_EVENTS`) und seine eigenen Typen; `withLegal` entfällt.
- Produces (`events.ts`): `settingsSchema` mit den neuen Pflichtfeldern; `giveaway_created` und `giveaway_settings_changed` `version: 2` mit `upcasters: { 1 }` über `upcastSettingsV1(s): GiveawaySettings` (`legal ?? null`, Defaults aus `SERVICE_DEFAULTS`); `registerGiveawayEvents` ruft `registerServiceEvents`.
- Produces (`lifecycle.ts`): `checkSettings` prüft `counting`, `purgeDays` (1–90: „Die Löschfrist muss zwischen 1 und 90 Tagen liegen.“), `keyword` (null oder `KEYWORD_RE`: „Das Keyword ist ein Wort mit 2 bis 32 Zeichen ohne Leerzeichen.“), `chatBonus` (Schema: „Die Chat-Bonus-Regeln sind ungültig.“) und jede Bedingung über `checkGateConfig`; `create` füllt Defaults; `change_settings` mischt `chatBonus` feldweise.
- Produces (`006_services.sql`):
  ```sql
  ALTER TABLE giveaways
    ADD COLUMN counting TEXT NOT NULL DEFAULT 'registered' CHECK (counting IN ('registered','first_seen')),
    ADD COLUMN purge_days INTEGER NOT NULL DEFAULT 7,
    ADD COLUMN closed_at TIMESTAMPTZ,
    ADD COLUMN purged_at TIMESTAMPTZ,
    ADD COLUMN boost JSONB;
  ALTER TABLE giveaway_participants ADD COLUMN seen BOOLEAN NOT NULL DEFAULT false;
  CREATE INDEX giveaways_purge_due ON giveaways (closed_at) WHERE purged_at IS NULL AND counting = 'first_seen';
  ```
- Produces (`projectors.ts`): `giveawaysProjector` schreibt die fünf neuen Spalten; `participantsProjector` schreibt alle Zeilen (`registered ∪ pool ∪ seen`) in **einer** `INSERT … SELECT FROM unnest($2::uuid[], $3::bool[], $4::bool[], $5::float8[], $6::text[], $7::bool[])`-Anweisung, löscht übrige Zeilen in einer zweiten; `timersProjector` schreibt neben den Kern-Zeitgebern (nur Offen) den Rahmen-Zeitgeber `{ key: 'boost_end', dueAt: boost.until, command: { type: 'framework:stop_boost', args: {} } }`, solange `state.boost` gesetzt ist (jeder Zustand).

- [ ] **Step 1: Tests schreiben**

```ts
// giveaway-state.test.ts: ergänzen
it('watch_credited and chat_credited update seen, watchMinutes and chatLast', ...);
it('boost_started sets boost with eventId, boost_ended clears it, boostFactor respects until and since', ...);
it('closedAt is set on closed and cancelled, cleared on open, purgedAt on unregistered_purged', ...);
it('a kernel only receives events of its services', ...);       // plainKernel (nur registration) bekommt kein watch_credited, watchtime schon
it('v1 created and settings_changed payloads upcast to the defaults', ...);   // registry.upcast(rec mit typeVersion 1 ohne legal/counting) → settings vollständig
// event-types.test.ts: ergänzen
it('watch_credited inverse is a watch_corrected with negated effective seconds', ...);   // factor 2, sec 60 → -120
it('boost_started inverse only while that boost is active', ...);
// lifecycle.test.ts: ergänzen
it('create fills service defaults and rejects bad counting, purgeDays, keyword, chatBonus and gate configs', ...);
it('change_settings merges chatBonus field by field', ...);
// giveaway-projections.test.ts: ergänzen
it('giveaways row carries counting, purge_days, closed_at, boost', ...);
it('participants rows include seen pids with registered false and weight 0', ...);
it('timers mirrors boost_end also while paused and drops it after boost_ended', ...);
```

- [ ] **Step 2: Tests laufen lassen, sie scheitern**
- [ ] **Step 3: Implementieren** (Reducer-Fälle für die Dienst-Ereignisse brauchen in dieser Aufgabe Test-Records, die Befehle kommen in Aufgabe 3 und 4)
- [ ] **Step 4: Alle Tests laufen lassen** (`npm test` – der Reducer-Versionssprung und das Settings-Schema berühren viele Tests)
- [ ] **Step 5: Commit** `feat(giveaway): Dienst-Ereignisse, Einstellungen der Dienste, Upcaster v2, Lesetabellen`

---

### Task 3: `apply_signals` erzeugt Zuschauzeit, Chat-Bonus und Keyword-Anmeldung

**Files:**
- Modify: `src/framework/command-bus.ts`, `src/framework/giveaway/signals.ts`, `src/framework/runtime.ts`, `src/identity/identities.ts`, `src/identity/resolver.ts`, `src/ingest/channel-status.ts`, `src/app/main.ts`, `src/scheduler/main.ts`, `src/ingest/main.ts`, `test/helpers/giveaway.ts`
- Test: `test/apply-signals.test.ts`, `test/command-bus.test.ts`, `test/identity-store.test.ts`, `test/channel-status.test.ts`

**Interfaces:**
- Produces (`command-bus.ts`): `prepare?(c, cmd, ctx, pre: Q, state: S): Promise<P>`.
- Produces (`identities.ts`): `createIdentities(c: pg.PoolClient, users: TwitchUser[], now: Date): Promise<Map<string, string>>` – `INSERT … SELECT unnest … ON CONFLICT (twitch_id) DO NOTHING`, pid je Nutzer `randomUUID()`, danach `findPidsByTwitchIds`; `findTwitchIdsByPids(db, pids): Promise<Map<Pid, string>>`.
- Produces (`signals.ts`): `IdentityResolver` + `create(c: pg.PoolClient, users: SignalUser[], now: Date): Promise<Map<string, Pid>>` (`noIdentities.create` → leere Map); `interface ChannelActivity { active(db: Queryable, channels: Pid[], now: Date): Promise<Set<Pid>> }`, `noActivity` (leer), `allActive` (alle, für Tests); `ResolvedSignals` + `created: number`, `live: boolean`; `ApplySignalsDeps = GiveawayDeps & { identities: IdentityResolver; activity: ChannelActivity }`; `WATCH_SEC_PER_MINUTE = 60`; `keywordMatches(text: string, keyword: string): boolean`; `wordCount(text: string): number`.
  - `prepare(c, cmd, ctx, _pre, state)`: auflösen; Unbekannte anlegen: `counting === 'first_seen'` → alle unbekannten Anwesenden und Schreiber, sonst nur Schreiber mit Keyword; `touch` für Anwesende; `live = activity.active(c, [channel], now).has(channel)`.
  - `decide` (Algorithmus aus Entscheidungen 6–8, 10): Anmeldungen zuerst, dann `watch_credited` (nur wenn `presence !== null` und `minute > watchMinutes[channel]`), dann `chat_credited` (nur wenn `chatBonus.enabled && live`). Leere Ereignislisten sind erlaubt.
- Produces (`channel-status.ts`): `pgChannelActivity(): ChannelActivity` – `SELECT pid FROM channel_status WHERE pid = ANY($1) AND live AND last_signal_at >= $2` mit `SIGNAL_STALE_MS` aus `status-view.ts`.
- Produces (`runtime.ts`): `RuntimeOptions.activity?: ChannelActivity` (Default `noActivity`); die drei `main.ts` übergeben `activity: pgChannelActivity()`; `setupGiveaway` setzt `activity: allActive`.

- [ ] **Step 1: Tests schreiben** (`setupGiveaway({ identities, kernels })` mit `watchtime`-Giveaway `counting: 'first_seen'` als Standardfall; Stub-Resolver kennt ALICE→P2, BOB→P3, `create` vergibt feste pids)

```ts
// command-bus.test.ts: ergänzen
it('prepare receives the locked state', ...);
// apply-signals.test.ts: ersetzen/ergänzen
it('presence credits 60 s per present pid in one watch_credited with factor 1', ...);
it('first_seen creates identities for unknown present users and credits them', ...);   // GHOST bekommt pid, identities-Zeile, Eintrag im Ereignis; created 1
it('registered counting credits only registered pids and creates no identity for an unknown chatter', ...);  // Review Focus 2, Teil 2
it('keyword in registered counting creates the identity and registers, then credits the same minute', ...);  // Review Focus 2, Teil 1; Ereignisse: participant_registered vor watch_credited
it('keyword respects gateRegistration of the kernel and ignores already registered pids', ...);    // instant ohne Fenster → kein Ereignis
it('a second bundle for the same channel and minute credits no watch time again', ...);  // Review Focus 1
it('chat bonus: 4 words earn 2 s, 3 words nothing, cooldown 10 s across two bundles', ...);  // zweites Bündel 5 s später → kein Bonus, 10 s später → Bonus; lastAt im Ereignis
it('chat bonus needs an active channel and enabled setting', ...);                   // noActivity → kein chat_credited
it('boost factor applies to watch and chat, factor 1 after until', ...);              // Review Focus 3, Boost per Reducer-Zustand (Befehl aus Aufgabe 4 → hier boost_started über rt.handlers.startBoost sobald vorhanden, bis dahin über ein manuell angehängtes Ereignis in einem Schichttest in giveaway-state.test.ts)
it('paused giveaway still rejects with not_open', ...);
it('participants projection lists unregistered seen pids and the pool weight after 2 h', ...);
// identity-store.test.ts: ergänzen
it('createIdentities inserts only missing twitch ids and returns all pids', ...);
// channel-status.test.ts: ergänzen
it('pgChannelActivity returns live channels with a fresh signal only', ...);
```

- [ ] **Step 2: Tests laufen lassen, sie scheitern**
- [ ] **Step 3: Implementieren**
- [ ] **Step 4: Tests laufen lassen, sie bestehen** (`npx vitest run test/apply-signals.test.ts test/command-bus.test.ts test/identity-store.test.ts test/channel-status.test.ts test/ingest-worker.test.ts test/draw-command.test.ts`)
- [ ] **Step 5: Commit** `feat(giveaway): Zuschauzeit, Chat-Bonus und Keyword-Anmeldung aus Signalen`

---

### Task 4: Boost, Zeit-Korrektur, Rahmen-Zeitgeber im Scheduler

**Files:**
- Create: `src/framework/giveaway/boost.ts`
- Modify: `src/framework/runtime.ts`, `src/scheduler/timers.ts`
- Test: `test/boost.test.ts`, `test/scheduler-timers.test.ts`

**Interfaces:**
- Produces (`boost.ts`):
  - `interface StartBoostCmd { giveawayId: string; factor: number; durationSec: number }`, `BOOST_FACTOR_MIN = 2`, `BOOST_FACTOR_MAX = 10`, `BOOST_DURATION_MIN_SEC = 60`, `BOOST_DURATION_MAX_SEC = 86_400`
  - `startBoostHandler(d: GiveawayDeps & { activity: ChannelActivity }): CommandHandler<StartBoostCmd, GiveawayState, Set<Pid>>` – `authorizeControl`; `prepare` → `activity.active(c, state.settings.channels, ctx.now)`; `decide`: Zustand `open` („Ein Boost startet nur, solange das Giveaway offen ist.“, `not_open`), Faktor/Dauer prüfen (`invalid_boost`, „Der Faktor liegt zwischen 2 und 10, die Dauer zwischen 1 Minute und 24 Stunden.“), `state.boost` → `boost_active` („Ein Boost läuft schon. Stoppe ihn zuerst.“), leere Menge → `no_signal` („Kein Kanal des Giveaways ist live und liefert Signale. Ein Boost startet nur mit Signalen.“); Ereignis `boost_started { factor, until }` mit `until = now + durationSec`.
  - `stopBoostHandler(d: GiveawayDeps): CommandHandler<GiveawayCmd, GiveawayState>` – `authorize`: `system:scheduler` oder `authorizeControl`; `decide`: kein Boost → `no_boost` („Es läuft kein Boost.“); sonst `boost_ended {}`.
  - `interface CorrectWatchCmd { giveawayId: string; channel: Pid; pid: Pid; sec: number; reason: string }`
  - `correctWatchHandler(d: GiveawayDeps): CommandHandler<CorrectWatchCmd, GiveawayState>` – `authorizeControl`; `decide`: Zustand in `draft|open|paused|closed` (`settings_locked`-Text), Kanal im Giveaway (`channel_not_in_giveaway`), `sec` ganzzahlig, ≠ 0, |sec| ≤ 360000 („Die Korrektur ist eine ganze Zahl von Sekunden ungleich 0, höchstens 100 Stunden.“), Grund Pflicht (`reason_required`); Ereignis `watch_corrected { channel, entries: [{ pid, sec }] }` mit `reason`.
- Produces (`runtime.ts`): `handlers.startBoost`, `handlers.stopBoost`, `handlers.correctWatch`.
- Produces (`timers.ts`): `FRAMEWORK_TIMER_PREFIX = 'framework:'`; `runDueTimers` führt `framework:stop_boost` als `rt.handlers.stopBoost({ giveawayId })` aus, unbekannte `framework:`-Typen zählen als `rejected` und die Zeile fällt.

- [ ] **Step 1: Tests schreiben**

```ts
// boost.test.ts (setupGiveaway, watchtime-Giveaway offen)
it('start_boost writes boost_started with until and needs an active channel', ...);    // allActive → ok; noActivity → no_signal
it('start_boost rejects bad factor or duration, a running boost and a paused giveaway', ...);
it('stop_boost works for the streamer and the scheduler, rejects without boost', ...);
it('revert of boost_started ends the boost, revert of boost_ended is refused', ...);
it('correct_watch writes watch_corrected with reason and the kernel subtracts', ...);  // nach 2 h Gutschrift (apply_signals) −3600 → coins 0
it('correct_watch rejects after draw, foreign channel, zero and missing reason', ...);
// scheduler-timers.test.ts: ergänzen
it('boost_end timer ends the boost via the framework command and clears the row', ...);
it('an unknown framework timer type is dropped as rejected', ...);
```

- [ ] **Step 2: Tests laufen lassen, sie scheitern**
- [ ] **Step 3: Implementieren**
- [ ] **Step 4: Tests laufen lassen, sie bestehen** (`npx vitest run test/boost.test.ts test/scheduler-timers.test.ts test/apply-signals.test.ts`; in `apply-signals.test.ts` den Boost-Test jetzt über `rt.handlers.startBoost` fahren)
- [ ] **Step 5: Commit** `feat(giveaway): Boost mit Zeitgeber, Zeit-Korrektur`

---

### Task 5: Bedingungen bei der Ziehung, Helix-Prüfer, Anmeldefilter

**Files:**
- Create: `src/ingest/twitch/gates.ts`, `test/fixtures/twitch/get-users.json`
- Modify: `src/framework/giveaway/gates.ts`, `src/framework/giveaway/draw.ts`, `src/framework/runtime.ts`, `src/ingest/twitch/helix.ts`, `src/app/main.ts`
- Test: `test/gates.test.ts`, `test/draw-command.test.ts`, `test/ingest-helix.test.ts`, `test/ingest-gates.test.ts`

**Interfaces:**
- Produces (`gates.ts`, Teil 2):
  - `interface GateFacts { follows: Record<Pid, string | null>; accountCreatedAt: string | null; seenChannels: Pid[] }` – `follows[channel]` = `followed_at` oder `null` (folgt nicht); jeder von den Bedingungen gebrauchte Kanal ist enthalten
  - `evaluateGates(gates: GateConfig[], channels: Pid[], facts: GateFacts, now: Date): { ok: boolean; reasons: string[] }` – Gründe `follow:<channel>` je fehlendem Kanal (bei `min`: `follow_min`), `account_age`, `follow_age`, `presence`
  - `interface GateCheckInput { channels: Pid[]; gates: GateConfig[]; pids: Pid[]; seen: Record<Pid, Pid[]>; now: Date }`
  - `class GateCheckError extends Error { constructor(readonly code: 'twitch_unreachable' | 'token_invalid' | 'no_checker', message: string) }`
  - `interface GateChecker { check(db: Queryable, input: GateCheckInput): Promise<GateResult[]> }` (`GateResult` zieht von `draw.ts` nach `gates.ts`); `noGates`: ohne Bedingungen alle `ok`, mit Bedingungen `GateCheckError('no_checker', 'Bedingungen lassen sich in diesem Prozess nicht prüfen. Ziehe in der App.')`
- Produces (`draw.ts`): `DrawDeps.gates: GateChecker`; `type DrawPre = { kind: 'skip' } | { kind: 'failed'; code: string; message: string } | { kind: 'ready'; pids: Pid[]; gates: GateResult[] }`, `type DrawPrepared = DrawPre | { kind: 'changed' }`; `pre` lädt den Zustand über `d.loadState(db, …)`, prüft nur im passenden Zustand (`closed` bzw. `drawn`), fängt `GateCheckError` als `failed`; `prepare(c, cmd, ctx, pre, state)` vergleicht die sortierte pid-Liste des Topfs mit `pre.pids` → `changed`; `decide`: `failed` → `reject(code, message)`, `changed` → `reject('pool_changed', 'Der Topf hat sich geändert. Ziehe erneut.')`; `eligible` schließt zusätzlich `pid`s aus, die bei Kernen mit Dienst `registration` nicht in `state.registered` stehen, ihr `GateResult` bekommt `ok: false` und den Grund `not_registered` (steht so im Nachweis).
- Produces (`helix.ts`): `interface HelixUser { id: string; login: string; displayName: string; createdAt: string }`; `getUsers(ids: string[]): Promise<HelixUser[]>` – `GET /users?id=…` in Blöcken zu 100.
- Produces (`ingest/twitch/gates.ts`): `helixGateChecker(o: { helix: HelixClient; tokens: ChannelTokenProvider }): GateChecker` – Twitch-IDs über `findTwitchIdsByPids` (pids und Kanäle); pid ohne Identität → `ok: false, reasons: ['identity_deleted']`; Kanal ohne Identität oder ohne Token → `GateCheckError('token_invalid', 'Ein Kanal des Giveaways ist nicht verbunden. Verbinde ihn neu, dann ziehe.')`; Follows nur für Kanäle, die `follow`/`follow_age` brauchen, je pid `isFollower`; `account_age` → `getUsers`; `HelixError` → `GateCheckError('twitch_unreachable', 'Twitch antwortet nicht. Versuche die Ziehung später erneut.')`; dann `evaluateGates`.
- Produces (`app/main.ts`): baut `appTokenSource`, `helixClient`, `channelTokenProvider` wie `ingest/build.ts` und übergibt `gates: helixGateChecker(…)`. `scheduler/main.ts` und `ingest/main.ts` bleiben bei `noGates` (sie ziehen nicht).

- [ ] **Step 1: Tests schreiben**

```ts
// gates.test.ts (rein)
it('follow all/min/channel with reasons per missing channel', ...);
it('account_age and follow_age compare days against now', ...);         // Konto 29 Tage alt bei days 30 → account_age
it('follow_age applies the follow rule to old-enough follows only', ...);
it('presence counts seen channels', ...);
it('checkGateConfig rejects unknown channel, min above channel count, days out of range', ...);
// draw-command.test.ts: ergänzen (Stub-GateChecker als vi.fn)
it('gates run in pre with the pool pids and the proof lists them', ...);
it('a GateCheckError aborts the draw with its code and writes nothing', ...);   // Review Focus 4 (token_invalid)
it('a pool that changed between pre and prepare rejects with pool_changed', ...);   // Stub meldet sich in pre, Test registriert dazwischen einen weiteren Teilnehmer
it('unregistered seen pids with coins are excluded with not_registered', ...);   // watchtime, first_seen, 2 h für P2 ohne Anmeldung
it('noGates refuses to draw with configured gates', ...);
// ingest-helix.test.ts: ergänzen
it('getUsers maps id, login, display_name, created_at in blocks of 100', ...);
// ingest-gates.test.ts (freshDb, identities für Teilnehmer und Kanal, Fake-Helix, Fake-Tokens)
it('builds follow and account facts and evaluates', ...);
it('missing channel token → token_invalid, HelixError → twitch_unreachable, deleted participant → identity_deleted', ...);
```

- [ ] **Step 2: Tests laufen lassen, sie scheitern**
- [ ] **Step 3: Implementieren**
- [ ] **Step 4: Tests laufen lassen, sie bestehen** (`npx vitest run test/gates.test.ts test/draw-command.test.ts test/draw.test.ts test/ingest-helix.test.ts test/ingest-gates.test.ts test/revert.test.ts`)
- [ ] **Step 5: Commit** `feat(giveaway): Bedingungen bei der Ziehung per Helix, Anmeldefilter im Topf`

---

### Task 6: Löschfrist für Unangemeldete, Scheduler, Doku, Gesamtprüfung

**Files:**
- Create: `src/framework/giveaway/purge.ts`, `src/identity/purge.ts`
- Modify: `src/framework/runtime.ts`, `src/identity/runtime.ts`, `src/identity/account/commands.ts`, `src/scheduler/maintenance.ts`, `README.md`, `CLAUDE.md`
- Test: `test/purge.test.ts`, `test/account.test.ts`, `test/maintenance.test.ts`

**Interfaces:**
- Produces (`framework/giveaway/purge.ts`):
  - `PURGE_STATUSES = ['closed', 'drawn', 'completed', 'cancelled']`
  - `purgeUnregisteredHandler(d: GiveawayDeps): CommandHandler<GiveawayCmd, GiveawayState, Pid[]>` – `authorize`: `system:scheduler` oder `authorizeControl`; `prepare(c, cmd, ctx, _pre, state)`: Kandidaten = `seen` ohne `registered`, davon die ohne Zeile in `accounts` und ohne Zeile in `giveaway_participants` eines anderen Giveaways mit Status in `RUNNING` (eine SQL-Abfrage mit `unnest`); `decide`: Zustand in `PURGE_STATUSES` (`purge_not_closed`, „Die Löschung läuft erst nach dem Schließen.“), `purgedAt === null` (`already_purged`), `closedAt + purgeDays·86400 s ≤ now` (`purge_not_due`, „Die Löschfrist ist noch nicht um.“); Ereignis `unregistered_purged { pids }` (sortiert, auch leer).
  - `dueForPurge(db: Queryable, now: Date): Promise<string[]>` – `SELECT id FROM giveaways WHERE purged_at IS NULL AND counting = 'first_seen' AND status = ANY($1) AND closed_at + purge_days * interval '1 day' <= $2 ORDER BY closed_at`
  - `purgeUnregisteredAll(pool: pg.Pool, rt: Runtime, now: Date): Promise<{ purged: number; pids: number; failed: number }>` – je Giveaway `rt.bus.execute(rt.handlers.purgeUnregistered, …, { actor: 'system:scheduler' })`.
- Produces (`identity/purge.ts`): `unregisteredPurgeProjector(): Projector` – `handles: ['unregistered_purged']`, löscht `identities`-Zeilen der `pids` (nur die, die weiter kein Konto haben: `DELETE … WHERE pid = ANY($1) AND NOT EXISTS (SELECT 1 FROM accounts a WHERE a.pid = identities.pid)`); `attachAccounts` registriert ihn.
- Produces (`account/commands.ts`): `delete_account` vom Akteur `system:scheduler` auf einem Konto ohne Strom (`!state.exists`) schreibt trotzdem `account_deleted` (Identität ohne Login nach 12 Monaten). Für andere Akteure bleibt `no_account`.
- Produces (`runtime.ts`): `handlers.purgeUnregistered`. (`maintenance.ts`): `MaintenanceResult.unregisteredPurged: number`, ruft `purgeUnregisteredAll`.
- Doku: README „Prozesse“ (Scheduler: Löschfrist, Boost-Ende), Begriffe `Zuschauzeit`, `Coin`, `Chat-Bonus`, `Boost`, `Bedingung`, `Zählweise`, `Keyword`, `Löschfrist`; CLAUDE.md: Teilprojekte 1–5 fertig, als Nächstes 6 (Kern C), `apply_signals` erzeugt Ereignisse, `prepare` bekommt den Zustand, Rahmen-Zeitgeber `framework:`.

- [ ] **Step 1: Tests schreiben**

```ts
// purge.test.ts (setupGiveaway + attachAccounts, watchtime first_seen, Gutschriften über apply_signals)
it('purges unregistered seen pids after close + purgeDays, identities rows vanish, registered pids stay', ...);
it('keeps a pid with an account and a pid seen in another running giveaway', ...);   // Review Focus 5
it('rejects before the deadline, before closing and a second time', ...);
it('dueForPurge lists only first_seen giveaways past the deadline without purged_at', ...);
it('purgeUnregisteredAll runs as system:scheduler and counts', ...);
// account.test.ts: ergänzen
it('scheduler may delete an identity without account stream, a user may not', ...);
// maintenance.test.ts: ergänzen
it('maintenance reports unregisteredPurged', ...);
```

- [ ] **Step 2: Tests laufen lassen, sie scheitern**
- [ ] **Step 3: Implementieren**
- [ ] **Step 4: Alles prüfen** (`npm run typecheck`, `npm run lint`, `npm test`, `npm run build`; dann gegen den Dev-Stack `INGEST_ADAPTER=simulator` Ingest und App kurz starten, ein `watchtime`-Giveaway mit `counting: 'first_seen'` über die Runtime anlegen und öffnen, nach zwei Minuten `watch_credited`-Ereignisse und `giveaway_participants.seen = true` in der Datenbank sehen)
- [ ] **Step 5: Commit** `feat(giveaway): Löschfrist für Unangemeldete, Doku Teilprojekt 5`

---

## Selbstprüfung gegen die Spec

- 4 Kern-Vertrag: `usesServices` steuert jetzt, welche Ereignisse ein Kern sieht → Task 1, 2. Neuer Kern = Verzeichnis + Registry-Eintrag → Task 1.
- 5.2 Versionierung: Upcaster v2 mit Test → Task 2.
- 5.3 Umkehrbarkeit: Gutschriften `compensate` über `watch_corrected`, Boost `compensate`/`none`, Löschung `none` → Task 2, 4.
- 6.1 Zuschauzeit je Minute, nur Live-Kanäle, Pause zählt nichts, beide Zählweisen, Frist einstellbar → Task 3, 6.
- 6.2 Chat-Bonus, Defaults, abschaltbar, gebündelt je Kanal und Minute → Task 3. KI-Bewertung → Teilprojekt 7 (Entscheidung 14).
- 6.3 Boost → Task 4, Faktor in Gutschriften → Task 3.
- 6.4 Keyword im Chat → Task 3. Knopf im Portal → Teilprojekt 8.
- 6.5 Bedingungen, Prüfung bei der Ziehung, Nachweis mit Grund, Topf-Filter → Task 5. Laufende Anzeige → Teilprojekt 8.
- 7.2 Helix nicht erreichbar → Abbruch ohne Ereignis → Task 5.
- 8.1 Kern A → Task 1.
- 12.4 Löschfrist → Task 6.
- 15.3 Felder `keyword`, `counting`, Coin-Basis, Follow „mindestens N“, Chat-Bonus → Task 2.
- Offen für Teilprojekt 8: Chat-Ansagen (10.3), Bedingungsstatus live, Anmeldeknopf. Offen für Teilprojekt 7: KI-Bewertung je Team.
