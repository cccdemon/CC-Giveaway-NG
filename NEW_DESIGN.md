# CC-Giveaway Neubau – Design-Spec

Stand: 12.10.2026 · Status: Entwurf zur Freigabe
UI-Vorschau: https://claude.ai/artifact/WPjkheR8tnCiSxodod7rMx (privat)

Dieses Dokument beschreibt das neue Giveaway-System. Es löst CC-Giveaway vollständig ab.
Jede Entscheidung hier ist mit dem Betreiber abgestimmt. Abschnitt 13 listet sie einzeln.

---

## 1. Ziel

Eine offene Plattform für Twitch-Giveaways. Jeder Streamer meldet sich mit Twitch an und
startet Giveaways. Mehrere Streamer können sich zu einem Team zusammenschließen und ein
Giveaway gemeinsam für ihre Zuschauer anbieten.

Die Plattform besteht aus einem **Rahmen** und austauschbaren **Kernen**. Ein Kern ist eine
Verlosungsmechanik. Der Rahmen stellt alles andere bereit: Twitch-Anbindung, Journal,
Ziehung, Status, Datenschutz, Oberflächen.

### Erfolgskriterien

1. Ein neuer Kern braucht nur ein neues Modul und einen Registry-Eintrag. Kein anderer Code ändert sich.
2. Ein Streamer braucht keine lokale Software. Anmelden und Kanal verbinden reicht.
3. Jede Zustandsänderung steht im Journal und lässt sich umkehren (Ausnahmen in 5.3).
4. Pause und Fortsetzen verlieren keine Information.
5. Das System zeigt jederzeit Zustand, aktuelle Tätigkeit und Signalqualität je Kanal.
6. Ein Teilnehmer sieht seine Daten, seinen Status, seine Chance und kann alles löschen.
7. Das System trägt 1.000 gleichzeitig aktive Kanäle mit je 200 Zuschauern.

### Nicht-Ziele

- Keine Streamer.bot-Pflicht. Ein Streamer.bot-Adapter ist später möglich, aber nicht Teil von Version 1.
- Keine Plattformen außer Twitch in Version 1.
- Keine Kerne von Dritten, kein Baukasten für Streamer.
- Keine Abo-, VIP- oder Kauf-Regeln. Sie sind glücksspielrechtlich heikel.
- Keine Speicherung von Gewinner-Anschriften.
- Keine OBS-Overlays.
- Kein Import von Altdaten.

---

## 2. Glossar

Ein Begriff bezeichnet genau ein Ding. UI, Code und Doku nutzen dieselben Begriffe.

| Begriff | Bedeutung |
|---|---|
| Plattform | Das gesamte System inklusive Betreiber. |
| Rahmen | Der Teil des Codes, der für alle Kerne gleich ist. |
| Kern | Ein Plugin, das eine Verlosungsmechanik umsetzt. |
| Giveaway | Eine Verlosung. Sie gehört genau einem Team und nutzt genau einen Kern. |
| Team | Eine Gruppe von 1–n Streamern. Ein Streamer allein hat ein Solo-Team. |
| Kanal | Ein Twitch-Kanal, der mit der Plattform verbunden ist. |
| Teilnehmer | Ein Zuschauer, der sich für ein Giveaway angemeldet hat. |
| pid | Die interne, pseudonyme Teilnehmer-ID. |
| Bedingung | Eine Teilnahmeregel des Rahmens (Follow, Mindestalter, Anwesenheit). |
| Topf | Alle berechtigten Teilnehmer mit ihrem Gewicht. |
| Gewicht | Die Zahl, die die Chance eines Teilnehmers bestimmt. |
| Chance | Eigenes Gewicht geteilt durch die Summe aller Gewichte im Topf. |
| Coin | Einheit für gesammelte Zuschauzeit (Kern A, Kern C). |
| Ticket | Ein mit Coins gekauftes Los (Kern C). |
| Journal | Die append-only Liste aller Ereignisse. |
| Ereignis | Ein Eintrag im Journal. |
| Befehl | Eine Anfrage, den Zustand zu ändern. Ein gültiger Befehl erzeugt Ereignisse. |
| Projektion | Eine Lesetabelle, die aus dem Journal entsteht. |
| Signal | Neutrale Eingabe vom Ingest: presence, chat, follow, stream_state. |
| Ingest | Der Teil, der Signale von Twitch holt. |
| Statusblock | Die Live-Anzeige von Zustand, Tätigkeit und Signal je Kanal. |

---

## 3. Architektur

### 3.1 Übersicht

