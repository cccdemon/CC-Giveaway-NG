# Teilprojekt 8d: Chat-Ansagen – Umsetzungsplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Chat-Ansagen aus NEW_DESIGN.md 10.3 und 7.2 Schritt 6: ein Katalog mit Default-Texten je Rahmen und Kern, je Giveaway überschreibbar mit deutschen Platzhaltern, Links nur per Haken, stummschaltbar bis auf die Gewinneransage, jede gesendete Ansage ein Ereignis mit Umkehrart `none`, Versand über den Bot aus dem Ingest, Pflege im Start-Assistenten und in den Einstellungen.

**Architecture:** Der Rahmen kennt die Ansage-Arten (`AnnouncementKind`) und ihre Default-Texte (`framework/giveaway/announcements.ts`), Kerne liefern Defaults für ihre Ereignisse über `display.announcements`. Die Einstellungen eines Giveaways bekommen `announcements: { muted, links, texts }` (Ereignisse v4 mit Upcaster 3→4). Die Lesetabelle `giveaways` bekommt `keyword` und `announcements`, damit der Ingest ohne Replay planen kann. Der Ingest hört über den Subscriber auf alle Giveaway-Ereignisse (Redis Pub/Sub, `subscribeAll`), plant je Ereignis rein (`planAnnouncements`), sendet je Kanal, den dieser Worker besitzt, über `adapter.sendChat`, und meldet das Ergebnis als Befehl `record_announcement` (Akteur `system:ingest`) → Ereignis `announcement_sent { kind, channel, triggerEventId, ok, error? }` ohne Text (Payloads tragen keine Chat-Texte, der Text ist aus Katalog und Einstellungen reproduzierbar). Die Web-App pflegt Ansagen in Assistent und Einstellungen und zeigt gesendete Ansagen im Verlauf.

**Tech Stack:** wie bisher. Keine neue Abhängigkeit.

**Spec:** `NEW_DESIGN.md` 3.3, 3.4 (Ingest sendet nur Befehle), 4 (`display` liefert Ansagen-Defaults), 5.3 (`none` für gesendete Chatnachricht), 7.2 Schritt 6, 10.1 (`sendChat`), 10.2 (Senden als Bot), 10.3, 11.1 („Chat-Ansagen“), 11.6, 12.1.

## Global Constraints

- Ansagen entstehen nur aus Ereignissen des Journals (Pub/Sub nach Commit). Der Ingest schreibt nie ins Journal, er sendet den Befehl `record_announcement`.
- `announcement_sent` trägt `kind`, `channel` (pid), `triggerEventId`, `ok`, optional `error` (Code) und `messageId` (Twitch-Nachrichten-ID). Nie den Text, nie Namen.
- Die Gewinneransage (`winner`) lässt sich nicht stummschalten und nicht leeren.
- Links stehen nie im Text einer Vorlage (`https?://` ist in Vorlagen verboten, `invalid_announcement`). Mit `links: true` hängt der Rahmen ` PUBLIC_URL/g/<id>` an.
- Jede Vorlage höchstens 400 Zeichen, nur Platzhalter ihrer Art; gerendert höchstens 500 Zeichen (Twitch).
- Texte deutsch nach 11.6, Linter prüft Default-Texte (sie stehen als `text:`-Zeichenketten).
- Je Task erst Code, dann `typecheck`, `lint`, `test`.

## Entscheidungen, die die Spec offen lässt (meine Festlegungen)

