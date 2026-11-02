# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## PFLICHTLEKTÜRE
**[NEW_DESIGN.md](NEW_DESIGN.md) vor jeder Arbeit VOLLSTÄNDIG lesen – jede Zeile, kein Überfliegen,
kein Teil-Lesen per offset/limit oder grep.** Bei Widerspruch gilt NEW_DESIGN.md.
Umsetzungspläne je Teilprojekt liegen in `docs/superpowers/plans/`. Teilprojekte 1–5 sind fertig, als Nächstes kommt 6 (Kern C: Geldbörse, Ticket-Befehle).

## Harte Regeln
- Jede Zustandsänderung läuft durch `CommandBus.execute`. Kein zweiter Schreibweg im Produktcode, auch nicht für den Simulator. Auch `identities`, `channel_tokens` und Löschungen werden nur in `prepare` oder in Projektoren innerhalb der Befehls-Transaktion geschrieben. Nur Schichttests der Journal-/Projektionsmodule (`test/journal.test.ts`, `test/projections.test.ts`) dürfen `appendLocked` direkt rufen.
- `events` ist append-only. Korrektur = neues Ereignis. Nie UPDATE/DELETE auf `events`.
- Payloads enthalten nur `pid`, nie Twitch-Name oder Twitch-ID (`assertNoTwitchIdentity` in `journal/guard.ts` verbietet Schlüssel wie `twitch_id`, `login`, `display_name`).
- Ein Kern (`src/kernels/*`) importiert nur `src/kernel-api`. `kernel-api` importiert nichts. ESLint erzwingt das (`eslint.config.js`), `test/architecture.test.ts` prüft die Regel.
- Neue Tabelle/Spalte nur über eine neue Datei `NNN_name.sql` in `packages/server/migrations/` (läuft beim Start einmal, Advisory-Lock).
- Formatänderung eines Ereignistyps: `version` erhöhen, Upcaster `n → n+1` registrieren, Test dazu. Die Registry wirft ohne Upcaster.
- Tests brauchen Docker (Testcontainers). Nie gegen eine fremde Datenbank testen.
- UI- und Fehlertexte: deutsch, kurz, aktiv, höchstens 20 Wörter, Begriffe aus dem Glossar (NEW_DESIGN.md §2). Fehlertext = was passiert ist + was zu tun ist.

## Befehle
Monorepo mit npm-Workspaces, ein Paket: `packages/server` (`@ccg/server`). Node ≥ 24, ESM, TypeScript strict mit `noUncheckedIndexedAccess`.

Von der Wurzel:
- `npm run typecheck` · `npm run lint` · `npm test` · `npm run build` (CI läuft genau diese drei Prüfungen)
- Einzelner Test: `npm test -w packages/server -- test/journal.test.ts` oder `npx vitest run test/journal.test.ts -t "Name"` in `packages/server`
- Dev-Stack: `docker compose -f docker-compose.dev.yml up -d` (PostgreSQL auf 5433, Redis auf 6380), `.env` aus `.env.example`, Schlüssel: `mkdir secrets && openssl rand -hex 32 > secrets/token.key`
- App im Watch-Modus: `npm run dev:app -w packages/server` · Produktion nach Build: `start:app`, `start:scheduler`

Tests: `vitest` mit `test/global-setup.ts`, das einen PostgreSQL-Container für den ganzen Lauf startet. Jeder Test ruft `freshDb()` (`test/helpers/db.ts`) und bekommt eine eigene Datenbank mit Migrationen und Partitionen. Kein Redis in Tests (`InMemoryPublisher`). `test/helpers/api.ts` liefert `setupApi()`, `login()`, `connect()` mit Twitch-Stub. Feste Testzeit `AT = 2026-10-15T12:00Z`.

## Architektur
Modularer Monolith, drei Prozesse aus derselben Codebasis (`src/app/main.ts`, `src/scheduler/main.ts`, `src/ingest/main.ts`). PostgreSQL-Journal ist die einzige Wahrheit, Redis nur Pub/Sub.

