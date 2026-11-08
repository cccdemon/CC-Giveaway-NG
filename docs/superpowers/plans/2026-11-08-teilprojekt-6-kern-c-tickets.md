# Teilprojekt 6: Kern C Ticketkauf – Umsetzungsplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Kern C `tickets`: Zuschauzeit und Chat-Bonus füllen eine Geldbörse je Giveaway mit Coins, Teilnehmer kaufen damit Tickets per Portal-Befehl oder `!ticket <n>` im Chat, ein Rückkauf ist eine Gegenbuchung, ein Abbruch erstattet alle Tickets, der Topf wiegt nach Tickets.

**Architecture:** Kern C ist rein wie Kern A und B. Er bekommt die Dienst-Ereignisse `watch_credited`, `chat_credited`, `watch_corrected` und die Anmeldung per `reduce`, schreibt eigene Ereignisse `tickets_bought` und `tickets_refunded` über `decide`. Der Kern-Vertrag wächst um zwei optionale Teile: ein Befehl kann einen Chat-Auslöser nennen (`chat: { word }`), und ein Kern kann auf den Abbruch reagieren (`onCancel`). Der Rahmen reicht Chat-Befehle in `apply_signals.planSignals` an `kernel.decide` weiter und ruft `onCancel` im Befehl `cancel_giveaway`. Keine neue Tabelle, keine neue Spalte: Kern-Konfiguration liegt in `giveaways.config`, Gewichte in `giveaway_participants.weight`.

**Tech Stack:** TypeScript, Node 24, pg, zod, Vitest, Testcontainers. Keine neuen Abhängigkeiten.

**Spec:** `NEW_DESIGN.md` Abschnitte 2 (Coin, Ticket), 3.4, 4, 5.3, 6.1–6.4, 7.1 (Abbruch erstattet), 7.2, 8.3, 11.3 (nur der Befehl, keine Oberfläche), 12.2, 14 (Punkt 6).

## Global Constraints

- Jede Zustandsänderung läuft durch `CommandBus.execute`. Auch Chat-Befehle der Kerne laufen im Befehl `apply_signals`, kein zweiter Schreibweg.
- `events` ist append-only. Rückkauf und Erstattung sind neue Ereignisse (`tickets_refunded`), nie UPDATE/DELETE.
- Payloads enthalten nur `pid`, nie Twitch-Name oder Twitch-ID (`assertNoTwitchIdentity`). Keine Chat-Texte: aus `!ticket 3` landet nur `count: 3` im Ereignis.
- Ein Kern importiert nur `kernel-api`. `kernel-api` importiert nichts. Kern-Ereignistypen tragen das Präfix `tickets_`, Kern-Befehlstypen keinen Doppelpunkt.
- Kein Kern importiert einen anderen Kern: Kern C bekommt eigene kleine Helfer für Sekunden und Coins, kein Import aus `kernels/watchtime`.
- Formatänderung eines Ereignistyps: `version` erhöhen, Upcaster, Test. Hier keine: alle Typen sind neu, `giveaway_created` v2 bleibt.
- Kern C (Spec 8.3): Dienste Zuschauzeit, Chat-Bonus, Boost, Anmeldung. Coins je Giveaway, kein Guthaben über Giveaways hinweg. Topf = alle mit mindestens 1 Ticket, Gewicht = Tickets, `drawMode: 'weighted'`. Bedingungen: alle vier. Ein Giveaway hat einen Preis.
- Spec 7.1: „Abgebrochen“ erstattet alle Tickets per Gegenbuchung. Tickets kaufen geht nur im Zustand Offen (Kern-Befehle laufen nur Offen).
- `display.beta = true` für den neuen Kern (Spec 4).
- UI- und Fehlertexte deutsch, aktiv, höchstens 20 Wörter, was passiert ist + was zu tun ist. Begriffe aus dem Glossar: Coin, Ticket, Topf, Teilnehmer.
- Tests nur gegen Testcontainers. Kein Netz in Tests.
- Je Task erst den Code fertig schreiben, dann einmal `npm run typecheck`, `npm run lint`, `npm test`.

## Entscheidungen, die die Spec offen lässt (meine Festlegungen)