1. **Ansage-Arten des Rahmens:** `opened`, `paused`, `resumed`, `closed`, `winner`, `boost_started`, `boost_ended`. Auslöser: `giveaway_status_changed` (`to` = open mit `from` draft → `opened`, from paused → `resumed`; `to` = paused → `paused`; `to` = closed → `closed`), `giveaway_drawn` → `winner`, `boost_started`, `boost_ended`. Kern-Arten heißen wie der Kern-Ereignistyp (`instant_window_opened`, `instant_window_closed`); Kerne liefern Defaults in `display.announcements: Record<eventType, string>`; `watchtime` und `tickets` liefern keine.
2. **Platzhalter** (deutsch, geschweifte Klammern): `{preis}`, `{keyword}`, `{gewinner}` (Anzeigenamen, mit „, “ verbunden), `{frist}` (Meldefrist in Tagen), `{faktor}`, `{dauer}` (Boostdauer lesbar), `{bis}` (Uhrzeit HH:MM des Fensterendes, Zeitzone Europe/Berlin). Erlaubt je Art: `opened`/`paused`/`resumed`/`closed`: `{preis}`, `{keyword}`; `winner`: `{preis}`, `{gewinner}`, `{frist}`; `boost_started`: `{preis}`, `{faktor}`, `{dauer}`; `boost_ended`: `{preis}`; Kern-Arten: `{preis}`, `{keyword}` plus `{bis}` für `instant_window_opened`. Unbekannte Platzhalter → `invalid_announcement`. Ohne Keyword fällt `{keyword}` samt vorangestelltem Leerzeichen weg (Text bleibt lesbar: Satz „Schreib {keyword} in den Chat.“ wird zu „Schreib in den Chat.“? Nein: Defaults mit Keyword stehen in einem eigenen Satz, der ganz entfällt, wenn das Keyword fehlt: Marker `[[keyword: …]]` ist zu komplex – stattdessen hat jede Art mit `{keyword}` zwei Defaults: `withKeyword` und `withoutKeyword`; eigene Vorlagen mit `{keyword}` ohne Keyword rendern den Platzhalter als „im Portal“.)
3. **Einstellungen:** `GiveawaySettings.announcements: { muted: boolean; links: boolean; texts: Partial<Record<kind, string>> }`, Default `{ muted: false, links: true, texts: {} }`. Ereignisse `giveaway_created`/`giveaway_settings_changed` v4, Upcaster 3→4 setzt den Default. Änderbar wie alle Regeln (Entwurf, Offen, Pausiert).
4. **Wer sendet:** der Ingest-Worker, dem der Kanal gehört (`shardOf`), je Kanal des Giveaways, der verbunden ist und ein gültiges Token hat (Kanalverzeichnis). Kanäle ohne Verbindung bekommen `announcement_sent { ok: false, error: 'channel_offline' }`? Nein: nur Kanäle, die der Worker beobachtet (im Verzeichnis). Für andere Kanäle gibt es kein Ereignis (nichts wurde versucht).
5. **Reihenfolge und Doppelsendung:** Redis liefert je Ereignis einmal je Prozess. Zwei Worker teilen sich Kanäle disjunkt, also keine Doppelsendung. Startet der Ingest neu, verpasst er Ereignisse der Lücke (Ansagen sind Begleitung, keine Nachweise). Ein Ereignis löst je Kanal höchstens eine Ansage aus (`seen` je `triggerEventId:channel` im Speicher, Obergrenze 10 000).
6. **Fehler nicht still:** `sendChat` liefert `{ ok: false, reason }` → `announcement_sent { ok: false, error: reason }`; der Verlauf zeigt „Ansage fehlgeschlagen: …“. Zusätzlich `channel_status.problem = 'twitch_error'` bleibt Sache des Adapters.
7. **Lesetabelle:** Migration `009_announcements.sql`: `giveaways` + `keyword TEXT`, `announcements JSONB NOT NULL DEFAULT '{"muted":false,"links":true,"texts":{}}'`. Der Projektor schreibt beide. Der Ingest plant aus dieser Zeile plus Kern-Display und Anzeigenamen der Gewinner (`identities`, Lesetabelle).
8. **Öffentlicher Link:** `PUBLIC_URL/g/<giveawayId>` (Seite aus 8b). Der Ingest braucht `publicUrl` aus der Konfiguration.
9. **API:** `GET /api/announcements` (Sitzung) liefert den Katalog: Arten des Rahmens mit Default-Texten und erlaubten Platzhaltern, dazu je Kern dessen Arten (`/api/kernels` liefert `display.announcements` schon mit). `PUT /giveaways/:id/settings` nimmt `announcements` wie alle Felder.
10. **Web:** `AnnouncementsForm` (Stummschalten, Links, je Art ein Textfeld mit Default als Platzhalter und Hinweis auf die Platzhalter, „Zurücksetzen“ je Art) in Assistent Schritt 2 (aufklappbar) und im Einstellungs-Panel. Verlauf: `announcement_sent` → „Ansage „Geöffnet“ an kanal_x gesendet.“ bzw. „Ansage … an kanal_x fehlgeschlagen: …“.
11. **Simulator:** `SimulatorAdapter.sendChat` protokolliert schon (`sent`). Keine Änderung nötig.
12. **Nicht hier:** KI-Bewertung (6.2), Streamer.bot-Adapter, Caddy/Lasttest (10).

