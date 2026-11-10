# Lasttest

Ziel aus NEW_DESIGN.md 12.2 und Erfolgskriterium 7: 1.000 gleichzeitig aktive Kanäle mit je 200 Zuschauern, unter 100 ms je Befehl im p95. Dazu das Betriebsziel: ein Ingest-Worker schafft eine simulierte Minute in unter einer Wanduhr-Minute, sonst verliert er Anwesenheitsminuten.

## Aufbau

`npm run loadtest -w packages/server -- --channels 1000 --viewers 200 --minutes 3` (Modul `src/loadtest/`, Skript `scripts/load-test.ts`, `DATABASE_URL` aus der Umgebung).

- Eigene Datenbank `loadtest_<zeit>` auf `DATABASE_URL` (Dev-Compose, PostgreSQL 17 im Container), Migrationen und Partitionen wie im Betrieb, danach gelöscht (nach einem Abbruch von Hand: `DROP DATABASE`).
- Je Kanal ein offenes Giveaway mit Kern A (Zuschauzeit), Zählweise „ab erstem Erscheinen“, Chat-Bonus an, Keyword `!los`.
- Simulator-Adapter wie im Prozess `ingest` (`INGEST_ADAPTER=simulator`): je Kanal und Minute eine Anwesenheitsliste, alle 4 s eine Chatnachricht, Live-Status je Minute. Ein Worker, alle Kanäle.
- Der echte Weg: Simulator → Bündler → Dispatcher → `apply_signals` über `CommandBus.execute` (Journal, Projektionen, Snapshot) mit denselben Lesezugriffen wie der Prozess `ingest` (`channel_status`, Team-Kanäle, Sperren aus den Lesetabellen). Gemessen wird jede Ausführung am Bus, je Befehlstyp.
- Die Uhr läuft in Sekundenschritten (`worker.tick`), eine simulierte Minute entspricht 60 Takten. Die Bündel einer Minute laufen in der folgenden Wanduhr-Minute (Minute 1 zeigt darum 0 Befehle), die letzte Minute wird beim Stopp gebündelt.
- Nicht gemessen: Twitch-Netz, Redis (Publisher im Speicher), Web-Rendering. Junge Ströme: nach drei Minuten liegen je Giveaway rund zehn Ereignisse; im Betrieb lädt `apply_signals` Snapshot plus bis zu 999 Ereignisse mit je bis zu 200 Einträgen (Snapshot alle 1.000 Ereignisse, bei einem Live-Kanal rund alle 8 h). Für alte Ströme einen langen Lauf fahren, z. B. `--channels 20 --minutes 600`.

## Ergebnis vom 10.11.2026 (nach dem Review-Fix: ein Statement je Spaltensignatur in `channel_status`)

Rechner: Windows 11, Docker Desktop, PostgreSQL 17 im Container, Node 24. 1.000 Kanäle × 200 Zuschauer, 3 simulierte Minuten, Seed 1, Pool 10.

| Befehl | Anzahl | Mittel | p50 | p95 | p99 | max |
|---|---|---|---|---|---|---|
| apply_signals | 3000 | 24,0 ms | 23,5 ms | 27,6 ms | 29,8 ms | 108,6 ms |
| create_giveaway | 1000 | 10,8 ms | 10,7 ms | 11,6 ms | 12,5 ms | 27,6 ms |
| open_giveaway | 1000 | 13,8 ms | 13,7 ms | 15,0 ms | 15,7 ms | 36,3 ms |

Simulierte Minute: 27,1 s und 24,2 s Wanduhr (Minute 1 ohne Bündel 0,4 s). Ereignisse: 9.000, abgelehnt: 0, fehlgeschlagen: 0, Wanduhr gesamt: 100,2 s inklusive Anlegen und Öffnen der Giveaways.

**Befund:** Beide Ziele erreicht. `apply_signals` liegt im p95 bei 27,6 ms (ein Bündel mit 200 Anwesenden: Identitäten anlegen, 200 Einträge `watch_credited`, Chat-Bonus, Projektionen). Ein Worker braucht für 1.000 Kanäle rund 25 s je simulierter Minute, davon rund 24 s `apply_signals` nacheinander.

**Vorher** (erster Lauf desselben Tages, ohne Batch): 45 bis 50 s je simulierter Minute. Ursache war `StatusBuffer.flush` mit einem Upsert je Kanal und Takt (rund 9.000 Abfragen je Minute), nicht die Datenbank (p99 30 ms bei Pool 10).

**Engpass:** Ein Ingest-Worker verarbeitet seine Bündel nacheinander (`bundler.ts`, `dispatch.ts`); alle 1.000 Bündel einer Minute werden im selben Takt fällig. Bei 1.000 Live-Kanälen ist ein Worker zur Hälfte ausgelastet. Darüber `INGEST_WORKERS=2` oder mehr setzen (Kanäle per Hash verteilt, NEW_DESIGN.md 10.2), Vorlage `ingest-1` in `docker-compose.yml`.

## Wiederholen

Vor einem Release mit Änderungen am Befehlsablauf, am Journal oder an den Projektionen den Lauf wiederholen und die Tabelle hier ergänzen. Kleinere Läufe (`--channels 50 --viewers 50 --minutes 2`) dauern wenige Sekunden und zeigen Regressionen je Befehl. Exit 1, wenn ein Befehlstyp das p95-Ziel oder eine Minute das Wanduhrziel verfehlt.