```
 Twitch (EventSub, Helix)        Simulator
          │                          │
   ┌──────▼──────────────────────────▼──────┐
   │ ingest-worker: Adapter → Signale,       │
   │ gebündelt je Kanal und Minute           │
   └──────────────────┬─────────────────────┘
                      │ Befehl „Signale anwenden“
   ┌──────────────────▼─────────────────────┐
   │ app: RAHMEN                              │
   │  Befehl → Prüfung → Ereignis ins Journal │
   │  → Kern berechnet → Projektion → Push    │
   │  Bedingungen, Ziehung, Status, Audit     │
   │ KERNE (rein, ohne I/O): A · B · C        │
   └───────┬──────────────────────┬─────────┘
           │                      │
     PostgreSQL               Redis
     Journal + Projektionen   Cache, Pub/Sub, Limits
```

Die Architektur ist ein **modularer Monolith**. Es gibt drei Prozesse aus derselben Codebasis:

| Prozess | Aufgabe | Anzahl |
|---|---|---|
| `app` | HTTP-API, WebSocket, Oberflächen, Befehle | 1–n |
| `ingest-worker` | Twitch-Verbindungen, Signale bündeln | 1–n (nach Kanälen aufgeteilt) |
| `scheduler` | Zeitgeber: Fensterende, Boost-Ende, Fristen, Löschfristen | genau 1 |

### 3.2 Stack

- TypeScript auf Node.js (LTS), Fastify für HTTP und WebSocket.
- PostgreSQL als einzige Quelle der Wahrheit.
- Redis nur für abgeleiteten Zustand: Cache, Pub/Sub, Rate-Limits. Ein Ausfall verliert keine Daten.
- SvelteKit für alle Oberflächen.
- Ein Repository für Backend und Frontend.
- Docker Compose, Caddy als Reverse Proxy.

### 3.3 Ein Schreibweg

Jede Zustandsänderung ist ein Befehl. Das gilt für Nutzer, Ingest und Scheduler.
Der Rahmen führt jeden Befehl gleich aus:

1. Rechte prüfen.
2. Aktuellen Zustand des Stroms laden.
3. Befehl gegen den Zustand prüfen.
4. Ereignisse ins Journal schreiben (in einer Transaktion mit der Projektion).
5. Änderung über Redis Pub/Sub an verbundene Oberflächen senden.

Es gibt keinen zweiten Weg. Auch Test- und Simulator-Signale laufen durch diesen Ablauf.

### 3.4 Modulgrenzen

| Modul | Inhalt | Darf nutzen |
|---|---|---|
| `kernel-api` | Typen des Kern-Vertrags | nichts |
| `kernels/*` | je ein Kern | nur `kernel-api` |
| `journal` | Ereignisse schreiben/lesen, Upcaster, Ströme | PG |
| `framework` | Befehle, Lebenszyklus, Bedingungen, Ziehung, Dienste | `kernel-api`, `journal`, Registry |
| `ingest` | Adapter, Bündelung | sendet nur Befehle |
| `identity` | Konten, `identities`, Löschung | PG |
| `api` | HTTP/WS, Rechteprüfung | `framework`, `identity` |
| `web` | SvelteKit-Oberflächen | nur `api` |

Ein Kern importiert nie aus `framework`, `journal`, `ingest` oder einem anderen Kern.
Ein Lint-Regelwerk erzwingt das in CI.

---

## 4. Kern-Vertrag

```ts
interface Kernel<Config, State> {
  id: string;                       // z. B. "watchtime"
  version: number;                  // erhöht sich bei Änderung der Regeln
  label: string;                    // "Zuschauzeit + Follow"
  configSchema: ConfigSchema<Config>; // Parameter mit Default, Wertebereich, Erklärung
  supportedGates: GateId[];         // welche Bedingungen für den Kern Sinn ergeben
  usesServices: ServiceId[];        // z. B. ["watchtime", "chatBonus", "registration"]
  initialState(config: Config): State;
  reduce(state: State, event: KernelEvent, config: Config): State; // rein
  pool(state: State, config: Config): PoolEntry[];               // [{pid, weight}]
  drawMode: "weighted" | "equal" | "highest";
  commands?: KernelCommandSpec[];   // z. B. Ticket kaufen
  decide?(state: State, cmd: KernelCommand, config: Config): KernelEvent[] | Rejection; // rein
  viewerView(state: State, pid: Pid, config: Config): ViewerView; // Status für das Portal
  display: DisplaySpec;             // Einheit, Texte, Spalten, Ansagen-Defaults
}
```

Regeln:

- `reduce`, `pool`, `decide` und `viewerView` sind reine Funktionen. Kein I/O, keine Uhrzeit, kein Zufall.
  Zeit kommt als Feld im Ereignis.