1. **Geldbörse:** Kern-Zustand `{ sec: Record<pid, number>; spent: Record<pid, number>; tickets: Record<pid, number>; registered: pid[] }`. Verdiente Coins = ⌊max(0, sec) ÷ Coin-Basis⌋ wie Kern A. Verfügbar = verdient − ausgegeben. Eine Zeit-Korrektur ins Minus nach einem Kauf lässt die Tickets stehen, verfügbar wird negativ, bis die Zeit wieder reicht. Kern C braucht keine Sekunden je Kanal, die Anwesenheitsbedingung nutzt `state.seen` des Rahmens.
2. **Konfiguration:** `coinBaseSec` (Default 7200, 60 – 360000, `unit: 'sec'`), `ticketPriceCoins` (Default 1, 1 – 1000, `unit: 'coins'`), `maxTicketsPerPerson` (Default 0 = ohne Grenze, 0 – 10000). Die Spec nennt das Maximum optional, `0` ist die Form dafür. Eine Preisänderung wirkt ab jetzt (Spec 7.1 „Regeln ändern“), darum steht der gezahlte Preis im Ereignis.
3. **Ereignisse:** `tickets_bought { pid, count, coins }` ist `compensate`, das Gegen-Ereignis ist `tickets_refunded { pid, count, coins }` mit denselben Werten (Rückkauf = Gegenbuchung, Spec 8.3). `inverse` lehnt ab, wenn die Person weniger Tickets hat als im Kauf (`not_enough_tickets`). `tickets_refunded` ist `none` („Eine Erstattung bleibt. Kaufe die Tickets neu.“). Die Umkehrung läuft über den vorhandenen `revert`-Handler, der Grund kommt aus dem Befehl.
4. **Befehl `buy_tickets`:** `issuer: 'participant'`, `args: { count }` (fehlt → 1, ganze Zahl 1 – 10000). Reihenfolge der Prüfungen: Zahl gültig, angemeldet (`not_registered`), Höchstzahl (`ticket_limit`), Coins (`not_enough_coins`). Nur Teilnehmer kaufen: Ein Unangemeldeter kann nicht gewinnen (Glossar), ein Kauf ohne Anmeldung wäre verlorenes Geld. Einen eigenen Rückkauf-Befehl des Teilnehmers gibt es nicht. Rückkauf ist Rückgängig im Verlauf durch den Streamer oder der Abbruch.
5. **Chat-Auslöser im Vertrag:** `KernelCommandSpec.chat?: { word: string }`, nur für `issuer: 'participant'`. Die Registry prüft: `word` passt auf `/^\S{2,32}$/`, kein Wort doppelt je Kern, kein `chat` an einem Befehl mit anderem `issuer`. `planSignals` prüft je Chatnachricht in Zeitfolge: erstes Wort gleich Keyword → Anmeldung (wie bisher), sonst erstes Wort gleich `chat.word` (Groß-/Kleinschreibung egal) → `kernel.decide(zustand, { type, pid, args: { count } }, config, m.at)`. Zweites Wort ist `count`, wenn es `/^\d{1,5}$/` erfüllt und ≥ 1 ist, fehlt es, gilt 1, sonst ist die Nachricht kein Befehl. Eine Ablehnung des Kerns verwirft die Nachricht still, Chat-Antworten kommen mit den Ansagen (Teilprojekt 8). Der Kern-Zustand wird innerhalb des Bündels mit jedem geplanten Ereignis fortgeschrieben, damit eine zweite Nachricht die erste sieht. Coins der laufenden Minute zählen erst ab der nächsten Minute, weil `watch_credited` nach den Chatnachrichten entsteht.
6. **Keyword gegen Chat-Wort:** `checkSettings` lehnt ein Keyword ab, das einem `chat.word` des Kerns gleicht (`keyword_reserved`). Sonst hieße `!ticket` zugleich Anmeldung und Kauf.
7. **Abbruch:** `Kernel.onCancel?(state, config): NewKernelEvent[]`. `cancel_giveaway` schreibt `giveaway_status_changed` und danach die Ereignisse aus `onCancel`. Kern C liefert je `pid` mit Tickets ein `tickets_refunded { pid, count: tickets, coins: spent }`, sortiert nach `pid`. Ohne Tickets kein Ereignis. Ein Rückgängig des Abbruchs stellt den Zustand wieder her, die Erstattungen bleiben (sie sind `none`). Die Teilnehmer kaufen dann neu. Das steht so im Verlauf.
8. **Kern-Ereignisse nach der Ziehung:** Der `revert`-Handler des Giveaways lehnt die Umkehrung eines Kern-Ereignisses ab, wenn der Zustand nicht in `draft`, `open`, `paused`, `closed` liegt (`kernel_locked`, „Nach der Ziehung änderst du keine Kern-Einträge mehr.“). Sonst veränderte eine Erstattung den Topf einer Ersatzziehung. Das gilt für alle Kerne, Kern B verliert nichts (sein Fenster ist nach der Ziehung ohnehin zu).
9. **Ereignisse aus dem Kern in Rahmen-Ereignisse:** die Prüfung „Präfix des Kerns“ aus `kernelCommandHandler` zieht als `fromKernelEvents(kernel, out)` nach `state.ts` neben `toKernelEvent`. `kernel_command`, `cancel_giveaway` und `planSignals` nutzen sie.
10. **Keine Migration, keine Versionserhöhung:** `GiveawayState` ändert sich nicht (`FRAMEWORK_REDUCER_VERSION` bleibt 5). Der neue Kern ändert `versionStamp` von selbst. Die Lesetabellen brauchen keine Spalte: Coins und Tickets stehen in `viewerView` und `display.columns`, `weight` = Tickets.
11. **Offen für andere Teilprojekte:** Portal-Knopf „Tickets kaufen“ und Kaufbestätigung im Chat → Teilprojekt 8. `legacy_imported` gibt es nur für Kern A → Teilprojekt 9.

