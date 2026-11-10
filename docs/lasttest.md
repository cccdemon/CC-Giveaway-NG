# Lasttest

Ziel aus NEW_DESIGN.md 12.2 und Erfolgskriterium 7: 1.000 gleichzeitig aktive Kanäle mit je 200 Zuschauern, unter 100 ms je Befehl im p95.

## Aufbau

`npm run loadtest -w packages/server -- --channels 1000 --viewers 200 --minutes 3` (Modul `src/loadtest/`, Skript `scripts/load-test.ts`).

- Eigene Datenbank `loadtest_<zeit>` auf `DATABASE_URL` (Dev-Compose, PostgreSQL 17 im Container), Migrationen und Partitionen wie im Betrieb, danach gelöscht.
- Je Kanal ein offenes Giveaway mit Kern A (Zuschauzeit), Zählweise „ab erstem Erscheinen“, Chat-Bonus an, Keyword `!los`.
- Simulator-Adapter wie im Prozess `ingest` (`INGEST_ADAPTER=simulator`): je Kanal und Minute eine Anwesenheitsliste, alle 4 s eine Chatnachricht, Live-Status je Minute. Ein Worker, alle Kanäle.
- Der echte Weg: Simulator → Bündler → Dispatcher → `apply_signals` über `CommandBus.execute` (Journal, Projektionen, Snapshot). Gemessen wird jede Ausführung am Bus, je Befehlstyp.
- Die Uhr läuft in Sekundenschritten (`worker.tick`), eine simulierte Minute entspricht 60 Takten. Nicht gemessen: Twitch-Netz, Redis (Publisher im Speicher), Web-Rendering.

## Ergebnis vom 10.11.2026

Rechner: Windows 11, Docker Desktop, PostgreSQL 17 im Container, Node 24. 1.000 Kanäle × 200 Zuschauer, 3 simulierte Minuten, Seed 1, Pool 10.

| Befehl | Anzahl | Mittel | p50 | p95 | p99 | max |
|---|---|---|---|---|---|---|
| apply_signals | 3000 | 21,7 ms | 20,8 ms | 25,8 ms | 30,6 ms | 118,5 ms |
| create_giveaway | 1000 | 9,4 ms | 9,3 ms | 10,6 ms | 11,7 ms | 29,5 ms |
| open_giveaway | 1000 | 13,6 ms | 13,4 ms | 15,2 ms | 16,2 ms | 41,6 ms |

Ereignisse: 9.000, abgelehnt: 0, fehlgeschlagen: 0, Wanduhr: 162,9 s (davon 23,8 s Anlegen und Öffnen der Giveaways).

**Befund:** Ziel erreicht, `apply_signals` liegt im p95 bei 25,8 ms. Ein Bündel mit 200 Anwesenden (Identitäten anlegen, 200 Einträge `watch_credited`, Chat-Bonus, Projektionen) kostet rund 21 ms.

**Engpass:** Ein Ingest-Worker verarbeitet seine Bündel nacheinander. 1.000 Kanäle brauchen je simulierter Minute rund 45 bis 50 s Wanduhrzeit, der Worker ist bei 1.000 Live-Kanälen also fast ausgelastet. Für Betrieb an dieser Grenze `INGEST_WORKERS=2` oder mehr setzen (Kanäle werden per Hash verteilt, NEW_DESIGN.md 10.2); jeder Worker läuft als eigener `ingest`-Dienst mit eigenem `INGEST_WORKER_INDEX`. Die Datenbank war nicht der Engpass (p99 30,6 ms bei Pool 10).

## Wiederholen

Vor einem Release mit Änderungen am Befehlsablauf, am Journal oder an den Projektionen den Lauf wiederholen und die Tabelle hier ergänzen. Kleinere Läufe (`--channels 50 --viewers 50 --minutes 2`) dauern wenige Sekunden und zeigen Regressionen je Befehl.