**Ingest** (`src/ingest`): Adapter (`simulator`, `twitch/`) liefern Signale, der Bündler sammelt je Kanal und Minute, der Dispatcher sendet je offenem Giveaway `apply_signals` mit Akteur `system:ingest`. Der Ingest schreibt nie ins Journal (ESLint-Regel), nur in die Betriebsdaten-Tabelle `channel_status`. Kanalverzeichnis aus Lesetabellen alle 30 s, `owned` per Hash auf Worker verteilt.

**Rahmen-Dienste** (`framework/giveaway/`): `apply_signals` (`signals.ts`) löst Twitch-IDs über `IdentityResolver` auf, legt in `prepare` Identitäten für Unbekannte an (nur Zählweise `first_seen` oder Keyword-Schreiber), liest über `ChannelActivity` (`channel_status`), ob der Kanal live ist, und erzeugt in `decide` rein: `participant_registered` (Keyword), `watch_credited` (60 s je Anwesendem, je Kanal und Minute genau einmal über `state.watchMinutes`), `chat_credited` (ab `minWords`, Cooldown über `state.chatLast`). Dienst-Ereignistypen, Einstellungen (`counting`, `purgeDays`, `keyword`, `chatBonus`) und `boostFactor` stehen in `services.ts`. Boost, `stop_boost` und `correct_watch` in `boost.ts`, Löschfrist (`purge_unregistered`, `dueForPurge`, `purgeUnregisteredAll`) in `purge.ts`, die Löschung der `identities`-Zeile macht `identity/purge.ts` als Projektor. Bedingungen (`gates.ts`): `GateConfig`-Union, reines `evaluateGates`, `GateChecker` holt die Fakten; die Ziehung prüft in `pre` (ohne Sperre, Helix über `ingest/twitch/gates.ts`), `prepare` vergleicht den Topf (`pool_changed`), ein `GateCheckError` bricht ohne Ereignis ab. Kerne mit Dienst `registration` bekommen Unangemeldete vor der Ziehung mit Grund `not_registered` gefiltert.

**Befehlsablauf** (`framework/command-bus.ts`). Ein `CommandHandler` hat `type`, `streamOf`, `reducer`, optional `pre`, `authorize`, optional `prepare`, `decide`. `execute` macht:
1. `pre` vor der Transaktion, ohne Sperre, für Netz-I/O (Twitch, Rechtstext-URLs).
2. In der Transaktion: `authorize` → `lockStream` (`stream_heads … FOR UPDATE`) → Zustand laden (Snapshot + Replay) → `prepare(c, cmd, ctx, pre, state)` (DB-Daten außerhalb des Reducers, sieht den gesperrten Zustand) → `decide` (rein) → `appendLocked` (zod-Schema, `assertNoTwitchIdentity`, Grundpflicht) → Projektionen → Snapshot alle 1000 Ereignisse.
3. Publish an Oberflächen nach Commit. Fehler dabei brechen nichts ab.

Eine `Rejection` (`{rejected, code, message}`) rollt die Transaktion zurück und landet gedrosselt in `access_log`. `seq_conflict`, Serialisierungsfehler und fehlende Partition werden genau einmal wiederholt. `correlationId` muss eine UUID sein.

**Ströme und Akteure** (`journal/types.ts`): `giveaway:<uuid>`, `team:<uuid>`, `account:<uuid>`, `platform`. Akteure `user:<uuid>` oder `system:ingest|scheduler|twitch|migration`. `events` ist nach Monat partitioniert, Partitionen legt `ensurePartitions` an.

**Runtime** (`framework/runtime.ts`, `createRuntime`) baut `EventTypeRegistry`, `ProjectionRegistry`, Giveaway-Reducer, `CommandBus` und alle Giveaway-Handler. `identity/runtime.ts` (`attachAccounts`) hängt den Konto-Strom an, genau einmal je Runtime. Beide Prozesse und die Tests bauen so ihre Runtime, mit unterschiedlichem `GiveawayAuthorizer` (`accountAuthorizer`, `denyUsers`, in Tests `allowAll`).