## Review Focus

1. Stummschaltung: `muted: true` unterdrückt alles außer `winner`; `winner` lässt sich weder stummschalten noch leeren. Test in Task 1 (Planung) und Task 2 (Ingest).
2. Nur der Worker, dem der Kanal gehört, sendet; ein Ereignis löst je Kanal genau eine Ansage aus, auch wenn Redis es doppelt liefert. Test in Task 2.
3. Vorlagen mit Link oder unbekanntem Platzhalter lehnt `change_settings` ab; `{gewinner}` rendert Anzeigenamen, nie pids. Test in Task 1.
4. Ein fehlgeschlagener Versand erzeugt `announcement_sent { ok: false }` und erscheint im Verlauf, kein stiller Fehler. Test in Task 2 und Task 3.
5. Ereignisse v3 (ohne `announcements`) lesen sich mit Default. Test in Task 1.

---

## Dateistruktur

```
packages/server/src/kernel-api/index.ts                      DisplaySpec.announcements
packages/server/src/kernels/instant/index.ts                 Defaults für window_opened/window_closed
packages/server/src/kernels/{watchtime,tickets}/index.ts     announcements: {}
packages/server/src/framework/giveaway/announcements.ts      Kinds, Defaults, Platzhalter, validateAnnouncements, renderAnnouncement, planAnnouncements, record_announcement
packages/server/src/framework/giveaway/events.ts             settingsSchema v4, Upcaster 3→4, announcement_sent
packages/server/src/framework/giveaway/services.ts           upcastSettingsV3, ANNOUNCEMENT_DEFAULTS
packages/server/src/framework/giveaway/state.ts              GiveawaySettings.announcements
packages/server/src/framework/giveaway/lifecycle.ts          checkSettings → validateAnnouncements
packages/server/src/framework/giveaway/projectors.ts         keyword, announcements
packages/server/src/framework/runtime.ts                     handlers.recordAnnouncement
packages/server/migrations/009_announcements.sql
packages/server/src/framework/subscriber.ts                  subscribeAll
packages/server/src/ingest/announcer.ts                      Announcer: Ereignis → Plan → sendChat → record_announcement
packages/server/src/ingest/{build,worker,main}.ts            Verdrahtung, Subscriber, publicUrl
packages/server/src/api/giveaways.ts                         GET /announcements
packages/server/test/announcements.test.ts, announcer.test.ts, event-types/lifecycle (+), api-giveaways (+)
packages/web/src/lib/api/types.ts                            AnnouncementSettings, AnnouncementCatalog
packages/web/src/lib/components/AnnouncementsForm.svelte
packages/web/src/lib/wizard.ts, routes/giveaways/new/+page.svelte, lib/components/SettingsPanel.svelte, routes/giveaways/[id]/+page.ts
packages/web/src/lib/history-text.ts, texts/*
README.md, CLAUDE.md
```

---

### Task 1: Katalog, Einstellungen v4, Planung, Ereignis `announcement_sent`

**Files:**
- Create: `src/framework/giveaway/announcements.ts`, `migrations/009_announcements.sql`
- Modify: `src/kernel-api/index.ts`, `src/kernels/*/index.ts`, `src/framework/giveaway/{events,services,state,lifecycle,projectors}.ts`, `src/framework/runtime.ts`
- Test: `test/announcements.test.ts`, `test/lifecycle.test.ts` (+), `test/giveaway-state.test.ts` (+ Upcaster)

