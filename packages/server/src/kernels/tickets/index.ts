// Kern C „Ticketkauf“ (NEW_DESIGN.md 8.3): Zuschauzeit und Chat-Bonus füllen eine Geldbörse je Giveaway mit Coins,
// Teilnehmer kaufen damit Tickets, Topf = alle mit mindestens 1 Ticket, Gewicht = Tickets. Rein, ohne I/O und Uhr.
import {
  FRAMEWORK_EVENTS,
  formatDuration,
  reject,
  type CorrectedPayload,
  type CreditedPayload,
  type Kernel,
  type KernelEvent,
  type NewKernelEvent,
  type Pid,
} from '../../kernel-api/index.js';

export interface TicketsConfig {
  coinBaseSec: number;
  ticketPriceCoins: number;
  /** 0 = ohne Grenze. */
  maxTicketsPerPerson: number;
}

export interface TicketsState {
  /** pid → wirksame Sekunden über alle Kanäle. Kann durch Korrekturen negativ werden, Coins nie. */
  sec: Record<Pid, number>;
  /** pid → für Tickets ausgegebene Coins (gezahlter Preis, nicht der aktuelle). */
  spent: Record<Pid, number>;
  tickets: Record<Pid, number>;
  registered: Pid[]; // sortiert, eindeutig
  /** Offene Käufe in Journal-Reihenfolge. Eine Erstattung mit reversesEventId entfernt ihren Kauf. Der Abbruch erstattet jeden Eintrag. */
  purchases: Purchase[];
}

export interface Purchase extends TicketPayload {
  eventId: string;
}

export interface TicketPayload {
  pid: Pid;
  count: number;
  coins: number;
}

export const TICKETS_EVENTS = { bought: 'tickets_bought', refunded: 'tickets_refunded' } as const;
export const BUY_TICKETS = 'buy_tickets';
export const COUNT_MAX = 10000;

const COIN_BASE_MIN = 60;
const COIN_BASE_MAX = 360_000;
const PAYLOAD_TEXT = 'pid, count und coins müssen gesetzt und gültig sein.';

export function coinsEarned(state: TicketsState, config: TicketsConfig, pid: Pid): number {
  return Math.floor(Math.max(0, state.sec[pid] ?? 0) / config.coinBaseSec);
}

/** Verdient minus ausgegeben. Negativ nach einer Zeit-Korrektur ins Minus, dann geht kein Kauf. */
export function coinsAvailable(state: TicketsState, config: TicketsConfig, pid: Pid): number {
  return coinsEarned(state, config, pid) - (state.spent[pid] ?? 0);
}

export function ticketsOf(state: TicketsState, pid: Pid): number {
  return state.tickets[pid] ?? 0;
}

const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= COUNT_MAX;

function ticketPayloadOf(payload: unknown): TicketPayload | null {
  const p = payload as Partial<TicketPayload> | null;
  if (!p || typeof p.pid !== 'string' || !isCount(p.count) || typeof p.coins !== 'number' || !Number.isInteger(p.coins) || p.coins < 1) return null;
  return { pid: p.pid, count: p.count, coins: p.coins };
}

function pidOf(event: KernelEvent): Pid | null {
  const p = event.payload as { pid?: unknown } | null;
  return p && typeof p.pid === 'string' ? p.pid : null;
}

function entriesOf(payload: unknown): { entries: { pid: Pid; sec: number }[]; factor: number } | null {
  const p = payload as Partial<CreditedPayload & CorrectedPayload> | null;
  if (!p || typeof p.channel !== 'string' || !Array.isArray(p.entries)) return null;
  const factor = typeof p.factor === 'number' ? p.factor : 1;
  const entries = p.entries.filter((e): e is { pid: Pid; sec: number } => typeof e?.pid === 'string' && typeof e?.sec === 'number');
  return { entries, factor };
}

function addSeconds(state: TicketsState, entries: { pid: Pid; sec: number }[], factor: number): TicketsState {
  const sec = { ...state.sec };
  for (const e of entries) sec[e.pid] = (sec[e.pid] ?? 0) + e.sec * factor;
  return { ...state, sec };
}

function book(state: TicketsState, p: TicketPayload, sign: 1 | -1): TicketsState {
  const tickets = Math.max(0, ticketsOf(state, p.pid) + sign * p.count);
  const spent = Math.max(0, (state.spent[p.pid] ?? 0) + sign * p.coins);
  return { ...state, tickets: { ...state.tickets, [p.pid]: tickets }, spent: { ...state.spent, [p.pid]: spent } };
}

const refund = (p: TicketPayload, reversesEventId?: string): NewKernelEvent => ({
  type: TICKETS_EVENTS.refunded,
  payload: { pid: p.pid, count: p.count, coins: p.coins },
  ...(reversesEventId === undefined ? {} : { reversesEventId }),
});