## Review Focus

1. Zwei `!ticket`-Nachrichten derselben Person in einer Minute: die zweite rechnet mit Coins und Tickets nach der ersten, nie doppelt. Test in Task 4.
2. Preis steigt zwischen Kauf und Rückgängig: die Erstattung gibt den gezahlten Betrag zurück, nicht den neuen Preis. Test in Task 3.
3. Zeit-Korrektur ins Minus nach einem Kauf: Tickets bleiben im Topf, ein weiterer Kauf wird mit `not_enough_coins` abgelehnt, nichts wirft. Test in Task 2.
4. Rückgängig eines älteren Kaufs, nachdem ein zweiter Kauf lief: geht, solange die Person genug Tickets hat. Nach einer Erstattung aller Tickets lehnt `inverse` ab. Test in Task 3.
5. Abbruch eines Ticket-Giveaways ohne Käufe und Abbruch eines `instant`-Giveaways: nur `giveaway_status_changed`, kein leeres Erstattungsereignis. Test in Task 3.

---

## Dateistruktur

```
packages/server/src/kernel-api/index.ts                     + KernelCommandSpec.chat, Kernel.onCancel
packages/server/src/kernels/tickets/index.ts                Kern C
packages/server/src/framework/kernel-registry.ts            + ticketsKernel, Prüfung chat.word
packages/server/src/framework/giveaway/state.ts             + fromKernelEvents
packages/server/src/framework/giveaway/kernel-command.ts    nutzt fromKernelEvents
packages/server/src/framework/giveaway/lifecycle.ts         cancel ruft onCancel, keyword_reserved, kernel_locked im revert
packages/server/src/framework/giveaway/signals.ts           planSignals: Chat-Befehle, chatCommandOf
packages/server/test/tickets-kernel.test.ts                 reine Tests Kern C
packages/server/test/tickets-command.test.ts                Kauf, Rückgängig, Abbruch über den Bus
packages/server/test/kernel-registry.test.ts, kernel-api.test.ts, lifecycle.test.ts, apply-signals.test.ts   Ergänzungen
README.md, CLAUDE.md                                        Stand Teilprojekt 6
```

---

### Task 1: Kern-Vertrag erweitern

**Files:**
- Modify: `src/kernel-api/index.ts`, `src/framework/kernel-registry.ts`
- Test: `test/kernel-api.test.ts`, `test/kernel-registry.test.ts`

**Interfaces:**
- Produces (`kernel-api`):
  - `KernelCommandSpec.chat?: { word: string }` – Kommentar: „Auslöser im Chat: erstes Wort der Nachricht, Groß-/Kleinschreibung egal. Nur für issuer 'participant'. Das zweite Wort wird als args.count übergeben (ganze Zahl ≥ 1), fehlt es, gilt 1.“
  - `Kernel.onCancel?(state: State, config: Config): NewKernelEvent[]` – Kommentar: „Ereignisse, die der Rahmen beim Abbruch nach giveaway_status_changed schreibt (Spec 7.1: Kern C erstattet Tickets).“
- Produces (`kernel-registry`): `CHAT_WORD_RE = /^\S{2,32}$/`. `register` wirft bei `chat` an einem Befehl mit `issuer !== 'participant'` („Der Chat-Befehl ${type} braucht issuer 'participant'.“), bei `chat.word` außerhalb `CHAT_WORD_RE` („Das Chat-Wort ${word} ist ein Wort mit 2 bis 32 Zeichen ohne Leerzeichen.“) und bei doppeltem Chat-Wort im Kern („Das Chat-Wort ${word} steht im Kern ${id} doppelt.“).

- [ ] **Step 1: Tests schreiben**