**Interfaces:**
- Produces (`kernel-api`): `DisplaySpec.announcements: Record<string, string>` (Ereignistyp → Default-Vorlage).
- Produces (`announcements.ts`):
  ```ts
  export type FrameworkKind = 'opened' | 'paused' | 'resumed' | 'closed' | 'winner' | 'boost_started' | 'boost_ended';
  export const FRAMEWORK_KINDS: readonly FrameworkKind[];
  export const PLACEHOLDERS: Record<FrameworkKind, readonly string[]>;   // Festlegung 2
  export const DEFAULTS: Record<FrameworkKind, { text: string; withoutKeyword?: string }>;
  export interface AnnouncementSettings { muted: boolean; links: boolean; texts: Record<string, string> }
  export const ANNOUNCEMENT_DEFAULTS: AnnouncementSettings;
  export const TEMPLATE_MAX = 400; export const MESSAGE_MAX = 500;
  export function kindsFor(kernel: AnyKernel): { kind: string; placeholders: readonly string[]; default: string }[];   // Rahmen + Kern
  export function validateAnnouncements(a: unknown, kernel: AnyKernel): AnnouncementSettings | Rejection;   // invalid_announcement
  export interface RenderInput { prize: string; keyword: string | null; winners?: string[]; claimDays?: number; factor?: number; durationSec?: number; until?: string; link?: string }
  export function renderAnnouncement(template: string, input: RenderInput): string;   // ersetzt Platzhalter, hängt link an, kürzt auf MESSAGE_MAX
  export interface AnnouncementPlan { kind: string; text: string }
  export function planAnnouncement(event: Pick<EventRecord, 'type' | 'payload'>, giveaway: { prize: string; keyword: string | null; claimDays: number; announcements: AnnouncementSettings; kernel: AnyKernel; publicUrl: string; id: string }, names: Record<string, string>): AnnouncementPlan | null;   // null = keine Ansage (stumm, unbekannter Typ)
  export const ANNOUNCEMENT_SENT = 'announcement_sent';
  export interface RecordAnnouncementCmd { giveawayId: string; kind: string; channel: Pid; triggerEventId: string; ok: boolean; error?: string; messageId?: string }
  export function recordAnnouncementHandler(d: GiveawayDeps): CommandHandler<RecordAnnouncementCmd, GiveawayState>;   // nur system:ingest, in jedem Zustand außer Entwurf
  ```
- Produces (`events.ts`): `announcement_sent` v1, Schema `{ kind: string, channel: uuid, triggerEventId: string, ok: boolean, error?: string, messageId?: string }`, `reversal: none` „Eine gesendete Chatnachricht bleibt gesendet.“; `giveaway_created`/`giveaway_settings_changed` v4 mit `upcasters[3] = v3.*` (`upcastSettingsV3` setzt `announcements: ANNOUNCEMENT_DEFAULTS`).
- Produces (`state.ts`): `GiveawaySettings.announcements: AnnouncementSettings`; Reducer ignoriert `announcement_sent` (kein Zustand).
- Produces (`lifecycle.ts`): `checkSettings` ruft `validateAnnouncements(s.announcements ?? ANNOUNCEMENT_DEFAULTS, kernel)`.
- Produces (`projectors.ts`, `009_announcements.sql`): Spalten `keyword`, `announcements`.
- Produces (`runtime.ts`): `rt.handlers.recordAnnouncement`.

- [ ] **Step 1: Tests schreiben**

```ts
// announcements.test.ts
it('renderAnnouncement replaces {preis}, {keyword}, {gewinner}, {frist}, {faktor}, {dauer}, {bis}, appends the link and cuts at 500', ...);
it('planAnnouncement maps status changes, draws and boosts to kinds; muted suppresses all but winner; winner uses display names, never pids', ...);   // RF 1, 3
it('planAnnouncement falls back to the without-keyword default and renders {keyword} as „im Portal“ in own templates', ...);
it('validateAnnouncements rejects links, unknown placeholders, over-long templates, empty winner text and muted winner; accepts kernel kinds', ...);   // RF 3
it('kindsFor lists framework kinds plus instant window kinds with defaults', ...);
// lifecycle.test.ts (+)
it('create and change_settings accept announcements and reject a template with a link; record_announcement writes announcement_sent only for system:ingest and never in draft', ...);
// giveaway-state.test.ts (+)
it('v3 created/settings events upcast to v4 with default announcements', ...);   // RF 5
```