- Ein Kern kennt keine Teams, keine Kanäle als Twitch-Objekte und keine Datenbank.
- Ein Kern bekommt nur Ereignisse, die der Rahmen für ihn freigibt (siehe 6.1).
- Der Rahmen erzeugt aus `configSchema` das Formular im Start-Assistenten.
- Der Rahmen erzeugt aus `display` Tabellenspalten, Kacheln und Chat-Ansagen.
- Ändert sich `version`, baut der Rahmen die Projektion laufender Giveaways neu auf. Abgeschlossene
  Giveaways behalten ihre Version.
- Ein neuer Kern ist ein Verzeichnis unter `kernels/` plus ein Eintrag in der Registry.
  Jeder Kern startet mit `display.beta = true`.

---

## 5. Journal

### 5.1 Ströme und Tabelle

Jedes Ereignis gehört zu genau einem Strom:

| Strom | Inhalt |
|---|---|
| `giveaway:<id>` | alles zu einem Giveaway |
| `team:<id>` | Mitglieder, Kanäle, Einstellungen |
| `account:<id>` | Zustimmungen, Profil, Löschung |
| `platform` | Sperren, Verwarnungen, Nutzungsbedingungen |

Tabelle `events` (append-only, nach Monat partitioniert):

| Spalte | Bedeutung |
|---|---|
| `id` | fortlaufend, global |
| `stream`, `seq` | Strom und Position im Strom |
| `type`, `type_version` | Ereignistyp und Formatversion |
| `payload` | JSONB, enthält nur `pid`, nie Twitch-Name oder Twitch-ID |
| `actor` | Nutzer-ID, `system:ingest`, `system:scheduler` oder `system:twitch` |
| `reason` | Pflicht bei Korrekturen und Umkehrungen |
| `reverses_event_id` | gesetzt bei Umkehrungen |
| `correlation_id` | verbindet Ereignisse eines Befehls |
| `created_at` | Zeitpunkt |

Tabelle `stream_heads (stream, last_seq)`: Jedes Anhängen sperrt die Zeile des Stroms
(`SELECT … FOR UPDATE`) und erhöht `last_seq`. „Erster gewinnt“ entscheidet immer die Datenbank.

### 5.2 Versionierung

Gespeicherte Ereignisse ändern sich nie. Ändert sich ein Format, erhöht sich `type_version`.
Ein Upcaster im Code übersetzt alte Versionen beim Lesen. Jeder Upcaster hat einen Test.

### 5.3 Umkehrbarkeit

Jeder Ereignistyp deklariert seine Umkehrart:

| Art | Wirkung | Beispiele |
|---|---|---|
| `compensate` | Ein Gegen-Ereignis hebt die Wirkung auf. | Ticket-Kauf ↔ Erstattung, Bann ↔ Entbannung, Zeit-Korrektur, Pause ↔ Fortsetzen, Kanal raus ↔ rein |
| `void` | Das Ereignis wird ungültig. Es bleibt sichtbar. | Ziehung → Zustand fällt auf „Geschlossen“ zurück |
| `none` | nicht umkehrbar, die UI nennt den Grund | DSGVO-Löschung, gesendete Chatnachricht |

Der Befehl `revert(eventId, reason)` erzeugt das passende Gegen-Ereignis. Es gibt kein Zeitlimit.
Die UI zeigt an jedem Verlaufseintrag „Rückgängig“ oder den Grund, warum das nicht geht.
Ein aufgehobener Eintrag erscheint durchgestrichen mit Verweis auf die Umkehrung.

### 5.4 Projektionen und Snapshots

- Für jedes Giveaway gibt es Lesetabellen: Teilnehmer mit Gewicht, Topf-Summe, Bedingungsstatus, Statusblock.
- Sie werden in derselben Transaktion wie das Ereignis aktualisiert.
- Lesen geht nie über Replay. Replay dient nur Korrektur, Kern-Versionswechsel und Neuaufbau.
- Alle 1.000 Ereignisse eines Stroms schreibt der Rahmen einen Snapshot des Kern-Zustands.

### 5.5 Audit

Das Journal ist der Nachweis für jede Zustandsänderung. Zusätzlich gibt es `access_log` für:

- Lesezugriffe auf personenbezogene Daten
- abgelehnte Befehle

Ablehnungen werden gedrosselt: höchstens ein Eintrag je (Akteur, Befehl, Grund) in 5 Minuten,
mit Zähler. Das Journal wird nie gelöscht. Nach der Aufbewahrungsfrist werden IP-Adressen in
`access_log` entfernt.

---

## 6. Rahmen-Dienste

### 6.1 Zuschauzeit

