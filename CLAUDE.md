# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## PFLICHTLEKTÜRE
**[NEW_DESIGN.md](NEW_DESIGN.md) vor jeder Arbeit VOLLSTÄNDIG lesen – jede Zeile, kein Überfliegen,
kein Teil-Lesen per offset/limit oder grep.** Bei Widerspruch gilt NEW_DESIGN.md.
Umsetzungspläne je Teilprojekt liegen in `docs/superpowers/plans/`. Teilprojekte 1–3 sind fertig, als Nächstes kommt 4 (Ingest).

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
Modularer Monolith, zwei Prozesse aus derselben Codebasis (`src/app/main.ts`, `src/scheduler/main.ts`), Ingest-Worker folgt in Teilprojekt 4. PostgreSQL-Journal ist die einzige Wahrheit, Redis nur Pub/Sub.

**Befehlsablauf** (`framework/command-bus.ts`). Ein `CommandHandler` hat `type`, `streamOf`, `reducer`, optional `pre`, `authorize`, optional `prepare`, `decide`. `execute` macht:
1. `pre` vor der Transaktion, ohne Sperre, für Netz-I/O (Twitch, Rechtstext-URLs).
2. In der Transaktion: `authorize` → `lockStream` (`stream_heads … FOR UPDATE`) → Zustand laden (Snapshot + Replay) → `prepare` (DB-Daten außerhalb des Reducers) → `decide` (rein) → `appendLocked` (zod-Schema, `assertNoTwitchIdentity`, Grundpflicht) → Projektionen → Snapshot alle 1000 Ereignisse.
3. Publish an Oberflächen nach Commit. Fehler dabei brechen nichts ab.

Eine `Rejection` (`{rejected, code, message}`) rollt die Transaktion zurück und landet gedrosselt in `access_log`. `seq_conflict`, Serialisierungsfehler und fehlende Partition werden genau einmal wiederholt. `correlationId` muss eine UUID sein.

**Ströme und Akteure** (`journal/types.ts`): `giveaway:<uuid>`, `team:<uuid>`, `account:<uuid>`, `platform`. Akteure `user:<uuid>` oder `system:ingest|scheduler|twitch|migration`. `events` ist nach Monat partitioniert, Partitionen legt `ensurePartitions` an.

**Runtime** (`framework/runtime.ts`, `createRuntime`) baut `EventTypeRegistry`, `ProjectionRegistry`, Giveaway-Reducer, `CommandBus` und alle Giveaway-Handler. `identity/runtime.ts` (`attachAccounts`) hängt den Konto-Strom an, genau einmal je Runtime. Beide Prozesse und die Tests bauen so ihre Runtime, mit unterschiedlichem `GiveawayAuthorizer` (`accountAuthorizer`, `denyUsers`, in Tests `allowAll`).

**Kern-Vertrag** (`kernel-api/index.ts`, nur Typen). Ein Kern besteht aus reinen Funktionen `initialState`, `reduce`, `pool`, `decide`, `gateRegistration`, `timers`, `viewerView`. Zeit kommt als ISO-String herein. Kern-Ereignistypen tragen das Präfix `<kernelId>_`, Registry und `kernelCommandHandler` prüfen das. Rahmen-Ereignisse `participant_registered`/`participant_withdrawn` bekommt der Kern ebenfalls per `reduce`. Neuer Kern = Verzeichnis `src/kernels/<id>/` + Eintrag in `defaultKernels()` (`framework/kernel-registry.ts`). Steigt `kernel.version`, baut `reconcileKernelVersions` beim App-Start die Projektionen laufender Giveaways neu. Ändert sich die Form von `GiveawayState`, steigt `FRAMEWORK_REDUCER_VERSION`.

**Ereignistypen** werden mit zod-Schema, `version`, `reversal` (`compensate` mit `inverse(target, state)`, `void`, `none` mit Grund) und Upcastern registriert. Giveaway-Typen: `framework/giveaway/events.ts`, Konto-Typen: `identity/account/events.ts`. Der Giveaway-Zustand und die erlaubten Übergänge (`TRANSITIONS`) stehen in `framework/giveaway/state.ts`.

**Umkehrung** (`framework/revert.ts`): ein generischer `revert`-Handler je Strom. `compensate` erzeugt das Gegen-Ereignis über `inverse`, `void` schreibt `event_voided`. Beide tragen `reversesEventId` und Grund. `isReverted` folgt Umkehrketten.

**Projektionen** (`framework/projections.ts`): `Projector` hört auf Ereignistypen, `StateProjector` bekommt nach jedem Befehl den ganzen Zustand des Stroms. Registrierungsreihenfolge zählt wegen Fremdschlüsseln. `rebuildStream`/`rebuild` bauen aus dem Journal neu auf. Lesen läuft immer über Lesetabellen, nie über Replay.

**Identität** (`src/identity`): `identities` ist die einzige Tabelle mit Twitch-Daten, Löschen entfernt nur diese Zeile. Sitzungen in PostgreSQL (Cookie `ccg_session`), Kanal-Tokens AES-256-GCM mit Schlüssel aus `TOKEN_KEY_FILE`. HTTP-Routen in `src/api` (`/auth/*`, `/me/*`), Ablehnungen antworten `{code, message}`.

**Scheduler** (`src/scheduler`): Einzelinstanz per `pg_advisory_lock`, Wartung stündlich (Partitionen, IP-Bereinigung, Sitzungen, inaktive Konten), Zeitgeber alle 5 s aus der Tabelle `timers`, die nur ein Spiegel der `kernel.timers()` ist. Fällige Zeitgeber laufen als Kern-Befehl mit Akteur `system:scheduler`.