```ts
// kernel-api.test.ts: im Test 'Kernel-Literal ist typisiert' ein Literal mit commands: [{ type: 'buy', label: 'Kaufen', issuer: 'participant', chat: { word: '!buy' } }] und onCancel: () => [] ergänzen, Typprüfung reicht.
// kernel-registry.test.ts: fake() um einen Parameter `commandSpecs?: KernelCommandSpec[]` erweitern
it('refuses a chat word on a streamer command, an invalid chat word and a duplicate chat word', () => {
  // issuer 'streamer' + chat → /issuer 'participant'/
  // word 'x' → /2 bis 32 Zeichen/ ; word 'a b' → /2 bis 32 Zeichen/
  // zwei Befehle mit word '!buy' → /doppelt/
  // ein gültiger Befehl mit chat: { word: '!buy' } → not.toThrow()
});
```

- [ ] **Step 2: Tests laufen lassen, sie scheitern** (`npx vitest run test/kernel-registry.test.ts test/kernel-api.test.ts`)
- [ ] **Step 3: Implementieren** (Typen in `kernel-api`, Prüfungen in `KernelRegistry.register` neben der Doppelpunkt-Prüfung)
- [ ] **Step 4: Prüfen** (`npm run typecheck`, `npm run lint`, `npm test`)
- [ ] **Step 5: Commit** `feat(kernel): Chat-Auslöser und onCancel im Kern-Vertrag`

---

### Task 2: Kern C `tickets`

**Files:**
- Create: `src/kernels/tickets/index.ts`
- Modify: `src/framework/kernel-registry.ts` (`defaultKernels` registriert `ticketsKernel` nach `watchtimeKernel`)
- Test: `test/tickets-kernel.test.ts`, `test/kernel-registry.test.ts`

**Interfaces:**
- Consumes (`kernel-api`): `Kernel`, `KernelEvent`, `NewKernelEvent`, `FRAMEWORK_EVENTS`, `CreditedPayload`, `CorrectedPayload`, `formatDuration`, `reject`.
- Produces (`kernels/tickets`):
  - `interface TicketsConfig { coinBaseSec: number; ticketPriceCoins: number; maxTicketsPerPerson: number }`
  - `interface TicketsState { sec: Record<Pid, number>; spent: Record<Pid, number>; tickets: Record<Pid, number>; registered: Pid[] }`
  - `TICKETS_EVENTS = { bought: 'tickets_bought', refunded: 'tickets_refunded' } as const`, `BUY_TICKETS = 'buy_tickets'`, `COUNT_MAX = 10000`
  - `interface TicketPayload { pid: Pid; count: number; coins: number }`
  - `coinsEarned(state, config, pid): number` = `Math.floor(Math.max(0, state.sec[pid] ?? 0) / config.coinBaseSec)`
  - `coinsAvailable(state, config, pid): number` = `coinsEarned − (state.spent[pid] ?? 0)` (kann negativ sein)
  - `ticketsOf(state, pid): number`
  - `ticketsKernel: Kernel<TicketsConfig, TicketsState>` mit `id: 'tickets'`, `version: 1`, `label: 'Ticketkauf'`, `supportedGates: ['follow', 'account_age', 'follow_age', 'presence']`, `usesServices: ['watchtime', 'chatBonus', 'boost', 'registration']`, `drawMode: 'weighted'`.
  - `configSchema`: `coinBaseSec { kind: 'int', label: 'Coin-Basis', help: 'So viel Zuschauzeit ergibt einen Coin.', default: 7200, min: 60, max: 360000, unit: 'sec' }`, `ticketPriceCoins { kind: 'int', label: 'Preis je Ticket', help: 'So viele Coins kostet ein Ticket.', default: 1, min: 1, max: 1000, unit: 'coins' }`, `maxTicketsPerPerson { kind: 'int', label: 'Höchstzahl je Person', help: '0 heißt ohne Grenze.', default: 0, min: 0, max: 10000 }`.
  - `events`: `tickets_bought` v1, `check`: `pid` string, `count` ganze Zahl 1 – `COUNT_MAX`, `coins` ganze Zahl ≥ 1, sonst Text „pid, count und coins müssen gesetzt und gültig sein.“; `reversal: compensate`, `inverse(payload, state)`: `ticketsOf(state, pid) < count` → `reject('not_enough_tickets', 'Diese Tickets sind schon erstattet.')`, sonst `{ type: 'tickets_refunded', payload: { pid, count, coins } }`. `tickets_refunded` v1, gleiche `check`, `reversal: { kind: 'none', why: 'Eine Erstattung bleibt. Kaufe die Tickets neu.' }`.
  - `commands: [{ type: 'buy_tickets', label: 'Tickets kaufen', issuer: 'participant', chat: { word: '!ticket' } }]`
  - `initialState()` → `{ sec: {}, spent: {}, tickets: {}, registered: [] }`
  - `reduce`: Anmeldung wie Kern A; `watch_credited`/`chat_credited`: `sec[pid] += e.sec · factor` je Eintrag; `watch_corrected`: `sec[pid] += e.sec`; `tickets_bought`: `tickets[pid] += count`, `spent[pid] += coins`; `tickets_refunded`: `tickets[pid] = max(0, tickets − count)`, `spent[pid] = max(0, spent − coins)`; fremde oder kaputte Payloads lassen den Zustand unverändert (dasselbe Objekt).
  - `pool`: `Object.keys(tickets).sort()` mit `weight = tickets`, nur `weight ≥ 1`.
  - `decide(state, cmd, config, now)`: Typ ungleich `buy_tickets` → `reject('unknown_command', 'Diesen Befehl kennt der Ticketkauf nicht.')`; `cmd.pid` kein String → `reject('pid_required', 'Der Befehl braucht eine Teilnehmer-ID.')`; `count = cmd.args.count ?? 1`, keine ganze Zahl 1 – 10000 → `reject('invalid_count', 'Gib eine ganze Zahl von 1 bis 10000 Tickets an.')`; nicht in `registered` → `reject('not_registered', 'Melde dich erst an, dann kaufe Tickets.')`; `max > 0 && tickets + count > max` → `reject('ticket_limit', \`Höchstens ${max} Tickets je Person. Du hast ${tickets}.\`)`; `coins = count · ticketPriceCoins`, `available < coins` → `reject('not_enough_coins', \`Dir fehlen ${coins − available} Coins für ${count} Tickets.\`)`; sonst `[{ type: 'tickets_bought', payload: { pid, count, coins } }]`.
  - `onCancel(state)`: je `pid` in `Object.keys(tickets).sort()` mit `tickets > 0` ein `tickets_refunded { pid, count: tickets[pid], coins: spent[pid] ?? 0 }`.
  - `viewerView(state, pid, config)`: `registered`, `inPool: tickets ≥ 1`, `weight: tickets`, `lines`: `Zuschauzeit` (formatDuration von max(0, sec)), `Coins` (max(0, available) als Text), `Tickets` (Zahl als Text).
  - `display: { icon: '🎟', unit: 'Tickets', beta: true, emptyPool: 'Niemand hat ein Ticket gekauft.', columns: [{ key: 'coins', label: 'Coins' }, { key: 'tickets', label: 'Tickets' }] }`