export const ticketsKernel: Kernel<TicketsConfig, TicketsState> = {
  id: 'tickets',
  version: 1,
  label: 'Ticketkauf',
  configSchema: {
    coinBaseSec: {
      kind: 'int',
      label: 'Coin-Basis',
      help: 'So viel Zuschauzeit ergibt einen Coin.',
      default: 7200,
      min: COIN_BASE_MIN,
      max: COIN_BASE_MAX,
      unit: 'sec',
    },
    ticketPriceCoins: {
      kind: 'int',
      label: 'Preis je Ticket',
      help: 'So viele Coins kostet ein Ticket.',
      default: 1,
      min: 1,
      max: 1000,
      unit: 'coins',
    },
    maxTicketsPerPerson: {
      kind: 'int',
      label: 'Höchstzahl je Person',
      help: '0 heißt ohne Grenze.',
      default: 0,
      min: 0,
      max: COUNT_MAX,
    },
  },
  supportedGates: ['follow', 'account_age', 'follow_age', 'presence'],
  usesServices: ['watchtime', 'chatBonus', 'boost', 'registration'],
  drawMode: 'weighted',
  events: [
    {
      type: TICKETS_EVENTS.bought,
      version: 1,
      check: (payload) => (ticketPayloadOf(payload) ? null : PAYLOAD_TEXT),
      reversal: {
        kind: 'compensate',
        inverse(payload, state) {
          const p = ticketPayloadOf(payload);
          if (!p) return reject('invalid_payload', PAYLOAD_TEXT);
          if (ticketsOf(state as TicketsState, p.pid) < p.count) return reject('not_enough_tickets', 'Diese Tickets sind schon erstattet.');
          return refund(p);
        },
      },
    },
    {
      type: TICKETS_EVENTS.refunded,
      version: 1,
      check: (payload) => (ticketPayloadOf(payload) ? null : PAYLOAD_TEXT),
      reversal: { kind: 'none', why: 'Eine Erstattung bleibt. Kaufe die Tickets neu.' },
    },
  ],
  commands: [{ type: BUY_TICKETS, label: 'Tickets kaufen', issuer: 'participant', chat: { word: '!ticket' } }],

  initialState() {
    return { sec: {}, spent: {}, tickets: {}, registered: [], purchases: [] };
  },

  reduce(state, event) {
    switch (event.type) {
      case FRAMEWORK_EVENTS.registered: {
        const pid = pidOf(event);
        if (pid === null || state.registered.includes(pid)) return state;
        return { ...state, registered: [...state.registered, pid].sort() };
      }
      case FRAMEWORK_EVENTS.withdrawn: {
        const pid = pidOf(event);
        if (pid === null || !state.registered.includes(pid)) return state;
        return { ...state, registered: state.registered.filter((p) => p !== pid) };
      }
      case FRAMEWORK_EVENTS.watchCredited:
      case FRAMEWORK_EVENTS.chatCredited: {
        const c = entriesOf(event.payload);
        return c ? addSeconds(state, c.entries, c.factor) : state;
      }
      case FRAMEWORK_EVENTS.watchCorrected: {
        const c = entriesOf(event.payload);
        return c ? addSeconds(state, c.entries, 1) : state;
      }
      case TICKETS_EVENTS.bought: {
        const p = ticketPayloadOf(event.payload);
        if (!p) return state;
        return { ...book(state, p, 1), purchases: [...state.purchases, { ...p, eventId: event.id }] };
      }
      case TICKETS_EVENTS.refunded: {
        const p = ticketPayloadOf(event.payload);
        if (!p) return state;
        const next = book(state, p, -1);
        if (event.reversesEventId === null) return next;
        return { ...next, purchases: state.purchases.filter((x) => x.eventId !== event.reversesEventId) };
      }
      default:
        return state;
    }
  },

  pool(state) {
    return Object.keys(state.tickets)
      .sort()
      .map((pid) => ({ pid, weight: ticketsOf(state, pid) }))
      .filter((e) => e.weight >= 1);
  },

  decide(state, cmd, config) {
    if (cmd.type !== BUY_TICKETS) return reject('unknown_command', 'Diesen Befehl kennt der Ticketkauf nicht.');
    if (typeof cmd.pid !== 'string') return reject('pid_required', 'Der Befehl braucht eine Teilnehmer-ID.');
    const count = cmd.args.count === undefined ? 1 : cmd.args.count;
    if (!isCount(count)) return reject('invalid_count', `Gib eine ganze Zahl von 1 bis ${COUNT_MAX} Tickets an.`);
    if (!state.registered.includes(cmd.pid)) return reject('not_registered', 'Melde dich erst an, dann kaufe Tickets.');
    const have = ticketsOf(state, cmd.pid);
    const max = config.maxTicketsPerPerson;
    if (max > 0 && have + count > max) return reject('ticket_limit', `Höchstens ${max} Tickets je Person. Du hast ${have}.`);
    const coins = count * config.ticketPriceCoins;
    const available = coinsAvailable(state, config, cmd.pid);
    if (available < coins) return reject('not_enough_coins', `Dir fehlen ${coins - available} Coins für ${count} Tickets.`);
    return [{ type: TICKETS_EVENTS.bought, payload: { pid: cmd.pid, count, coins } }];
  },

  onCancel(state) {
    return state.purchases.map((p) => refund(p, p.eventId));
  },

  viewerView(state, pid, config) {
    const tickets = ticketsOf(state, pid);
    return {
      registered: state.registered.includes(pid),
      inPool: tickets >= 1,
      weight: tickets,
      lines: [
        { label: 'Zuschauzeit', value: formatDuration(Math.max(0, state.sec[pid] ?? 0)) },
        { label: 'Coins', value: String(Math.max(0, coinsAvailable(state, config, pid))) },
        { label: 'Tickets', value: String(tickets) },
      ],
    };
  },

  display: {
    icon: '🎟',
    unit: 'Tickets',
    beta: true,
    emptyPool: 'Niemand hat ein Ticket gekauft.',
    columns: [
      { key: 'coins', label: 'Coins' },
      { key: 'tickets', label: 'Tickets' },
    ],
  },
};