- Der Ingest liefert je Live-Kanal einmal pro Minute die Liste der Anwesenden (Helix `Get Chatters`).
- Der Rahmen schreibt daraus ein Ereignis je Giveaway und Minute:
  `watch_credited {minute, entries: [{pid, kanal, sek, faktor}]}`.
- Es zählen nur Kanäle, die im Giveaway aktiv und live sind.
- Während einer Pause zählt nichts.
- **Zählweise pro Giveaway:**
  - **Ab Anmeldung:** Nur angemeldete Teilnehmer bekommen Zeit. Für andere entsteht keine `pid`.
  - **Ab erstem Erscheinen:** Alle Anwesenden bekommen eine `pid` mit Markierung „unangemeldet“.
    Wer sich bis zum Schließen + 7 Tage nicht anmeldet, wird gelöscht (Zuordnung entfernt).
    Die Frist ist pro Giveaway einstellbar.

### 6.2 Chat-Bonus

- An- und abschaltbar pro Giveaway. Werte bleiben beim Abschalten erhalten.
- Defaults: +2 s ab 4 Wörtern, 10 s Cooldown.
- Optional KI-Bewertung statt Wortregel: Anbieter, Modell und eigener Schlüssel pro Team.
  Bei Fehler oder nach 4 s Timeout gilt die Wortregel (fail-open). Schlüssel werden nie geloggt.
- Der Bonus wird pro Kanal und Minute gebündelt: `chat_credited {minute, entries: [{pid, sek}]}`.

### 6.3 Boost

- Faktor und Dauer, gehört genau einem Giveaway.
- Startet nur, wenn mindestens ein Kanal des Giveaways live ist und Signale liefert.
- Gilt für Zuschauzeit und Chat-Bonus.
- Stoppen geht immer. Das Ende setzt der Scheduler per Befehl.

### 6.4 Anmeldung

- Keyword im Chat oder Knopf im Teilnehmer-Portal.
- Die Anmeldung speichert die Fassung der Teilnahmebedingungen des Streamers (siehe 9).
- Rückzug durch den Teilnehmer ist jederzeit möglich, bis zur Ziehung.

### 6.5 Bedingungen

Alle Bedingungen sind pro Giveaway optional. Der Kern nennt in `supportedGates`, welche angeboten werden.

| Bedingung | Optionen |
|---|---|
| Follow | allen Kanälen · mindestens N Kanälen · einem bestimmten Kanal |
| Mindestalter Konto | Twitch-Konto mindestens X Tage alt |
| Mindestalter Follow | Follow mindestens X Tage alt |
| Anwesenheit | Zuschauzeit in mindestens N Kanälen des Giveaways |

- Der Rahmen zeigt den Status laufend an („erfüllt“ / „fehlt: Follow bei kanal_b“).
- Verbindlich prüft er bei der Ziehung, per Helix live.
- Wer eine Bedingung nicht erfüllt, steht im Ziehungsnachweis mit Grund.
- Der Rahmen filtert den Topf vor der Ziehung. Der Kern sieht nur berechtigte Einträge.

---

## 7. Lebenszyklus und Ziehung

### 7.1 Zustände

```
Entwurf → Offen ⇄ Pausiert → Geschlossen → Gezogen → Abgeschlossen
                                  ▲            │
                                  └── void ────┘
Abgebrochen: aus jedem Zustand vor „Abgeschlossen“
```

| Zustand | Sammeln | Anmelden | Ziehen | Regeln ändern |
|---|---|---|---|---|
| Entwurf | nein | nein | nein | ja |
| Offen | ja | ja | nein | ja, wirkt ab jetzt |
| Pausiert | nein | nein | nein | ja |
| Geschlossen | nein | nein | ja | nein |
| Gezogen | nein | nein | Ersatzziehung | nein |
| Abgeschlossen | nein | nein | nein | nein |

- „Geschlossen“ lässt sich wieder öffnen, solange keine gültige Ziehung existiert.
- „Abgeschlossen“ setzt der Streamer, sobald jeder Gewinn den Status „erledigt“ oder „verfallen“ hat.
- „Abgebrochen“ zieht nicht. Kern C erstattet dabei alle Tickets per Gegenbuchung.
- Kern B darf im Zustand „Offen“ mehrere Anmeldefenster öffnen und schließen.
- Jeder Übergang ist ein Ereignis und umkehrbar (außer über `none`-Ereignisse).

### 7.2 Ziehung