**Kern-Vertrag** (`kernel-api/index.ts`, nur Typen). Ein Kern besteht aus reinen Funktionen `initialState`, `reduce`, `pool`, `decide`, `gateRegistration`, `timers`, `viewerView`. Zeit kommt als ISO-String herein. Kern-Ereignistypen tragen das Präfix `<kernelId>_`, Registry und `kernelCommandHandler` prüfen das; Kern-Befehlstypen enthalten keinen Doppelpunkt (reserviert für Rahmen-Zeitgeber `framework:<name>`). Rahmen-Ereignisse `participant_registered`/`participant_withdrawn` bekommt jeder Kern per `reduce`, die Ereignisse der Dienste aus `usesServices` (`SERVICE_EVENTS` in `kernel-api`: `watch_credited`, `watch_corrected`, `chat_credited`) nur Kerne mit dem Dienst. Kerne: `instant` (B), `watchtime` (A, Coins = Sekunden ÷ Coin-Basis). Neuer Kern = Verzeichnis `src/kernels/<id>/` + Eintrag in `defaultKernels()` (`framework/kernel-registry.ts`). Steigt `kernel.version`, baut `reconcileKernelVersions` beim App-Start die Projektionen laufender Giveaways neu. Ändert sich die Form von `GiveawayState`, steigt `FRAMEWORK_REDUCER_VERSION`.

**Ereignistypen** werden mit zod-Schema, `version`, `reversal` (`compensate` mit `inverse(target, state)`, `void`, `none` mit Grund) und Upcastern registriert. Giveaway-Typen: `framework/giveaway/events.ts` (`giveaway_created` und `giveaway_settings_changed` sind v2 mit Upcaster für `legal` und die Dienst-Felder), Dienst-Typen: `framework/giveaway/services.ts`, Konto-Typen: `identity/account/events.ts`. Der Giveaway-Zustand und die erlaubten Übergänge (`TRANSITIONS`) stehen in `framework/giveaway/state.ts`.

**Umkehrung** (`framework/revert.ts`): ein generischer `revert`-Handler je Strom. `compensate` erzeugt das Gegen-Ereignis über `inverse`, `void` schreibt `event_voided`. Beide tragen `reversesEventId` und Grund. `isReverted` folgt Umkehrketten.

**Projektionen** (`framework/projections.ts`): `Projector` hört auf Ereignistypen, `StateProjector` bekommt nach jedem Befehl den ganzen Zustand des Stroms. Registrierungsreihenfolge zählt wegen Fremdschlüsseln. `rebuildStream`/`rebuild` bauen aus dem Journal neu auf. Lesen läuft immer über Lesetabellen, nie über Replay.

**Identität** (`src/identity`): `identities` ist die einzige Tabelle mit Twitch-Daten, Löschen entfernt nur diese Zeile. Sitzungen in PostgreSQL (Cookie `ccg_session`), Kanal-Tokens AES-256-GCM mit Schlüssel aus `TOKEN_KEY_FILE`. HTTP-Routen in `src/api` (`/auth/*`, `/me/*`), Ablehnungen antworten `{code, message}`.

**Scheduler** (`src/scheduler`): Einzelinstanz per `pg_advisory_lock`, Wartung stündlich (Partitionen, IP-Bereinigung, Sitzungen, inaktive Konten, Löschfrist Unangemeldeter), Zeitgeber alle 5 s aus der Tabelle `timers`, die nur ein Spiegel der `kernel.timers()` und des Rahmen-Zeitgebers `boost_end` ist. Fällige Zeitgeber laufen als Kern-Befehl oder Rahmen-Befehl (`framework:stop_boost`) mit Akteur `system:scheduler`. `delete_account` vom Scheduler löscht auch Identitäten ohne Konto-Strom.