- [ ] **Step 2: Tests laufen lassen, sie scheitern**
- [ ] **Step 3: Implementieren**
- [ ] **Step 4: Prüfen**
- [ ] **Step 5: Commit** `feat(giveaway): Chat-Ansagen mit Katalog, Platzhaltern, Einstellungen v4 und Ereignis announcement_sent`

---

### Task 2: Ingest sendet Ansagen

**Files:**
- Create: `src/ingest/announcer.ts`
- Modify: `src/framework/subscriber.ts` (`subscribeAll`), `src/ingest/{build,worker,main}.ts`, `src/config/config.ts` (nichts neu: `publicUrl` existiert)
- Test: `test/announcer.test.ts`, `test/publisher.test.ts` (+ `subscribeAll` für LocalBus)

**Interfaces:**
- Produces (`subscriber.ts`): `Subscriber.subscribeAll(fn: (stream: StreamId, events: EventRecord[]) => void): () => void` in `LocalBus` und `RedisSubscriber`.
- Produces (`announcer.ts`):
  ```ts
  export interface AnnouncerOptions { pool: pg.Pool; rt: Runtime; adapter: IngestAdapter; directory: { current(): ChannelRef[] }; publicUrl: string; log: BusLogger; now?: () => Date }
  export class Announcer {
    constructor(o: AnnouncerOptions);
    /** Ein Bündel Ereignisse eines Giveaway-Stroms: plant, sendet je eigenem Kanal, meldet. */
    handle(stream: StreamId, events: EventRecord[]): Promise<{ sent: number; failed: number; skipped: number }>;
    attach(subscriber: Subscriber): () => void;   // subscribeAll
  }
  ```
  `handle`: nur `giveaway:`-Ströme; lädt `giveaways`-Zeile (`prize, keyword, claim_days, channels, announcements, kernel, status`), Kern aus `rt.kernels`; je Ereignis `planAnnouncement`; Kanäle = `channels ∩ directory.current() mit owned`; `seen`-Set `${eventId}:${channel}`; `adapter.sendChat(ref, text)`; danach `rt.bus.execute(rt.handlers.recordAnnouncement, {...}, { actor: 'system:ingest', … })`; Ablehnungen und Fehler werden geloggt, nie geworfen.
- Produces (`worker.ts`/`build.ts`): `IngestWorkerOptions.subscriber?: Subscriber`, `publicUrl: string`; der Worker baut den `Announcer` mit dem `Directory` und hängt ihn beim Start an, löst beim Stopp. `IngestWorker` exportiert `announcer` für Tests. `main.ts`: `RedisSubscriber` (eigene Verbindung), `publicUrl: config.publicUrl`.

- [ ] **Step 1: Tests schreiben** (`setupGiveaway({ publisher: bus })` mit `LocalBus`, `SimulatorAdapter` oder Fake-Adapter mit `sent`)

```ts
// publisher.test.ts (+)
it('LocalBus.subscribeAll receives every stream and the returned function unsubscribes', ...);
// announcer.test.ts
it('sends the opened announcement to the owned channels of an open giveaway with the link and records announcement_sent per channel', ...);
it('does not send for channels another worker owns, and sends once per event and channel even if the bus delivers twice', ...);   // RF 2
it('muted giveaway: no announcement for pause/resume/close, but the winner announcement is sent with display names', ...);   // RF 1
it('a failing sendChat records announcement_sent with ok false and the reason; the run continues', ...);   // RF 4
it('instant window_opened uses the kernel default with {bis}; unknown event types produce nothing', ...);
```

- [ ] **Step 2: Tests laufen lassen, sie scheitern**
- [ ] **Step 3: Implementieren**
- [ ] **Step 4: Prüfen**
- [ ] **Step 5: Commit** `feat(ingest): Ansagen senden und als announcement_sent melden`

---

### Task 3: API und Web: Katalog, Formular, Verlauf

**Files:**
- Modify: `src/api/giveaways.ts` (`GET /announcements`), `test/api-giveaways.test.ts` (+)
- Web: Create `src/lib/components/AnnouncementsForm.svelte`; Modify `src/lib/api/types.ts`, `src/lib/wizard.ts`, `src/routes/giveaways/new/+page.ts`, `+page.svelte`, `src/lib/components/SettingsPanel.svelte`, `src/routes/giveaways/[id]/+page.ts`, `src/lib/history-text.ts`, `src/lib/texts/*`
- Test: `src/lib/components/AnnouncementsForm.test.ts`, `src/lib/history-text.test.ts` (+), `src/lib/wizard.test.ts` (+)