- Produces (`kernel-registry`): `defaultKernels().list()` → `['instant', 'watchtime', 'tickets']`.

- [ ] **Step 1: Tests schreiben** (Muster: `test/watchtime-kernel.test.ts`, `config = { ...defaultConfig(schema), coinBaseSec: 60 }` für kurze Zahlen)

```ts
// tickets-kernel.test.ts
it('initialState is empty, defaults are 7200 / 1 / 0', ...);
it('credits fill the wallet: coinsEarned floors, chat_credited and factor count, watch_corrected subtracts', ...);
it('buy_tickets writes tickets_bought with coins = count × price, reduce moves coins to spent and tickets', ...);
it('buy_tickets: count default 1, rejects invalid_count (0, 1.5, 10001, "x"), unknown_command, pid_required', ...);
it('buy_tickets rejects not_registered before coins are checked', ...);
it('buy_tickets rejects ticket_limit with exact text and allows up to the limit; 0 means no limit', ...);
it('buy_tickets rejects not_enough_coins with missing coins in the text', ...);
it('negative correction after a purchase keeps tickets, coinsAvailable < 0, next buy rejected, viewerView shows Coins 0', ...);   // Review Focus 3
it('price change: later purchase pays the new price, spent keeps what was paid', ...);
it('inverse of tickets_bought yields tickets_refunded with the same values, rejects not_enough_tickets after a full refund', ...);
it('tickets_refunded reduce clamps at 0 and is declared none', ...);
it('onCancel refunds every holder sorted by pid with count = tickets and coins = spent, empty without tickets', ...);
it('pool lists holders with weight = tickets sorted by pid; viewerView lines Zuschauzeit, Coins, Tickets', ...);
it('unknown events and malformed payloads leave the state object unchanged', ...);
it('property: weights are positive integers, pool is deterministic, spent never exceeds coins earned at purchase time', ...);   // mulberry32 wie Kern A, zufällige Folgen aus credit, correct, register, buy (über decide, Ablehnungen überspringen), refund (über inverse)
it('declares the fixed contract fields', ...);   // id, version, label, drawMode, gates, services, configSchema, commands inkl. chat, display
// kernel-registry.test.ts: 'defaultKernels has instant and watchtime' → plus tickets, list() = ['instant', 'watchtime', 'tickets']; 'defaultKernels versionStamp' → drei Kerne
```

