# CLAUDE.md

## PFLICHTLEKTÜRE
**[NEW_DESIGN.md](NEW_DESIGN.md) vor jeder Arbeit VOLLSTÄNDIG lesen – jede Zeile, kein Überfliegen,
kein Teil-Lesen per offset/limit oder grep.** Bei Widerspruch gilt NEW_DESIGN.md.

## Harte Regeln
- Jede Zustandsänderung läuft durch `CommandBus.execute`. Kein zweiter Schreibweg, auch nicht für Tests oder Simulator.
- `events` ist append-only. Korrektur = neues Ereignis. Nie UPDATE/DELETE auf `events`.
- Payloads enthalten nur `pid`, nie Twitch-Name oder Twitch-ID (`assertNoTwitchIdentity`).
- Ein Kern (`src/kernels/*`) importiert nur `src/kernel-api`. ESLint erzwingt das.
- Neue Tabelle/Spalte nur über eine neue Datei in `packages/server/migrations/`.
- Tests brauchen Docker. Nie gegen eine fremde Datenbank testen.
- UI- und Fehlertexte: deutsch, kurz, aktiv, Begriffe aus dem Glossar (NEW_DESIGN.md §2).

## Befehle
`npm run typecheck` · `npm run lint` · `npm test` · `npm run build`