**Interfaces:**
- Produces (`giveaways.ts`): `GET /api/announcements` → `{ kinds: [{ kind, label, default, placeholders, kernel: string | null }] }` für den Rahmen plus alle Kerne (Label aus `L`? Nein: Server liefert `kind`; Labels je Art stehen in der Web-App).
- Produces (web `types.ts`): `AnnouncementSettings`, `AnnouncementKind { kind; default; placeholders; kernel: string | null }`, `GiveawaySettings.announcements`, `CreateSettings` nimmt `announcements`.
- Produces (`AnnouncementsForm { kinds: AnnouncementKind[]; kernelId: string; value: AnnouncementSettings; onchange; errors? }`): Schalter „Ansagen stumm“ (Hinweis: Gewinneransage bleibt), Schalter „Link anhängen“, je Art (Rahmen + passender Kern) ein Textfeld mit Default als `placeholder`, Platzhalter-Hinweis, Knopf „Zurücksetzen“ (löscht den Eintrag). Prüfung vor dem Senden in `wizard.ts`: `validateAnnouncements(a, kinds)` (Link, unbekannter Platzhalter, Länge 400, `winner` nicht leer) mit Fehlertexten; `stepOfRejection('invalid_announcement') → 2`.
- Produces (`history-text.ts`): `announcement_sent` → `S.history.announced(label, channel)` / `S.history.announcementFailed(label, channel, error)`; Labels je Art in `L.announcements.kinds`.
- Produces (Assistent): Schritt 2 bekommt `<details>` „Chat-Ansagen“ mit dem Formular; `toSettings` liefert `announcements`. Einstellungs-Panel: Abschnitt „Chat-Ansagen“. `/giveaways/[id]/+page.ts` und `/giveaways/new/+page.ts` laden `GET /api/announcements`.

- [ ] **Step 1: Tests schreiben**

```ts
// api-giveaways.test.ts (+)
it('GET /api/announcements lists framework kinds with defaults and placeholders plus instant window kinds', ...);
// AnnouncementsForm.test.ts
it('shows a field per kind with the default as placeholder, emits texts, muted and links; winner cannot be muted; reset clears an entry', ...);
// wizard.test.ts (+)
it('validateStep 2 rejects an announcement template with a link or unknown placeholder and an empty winner text', ...);
// history-text.test.ts (+)
it('announcement_sent renders sent and failed announcements with kind label and channel name', ...);
```

- [ ] **Step 2: Tests laufen lassen, sie scheitern**
- [ ] **Step 3: Implementieren**
- [ ] **Step 4: Prüfen** (`typecheck`, `lint`, `test`, `test:e2e`)
- [ ] **Step 5: Commit** `feat(web): Chat-Ansagen im Assistenten, in den Einstellungen und im Verlauf`

---

### Task 4: Doku

- [ ] README (Begriffe Ansage, Platzhalter, Katalog; Prozess ingest sendet Ansagen; Route `/api/announcements`; Stand „8d fertig, als Nächstes 9“), CLAUDE.md (Abschnitt Chat-Ansagen, Ereignis v4, `subscribeAll`, Announcer), `npm run lint`, Commit `docs: Chat-Ansagen, Stand Teilprojekt 8d`.

---

## Selbstprüfung gegen die Spec

- 10.3 Katalog je Rahmen und Kern (Task 1), überschreibbar mit deutschen Platzhaltern (Task 1, 3), Links nur per Haken (Task 1), stumm bis auf Gewinneransage (Task 1, 2), jede Ansage ein Ereignis `none` (Task 1, 2).
- 7.2 Schritt 6 Gewinneransage nie stumm (Task 1, 2).
- 4 `display` liefert Ansagen-Defaults (Task 1).
- 3.4 Ingest sendet nur Befehle (`record_announcement`), liest Lesetabellen (Task 2).
- 12.1 Fehler nicht still (Task 2, 3).
- 11.1 Chat-Ansagen in der Streamer-App (Task 3).