- [ ] **Step 2: Tests laufen lassen, sie scheitern**
- [ ] **Step 3: Implementieren**
- [ ] **Step 4: Prüfen** (`npm run typecheck`, `npm run lint`, `npm test`; `test/architecture.test.ts` und ESLint bestätigen, dass der Kern nur `kernel-api` importiert)
- [ ] **Step 5: Commit** `feat(kernel): Kern C Ticketkauf mit Geldbörse je Giveaway`

---

### Task 3: Rahmen: Kauf über den Bus, Rückgängig, Abbruch erstattet

**Files:**
- Modify: `src/framework/giveaway/state.ts`, `src/framework/giveaway/kernel-command.ts`, `src/framework/giveaway/lifecycle.ts`
- Test: `test/tickets-command.test.ts` (neu), `test/lifecycle.test.ts`

**Interfaces:**
- Consumes: `ticketsKernel`, `TICKETS_EVENTS`, `TicketsState` (Task 2); `rt.handlers.kernelCommand`, `rt.handlers.correctWatch` (`CorrectWatchCmd { giveawayId, channel, pid, sec, reason }`, Sekunden 1 – 360000 je Befehl), `rt.handlers.revert`, `rt.handlers.cancel`, `rt.handlers.close`, `rt.handlers.draw`.
- Produces (`state.ts`): `fromKernelEvents(kernel: AnyKernel, out: NewKernelEvent[]): NewEvent[]` – wirft `Error(\`Der Kern ${kernel.id} hat ein fremdes Ereignis erzeugt: ${type}\`)` ohne Präfix `${kernel.id}_`. `kernelCommandHandler.decide` nutzt sie statt der eigenen Schleife.
- Produces (`lifecycle.ts`):
  - `transitionHandler` für `cancel_giveaway`: `[statusChanged, ...fromKernelEvents(kernel, kernel.onCancel?.(state.kernelState, state.settings.config) ?? [])]`. Andere Übergänge unverändert.
  - `checkSettings`: `keyword` gleich einem `chat.word` des Kerns (Vergleich in Kleinbuchstaben) → `reject('keyword_reserved', 'Dieses Wort ist ein Chat-Befehl des Kerns. Wähle ein anderes Keyword.')`.
  - `giveawayRevertHandler`: ist `prepared.target.type` ein Ereignistyp des Kerns (`kernel.events.some(d => d.type === type)`) und `state.status` nicht in `['draft', 'open', 'paused', 'closed']` → `reject('kernel_locked', 'Nach der Ziehung änderst du keine Kern-Einträge mehr.')`. Prüfung vor `base.decide`-Ergebnisauswertung wie die bestehenden `REVERT_GATES`.

- [ ] **Step 1: Tests schreiben** (`setupGiveaway()`, `createOpen(rt, { kernelId: 'tickets', settings: { prize: 'Key', channels: [P1], config: { coinBaseSec: 60 } } })`, Anmeldung über `rt.handlers.register` mit `actor: userOf(P2)`, Coins über `rt.handlers.correctWatch` mit `{ giveawayId: GID, channel: P1, pid: P2, sec: 300, reason: 'Test' }` = 5 Coins)

```ts
// tickets-command.test.ts
const buy = (pid: string, count?: number) => ({ giveawayId: GID, command: { type: 'buy_tickets', pid, args: count === undefined ? {} : { count } } });
it('buy_tickets via kernel_command writes tickets_bought, pool weight and giveaway_participants.weight = tickets, giveaways.pool_weight = sum', ...);
it('a participant buys only for themself (not_you), unknown participant command stays unknown_command on instant', ...);
it('rejections reach the caller with exact code and message: not_registered, invalid_count, ticket_limit, not_enough_coins', ...);
it('revert of tickets_bought writes tickets_refunded with reversesEventId and reason, kernel state back; refunded coins equal the paid price after a price change', ...);   // Review Focus 2
it('revert of an older purchase after a second purchase works; after a refund of everything inverse rejects not_enough_tickets; revert of tickets_refunded is not_reversible', ...);   // Review Focus 4
it('cancel writes giveaway_status_changed then one tickets_refunded per holder sorted by pid; kernel state has no tickets; participants rows weight 0', ...);
it('cancel without purchases and cancel of an instant giveaway write only giveaway_status_changed', ...);   // Review Focus 5
it('after close + draw, revert of tickets_bought is kernel_locked; before the draw in closed it works', ...);
it('kernel_command on a kernel that produces a foreign event type throws', ...);   // plainKernel-Variante mit decide → [{ type: 'other_x', payload: {} }], erwartet rejects.toThrow(/fremdes Ereignis/)
// lifecycle.test.ts: ergänzen
it('create and change_settings reject a keyword equal to a chat command word of the kernel (keyword_reserved), case-insensitive', ...);
```