1. Der Streamer schließt das Giveaway.
2. Die Vorschau zeigt Topf, Ausschlüsse mit Grund und Chancen.
3. Der Rahmen prüft die Bedingungen live bei Twitch.
4. Der Rahmen zieht mit einer CSPRNG nach dem `drawMode` des Kerns.
5. Das Ereignis `drawn` speichert: Zufallswert, Topf-Hash, Liste `{pid, gewicht}`, Bedingungsprüfung je Teilnehmer, Gewinner.
6. Der Rahmen sagt den Gewinner im Chat an. Diese Ansage lässt sich nicht stummschalten.

Weitere Regeln:

- Die Anzahl der Gewinner ist einstellbar (Default 1).
- Ersatzziehung = vorige Ziehung `void` + neue Ziehung ohne den alten Gewinner. Nie automatisch.
- `highest`: Der höchste Wert gewinnt. Zufall entscheidet nur bei Gleichstand.
- Leerer Topf: kein `drawn`-Ereignis. Der Statusblock erklärt: angemeldet, berechtigt, Ausschlussgründe.

### 7.3 Gewinnerabwicklung

- Die Plattform speichert keine Kontaktdaten der Gewinner.
- Der Gewinner sieht im Portal den Gewinn, die Meldefrist (Default 14 Tage) und den Kontaktweg des Streamers.
- Der Streamer setzt den Status: gemeldet, versendet, erledigt, verfallen. Jeder Status ist ein Ereignis.

---

## 8. Kerne in Version 1

### 8.1 Kern A: Zuschauzeit + Follow (`watchtime`)

- Dienste: Zuschauzeit, Chat-Bonus, Boost, Anmeldung.
- Coins = Zuschauzeit ÷ Coin-Basis (abgerundet).
- Topf: alle mit mindestens 1 Coin. Gewicht = Coins.
- `drawMode`: `weighted`.
- Parameter: Coin-Basis (Default 2 h, Bereich 1 min – 100 h).
- Bedingungen: alle vier.

### 8.2 Kern B: Sofortverlosung (`instant`)

- Dienste: Anmeldung.
- Anmeldefenster öffnen und schließen, mehrfach. Teilnehmer sammeln sich über alle Fenster.
- Topf: alle Angemeldeten. Gewicht = 1.
- `drawMode`: `equal`.
- Parameter: Fensterlänge (Default 2 min, Bereich 10 s – 1 h).
- Keine eingebauten Schwellen. Ob der Gewinner anwesend ist, prüft der Streamer live.
- Bedingungen: Follow, Mindestalter.

### 8.3 Kern C: Ticketkauf (`tickets`)

- Dienste: Zuschauzeit, Chat-Bonus, Boost, Anmeldung.
- Coins landen in einer Geldbörse **pro Giveaway**. Es gibt kein Guthaben über Giveaways hinweg.
- Ticket kaufen: `!ticket <n>` im Chat oder im Portal. Befehl über `decide`.
- Parameter: Preis pro Ticket in Coins, optional Maximum pro Person.
- Ein Rückkauf ist eine Gegenbuchung (`compensate`).
- Topf: alle mit mindestens 1 Ticket. Gewicht = Tickets.
- `drawMode`: `weighted`.
- Ein Giveaway hat einen Preis. Mehrere Preise bedeuten mehrere Giveaways.
- Bedingungen: alle vier.

---

## 9. Konten, Teams, Recht

### 9.1 Konten

- Alle melden sich per Twitch-OAuth an. Streamer und Zuschauer nutzen dasselbe Konto.
- Tabelle `identities (pid, twitch_id, login, display_name, created_at)` ist die einzige Stelle mit Twitch-Daten.
- Ein Twitch-Konto hat genau eine `pid`.

### 9.2 Streamer-Onboarding

1. Mit Twitch anmelden.
2. Kanal verbinden. Scopes: `moderator:read:followers`, `moderator:read:chatters`, `channel:bot`.
3. Nutzungsbedingungen der Plattform akzeptieren (versioniert, erzwungen).
4. Impressum-URL hinterlegen.

### 9.3 Teams

- Jeder Streamer hat automatisch ein Solo-Team. Die UI zeigt das Wort „Team“ dann nicht.
- Ein echtes Team entsteht per Einladungslink.
- Alle Mitglieder sind gleichberechtigt. Jedes Mitglied darf jedes Team-Giveaway steuern.
- Funktionen: einladen, verlassen, umbenennen, deaktivieren. Deaktivieren löscht keine Nachweise.
- Ein Streamer darf in mehreren Teams sein.
- Die Kanalliste eines Giveaways ist eine Teilmenge der Team-Kanäle.
- Jedes Mitglied kann seinen eigenen Kanal aus einem laufenden Giveaway nehmen und wieder hinzufügen.

### 9.4 Rechtliche Verantwortung