- [ ] **Step 2: Tests laufen lassen, sie scheitern**
- [ ] **Step 3: Implementieren**
- [ ] **Step 4: Prüfen** (`npm run typecheck`, `npm run lint`, `npm test`)
- [ ] **Step 5: Commit** `feat(giveaway): Ticketkauf über Kern-Befehl, Rückgängig als Erstattung, Abbruch erstattet`

---

### Task 4: `!ticket <n>` im Chat

**Files:**
- Modify: `src/framework/giveaway/signals.ts`
- Test: `test/apply-signals.test.ts`

**Interfaces:**
- Consumes: `KernelCommandSpec.chat` (Task 1), `fromKernelEvents` (Task 3), `ticketsKernel` (Task 2), Stub `stubResolver()` und `signals()` aus dem bestehenden Test.
- Produces (`signals.ts`):
  - `chatCommandOf(text: string, specs: readonly KernelCommandSpec[]): { type: string; count: number } | null` – erstes Wort in Kleinbuchstaben gleich `spec.chat.word.toLowerCase()`; zweites Wort fehlt → `count: 1`; zweites Wort passt auf `/^\d{1,5}$/` und ist ≥ 1 → `count`; sonst `null`. Exportiert für den Test.
  - `planSignals`: Schritt 1 wird eine Schleife über die zeitlich sortierten Nachrichten: passt das Keyword → Anmeldung wie bisher; sonst liefert `chatCommandOf` einen Befehl und `kernel.decide` existiert → `out = kernel.decide(kernelState, { type, pid: m.pid, args: { count } }, s.config, m.at)`; Ablehnung → weiter; sonst `fromKernelEvents` anhängen. Ein lokaler Kern-Zustand startet mit `state.kernelState` und wird je angehängtem Ereignis (auch `participant_registered`) über `kernel.reduce(ks, { id: '', type, payload, at: m.at, reversesEventId: null }, s.config)` fortgeschrieben. Nur Befehle mit `issuer: 'participant'` und `chat`.
  - Zuschauzeit und Chat-Bonus (Schritte 2, 3) bleiben unverändert und laufen nach der Schleife.

- [ ] **Step 1: Tests schreiben** (`setup({ config: { coinBaseSec: 60 } }, …)` mit `kernelId: 'tickets'` über eine zweite Setup-Variante `setupTickets(settings)`; Coins entstehen über eine Anwesenheits-Minute `MINUTE`, der Kauf läuft in `MINUTE2`)

```ts
it('chatCommandOf parses word and count: "!ticket" → 1, "!TICKET 3" → 3, "!ticket 0" / "!ticket x" / "ticket 2" → null', ...);
it('!ticket buys with coins from an earlier minute: ALICE registered, 1 presence minute, then chat "!ticket 1" in MINUTE2 → tickets_bought { pid: P2, count: 1, coins: 1 }', ...);
it('two !ticket messages in one minute: second sees the first (1 coin: first buys, second is dropped; 2 coins: both buy)', ...);   // Review Focus 1
it('unregistered or unknown writer: no event, no identity created, no exception', ...);
it('keyword then !ticket in the same minute (first_seen, GHOST had one presence minute): participant_registered then tickets_bought in that order', ...);
it('watch_credited of the same minute is still written after the purchase and does not fund it', ...);
it('a kernel without chat commands (watchtime) ignores "!ticket 1"', ...);
```

- [ ] **Step 2: Tests laufen lassen, sie scheitern**
- [ ] **Step 3: Implementieren**
- [ ] **Step 4: Prüfen** (`npm run typecheck`, `npm run lint`, `npm test`)
- [ ] **Step 5: Commit** `feat(giveaway): Ticketkauf per Chat-Befehl in apply_signals`

---

### Task 5: Doku und Gesamtprüfung

**Files:**
- Modify: `README.md`, `CLAUDE.md`