- **Plattform:** eigenes Impressum, Datenschutzerklärung, Nutzungsbedingungen für Streamer.
- **Streamer:** hinterlegt pro Giveaway oder im Profil Impressum (URL), Teilnahmebedingungen (Text oder URL) und Datenschutzhinweis (URL).
- Ohne diese drei Angaben öffnet kein Giveaway.
- Beim Öffnen friert der Rahmen die Fassung ein: Text als Kopie, URL mit Hash des Inhalts zum Zeitpunkt.
- Die Plattform liefert eine Checkliste der nötigen Inhalte. Sie liefert keine Mustertexte.

---

## 10. Twitch-Anbindung

### 10.1 Adapter-Schnittstelle

```ts
interface IngestAdapter {
  start(channels: ChannelRef[]): Promise<void>;
  stop(channel: ChannelRef): Promise<void>;
  onSignal(handler: (s: Signal) => void): void;
  sendChat(channel: ChannelRef, text: string): Promise<SendResult>;
  checkFollows(channel: ChannelRef, users: TwitchUserId[]): Promise<FollowResult[]>;
  health(): AdapterHealth[];
}
type Signal =
  | { kind: "presence"; channel; minute; users: TwitchUser[] }
  | { kind: "chat"; channel; at; user: TwitchUser; text: string }
  | { kind: "follow"; channel; at; user: TwitchUser }
  | { kind: "stream_state"; channel; at; live: boolean };
```

Version 1 hat zwei Adapter: `twitch` und `simulator`.

### 10.2 Twitch-Adapter

| Zweck | Quelle |
|---|---|
| Chat lesen | EventSub `channel.chat.message` über einen Plattform-Bot-Account, Transport über Conduits mit Shards |
| Anwesenheit | Helix `Get Chatters`, jede Minute je Live-Kanal, Token des Streamers |
| Live-Status | EventSub `stream.online` / `stream.offline` |
| Follows | Helix `Get Channel Followers`, mit Cache, verbindlich bei Ziehung |
| Chat senden | Helix `Send Chat Message` als Bot |

- Der Streamer erlaubt den Bot über `channel:bot`. Eine Mod-Rolle ist nicht nötig.
- Tokens liegen AES-256-GCM-verschlüsselt in PG. Der Master-Schlüssel liegt außerhalb der Datenbank (Secret-Datei).
- Token-Refresh läuft automatisch. Schlägt er fehl, wird der Kanal im Statusblock rot.
- Kanäle werden per konsistentem Hash auf Worker verteilt.

### 10.3 Chat-Ansagen

- Katalog mit Default-Texten je Rahmen und Kern.
- Pro Giveaway überschreibbar, mit Platzhaltern in deutscher Sprache (`{gewinner}`, `{preis}`).
- Links stehen nie im Text. Sie werden per Haken angehängt.
- Ansagen lassen sich pro Giveaway stumm schalten. Die Gewinneransage bleibt immer an.
- Jede gesendete Ansage ist ein Ereignis mit Umkehrart `none`.

---

## 11. Oberflächen

### 11.1 Streamer-App

- **Übersicht:** Verbindungsstatus je Kanal, eine Kachel je Giveaway, Abgeschlossene mit Meldefrist.
- **Giveaway-Detail:** Statusblock, Warnstreifen, Aktionsleiste, Teilnehmerliste mit Chance, Verlauf mit „Rückgängig“.
- **Start-Assistent:** Kern → Preis und Regeln → Kanäle → Bedingungen → Rechtstexte → Prüfen und öffnen.
  Daneben eine Live-Vorschau, wie viele Teilnehmer die Bedingungen erfüllen.
- **Team, Kanäle, Rechtstexte, Chat-Ansagen.**
- **Streamermodus:** maskiert Namen und Tokens. Jede neue Ansicht mit Namen muss ihn beachten.
- Keine Browser-Dialoge (`prompt`, `alert`, `confirm`).

### 11.2 Statusblock

Jedes Giveaway zeigt:

- Zustand (Wort + Icon)
- aktuelle Tätigkeit mit Fortschritt, z. B. „Prüft Follows für 214 Teilnehmer“
- Topf: berechtigt, nicht berechtigt, letzte Berechnung
- je Kanal: live/offline, letztes Signal, Zuschauerzahl, Abdeckung (Chatters ÷ Zuschauer).
  Die Zuschauerzahl kommt aus Helix `Get Streams` und dient nur der Diagnose.

Warnungen:

| Lage | Anzeige |
|---|---|
| Live-Kanal ohne Signal > 2 min | gelb, „Kanal neu verbinden“ |
| Token abgelaufen oder Scope fehlt | rot, „Kanal neu verbinden“ |
| Abdeckung unter 50 % | Hinweis |
| Boost gesperrt (kein Signal) | Grund am Knopf |

### 11.3 Teilnehmer-Portal

- Liste der eigenen Giveaways, laufend und vergangen.
- Pro Giveaway: Status, Bedingungen mit Grund, eigene Zeit/Coins/Tickets je Kanal, Chance live.
- Teilnehmen, Teilnahme zurückziehen, Tickets kaufen (Kern C).
- Rechtstexte des Streamers je Giveaway.
- Gewinn: Hinweis, Frist, Kontaktweg des Streamers.
- **Meine Daten:** ansehen, als JSON herunterladen, alles löschen.

### 11.4 Plattform-Verwaltung (Superadmin)

- Betrieb: Health, Ingest je Kanal, Fehler, Browser-Fehler.
- Sperren und Verwarnungen für Streamer.
- Rückmeldungen.

### 11.5 Design

- RDOC-Brandkit, Tokens aus `brandkit/rdoc/digital/web/brand.css`.
- Dark ist der Standard. Light über `prefers-color-scheme` und `data-theme`.
- Genau ein Kupfer-Element je Ansicht: die Hauptaktion.
- Patina nur für Struktur: Tabellenköpfe, Abschnittsmarken, aktive Navigation.
- Zustände immer als Wort + Icon, nie nur Farbe.
- Michroma 400 nur für Überschriften. IBM Plex Sans 400/600 für Text. IBM Plex Mono für Labels und Code.
- Keine Schatten, Verläufe oder Glüheffekte.
- Fehler im Brandkit, die der Neubau korrigiert: Überschriften in `brand.css` stehen auf 500 (richtig: 400).
  `tailwind.rdoc.js` hat kaputte Statusfarben und wird nicht genutzt.
- Kontrast nach WCAG: Text 4,5:1, große Schrift und UI 3:1.
  Steel-Text auf Graphite-Fläche erfüllt das nicht. Gedämpfter Text steht nur auf dem Hintergrund.

### 11.6 Texte

- Die Regeln aus `TEXT-GET-RULES/videos/ep01-the-cure-for-ai-slop` (STE), auf Deutsch übertragen:
  - Ein Begriff pro Ding (Glossar, Abschnitt 2).
  - Anweisungen höchstens 20 Wörter, Beschreibungen höchstens 25.
  - Aktiv statt Passiv, wenn der Handelnde bekannt ist.
  - Verb statt Substantivierung („prüfen“, nicht „eine Prüfung durchführen“).
  - Keine Werbewörter („nahtlos“, „leistungsstark“, „revolutionär“ …).
  - Bedingung vor Befehl.
  - Kein Semikolon.
  - Fehlertexte: was passiert ist + was zu tun ist.
- Ein deutscher Linter (Bannliste + Satzlänge + Passiv-Heuristik) prüft alle UI-Texte in CI.

---

## 12. Fehlerbehandlung, Tests, Betrieb

### 12.1 Fehler

Prinzip: Kein Fehler bleibt still. Jeder Fehler erscheint im Statusblock mit Ursache und nächstem Schritt.

| Fehler | Verhalten |
|---|---|
| Befehl abgelehnt | Grund in Klartext an die UI, Eintrag in `access_log` (gedrosselt) |
| Konflikt beim Anhängen (`seq`) | Befehl einmal neu ausführen, dann Fehler melden |
| Redis-Ausfall | Cache aus PG neu aufbauen, UI zeigt „verbindet neu“ |
| Twitch-API-Fehler | Wiederholung mit Backoff, nach 3 Versuchen Warnung im Statusblock |
| Helix bei Ziehung nicht erreichbar | Ziehung bricht ab, Grund wird angezeigt, kein Ereignis |
| KI-Bewertung fällt aus | Wortregel |

### 12.2 Tests

| Ebene | Werkzeug | Inhalt |
|---|---|---|
| Kerne | `node:test` / Vitest | Tabellen-Tests, Property-Tests (Gewicht ≥ 0, Topf deterministisch) |
| Journal | Testcontainers mit PG | Anhängen, Gleichzeitigkeit, Upcaster, Partitionen |
| Replay | Testcontainers | Neuaufbau = inkrementeller Stand |
| Ingest | Simulator + aufgezeichnete Twitch-Payloads | Bündelung, Fehlerfälle |
| Last | Simulator | 1.000 Kanäle × 200 Zuschauer, Ziel: < 100 ms je Befehl im p95 |
| E2E | Playwright | Starten, Pausieren, Ziehen, Rückgängig, Löschen |
| Texte | eigener Linter | Regeln aus 11.6 |
| Architektur | Lint-Regel | Kerne importieren nur `kernel-api` |