**Interfaces:**
- README „Begriffe“: Zeilen `Ticket` (ein mit Coins gekauftes Los, Kern C, Gewicht = Tickets), `Geldbörse` (Coins je Giveaway und Person, verdient − ausgegeben, kein Guthaben über Giveaways hinweg), `Chat-Befehl` (Wort eines Kern-Befehls im Chat, z. B. `!ticket 3`, läuft im Befehl `apply_signals`, nur für Teilnehmer, Ablehnung ohne Antwort bis Teilprojekt 8). Zeile `Teilprojekt`: 1 bis 6 fertig. README „Prozesse“ → ingest: `apply_signals` schreibt zusätzlich Kern-Ereignisse aus Chat-Befehlen.
- CLAUDE.md: Pflichtlektüre: Teilprojekte 1–6 fertig, als Nächstes 7 (Teams). Kern-Vertrag: `KernelCommandSpec.chat`, `Kernel.onCancel`, `fromKernelEvents` in `state.ts`, Kerne `instant` (B), `watchtime` (A), `tickets` (C, Coins → Tickets, `buy_tickets`, `!ticket <n>`). Rahmen-Dienste: `planSignals` reicht Chat-Befehle an `kernel.decide`, Keyword darf keinem Chat-Wort gleichen. Umkehrung: Kern-Ereignisse nur bis Geschlossen (`kernel_locked`). Lebenszyklus: `cancel_giveaway` schreibt `onCancel`-Ereignisse.

- [ ] **Step 1: Doku schreiben**
- [ ] **Step 2: Alles prüfen** (`npm run typecheck`, `npm run lint`, `npm test`, `npm run build`; dann gegen den Dev-Stack mit `INGEST_ADAPTER=simulator` App und Ingest kurz starten, ein `tickets`-Giveaway mit `coinBaseSec: 60` über die Runtime anlegen, öffnen, einen simulierten Zuschauer anmelden, nach zwei Minuten `buy_tickets` über `rt.handlers.kernelCommand` ausführen und `tickets_bought` sowie `giveaway_participants.weight = 1` in der Datenbank sehen)
- [ ] **Step 3: Commit** `docs: Kern C, Chat-Befehle, Stand Teilprojekt 6`

---

## Selbstprüfung gegen die Spec

- 2 Glossar Coin, Ticket → Task 2, README in Task 5.
- 3.4 Modulgrenzen: Kern C importiert nur `kernel-api`, Lint und `architecture.test.ts` prüfen → Task 2.
- 4 Kern-Vertrag: `decide` rein, `commands`, `display.beta = true`, neuer Kern = Verzeichnis + Registry-Eintrag → Task 1, 2. Zeit kommt als `now` herein, Kern C nutzt sie nicht.
- 5.3 Umkehrbarkeit: Ticket-Kauf ↔ Erstattung `compensate`, Erstattung `none` mit Grund → Task 2, 3.
- 6.1–6.3 Dienste: Kern C nennt `watchtime`, `chatBonus`, `boost`, `registration` → Task 2. Boost-Faktor steckt in den Gutschriften, der Kern multipliziert → Task 2.
- 6.4 Anmeldung per Keyword bleibt, Keyword und Chat-Wort getrennt → Task 3, 4.
- 6.5 Bedingungen: alle vier in `supportedGates` → Task 2. Prüfung bei der Ziehung ist Rahmen-Sache (Teilprojekt 5).
- 7.1 Abbruch erstattet alle Tickets per Gegenbuchung → Task 3. Tickets kaufen nur Offen → `kernel_command` und `apply_signals` laufen nur Offen (bestehend).
- 7.2 Ziehung gewichtet nach Tickets → Task 2 (`drawMode`), Topf nach der Ziehung unveränderlich → Task 3 (`kernel_locked`).
- 8.3 Kern C: Dienste, Geldbörse je Giveaway, `!ticket <n>` im Chat, Befehl über `decide`, Preis je Ticket, optionales Maximum, Rückkauf als Gegenbuchung, Topf und Gewicht, ein Preis je Giveaway → Task 2, 3, 4.
- 11.3 „Tickets kaufen“ im Portal: der Befehl steht bereit (`kernel_command`, `issuer: 'participant'`), die Oberfläche kommt mit Teilprojekt 8.
- 12.2 Tests: Tabellen- und Property-Tests für den Kern → Task 2, Bus-Tests → Task 3, Ingest-Pfad über Bündel → Task 4.
- Offen für Teilprojekt 8: Portal-Knopf, Kaufbestätigung und Ablehnungsgrund im Chat. Offen für Teilprojekt 9: nur Kern A wird übernommen.