CI: GitHub Actions mit Typecheck, Lint, allen Tests. Kein Merge ohne grüne CI.

### 12.3 Betrieb

- Docker Compose: `app`, `ingest-worker`, `scheduler`, PostgreSQL, Redis, Caddy.
- Ziel: LXC 103, eigene Domain oder eigener Subpfad neben dem Altsystem.
- Konfiguration ist typisiert und wird beim Start geprüft. Fehlt ein Pflichtwert, startet der Prozess nicht.
- Migrationen sind versioniert und die einzige Quelle für das Schema.
- Tägliche Backups, monatliche Restore-Probe.

### 12.4 Datenschutz-Fristen

| Daten | Frist |
|---|---|
| Unangemeldete `pid` (Zählweise „ab erstem Erscheinen“) | Schließen + 7 Tage (einstellbar) |
| Inaktives Teilnehmerkonto | 12 Monate ohne Teilnahme → Zuordnung entfernt |
| IP-Adressen in `access_log` | 30 Tage |
| Browser-Fehler | 30 Tage, ohne Personenbezug |
| Journal | unbegrenzt, nur pseudonym |

Löschen heißt: Die Zeile in `identities` wird entfernt. Das Journal zeigt danach „gelöschter Teilnehmer #<kurz-id>“.

### 12.5 Ablösung des Altsystems

- Neues Repository, Neubau. Kein Code wird übernommen. Kern-Testfälle des Altsystems dienen als Referenz.
- Parallelbetrieb: Das Altsystem führt laufende Giveaways zu Ende. Neue Giveaways starten nur im Neubau.
- Danach wird das Altsystem nur noch lesbar. Ziehungsnachweise und Audit gehen als tar.gz ins Archiv.
- DSGVO-Anfragen zu Altdaten bedient das Altsystem bis zum Ende der Aufbewahrungsfrist.
- Kein Datenimport.

---

## 13. Entscheidungsprotokoll

| # | Frage | Entscheidung |
|---|---|---|
| 1 | Zielgruppe | Offene Plattform für alle Twitch-Streamer |
| 2 | Twitch-Anbindung | Direkt über die Twitch-API, Adapter-Schicht, Simulator; Streamer.bot später optional |
| 3 | Reversibilität | Gegenbuchung im Journal; Ziehung wird ungültig erklärt; Ausnahmen: DSGVO-Löschung, gesendete Chatnachricht |
| 4 | Bedingungen | Follow-Regel, Mindestalter Konto/Follow, Anwesenheit in N Kanälen; alle optional pro Giveaway; keine Abo-/VIP-Regeln |
| 5 | Team-Rechte | Alle Mitglieder gleichberechtigt |
| 6 | Gewinner-Kontaktdaten | Plattform speichert keine |
| 7 | Neue Kerne | Code-Plugins vom Betreiber, fester Vertrag |
| 8 | Architektur | Modularer Monolith, PG-Journal als einzige Wahrheit, Bündelung, Partitionierung, Projektionen, Redis nur als Cache |
| 9 | Zählweise der Zuschauzeit | Pro Giveaway wählbar: ab Anmeldung oder ab erstem Erscheinen |
| 10 | Geldbörse Kern C | Pro Giveaway, nicht team-weit |
| 11 | Mustertexte Recht | Keine, nur Checkliste |
| 12 | Altdaten | Archiv, kein Import |
| 13 | Spec-Ort | `NEW_DESIGN.md` im Repo CC-Giveaway-NG, Pflichtverweis in beiden `CLAUDE.md` |

---

## 14. Teilprojekte und Reihenfolge

Jedes Teilprojekt bekommt einen eigenen Umsetzungsplan.

1. **Fundament:** Repo, CI, Konfiguration, Migrationen, Journal, `stream_heads`, Upcaster, Befehlsablauf, `access_log`.
2. **Kern-Vertrag + Kern B:** `kernel-api`, Registry, Lebenszyklus, Ziehung, Kern B als erster Kern (kleinster Umfang).
3. **Konten + Identität:** Twitch-OAuth, `identities`, Löschung, Nutzungsbedingungen, Impressum-Pflicht.
4. **Ingest:** Adapter-Schnittstelle, Simulator, Twitch-Adapter, Statusblock-Daten.
5. **Rahmen-Dienste + Kern A:** Zuschauzeit, Chat-Bonus, Boost, Bedingungen, Kern A.
6. **Kern C:** Geldbörse, Ticket-Befehle.
7. **Teams.**
8. **Oberflächen:** Streamer-App, Teilnehmer-Portal, Plattform-Verwaltung. Teile davon wachsen ab Teilprojekt 2 mit.
9. **Lasttest, Betrieb, Ablösung.**
