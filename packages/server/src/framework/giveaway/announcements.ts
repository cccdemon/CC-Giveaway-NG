// Chat-Ansagen (NEW_DESIGN.md 10.3, 7.2 Schritt 6): Katalog mit Default-Texten, Platzhalter, Prüfung der Vorlagen, Planung aus
// Ereignissen. Rein, ohne I/O. Der Versand liegt im Ingest (announcer.ts), der Nachweis in announce-record.ts.
import { formatDuration, type AnyKernel } from '../../kernel-api/index.js';
import { reject, type Rejection } from '../../shared/rejection.js';

export const ANNOUNCEMENT_SENT = 'announcement_sent';
export const ANNOUNCEMENT_SENT_WHY = 'Eine gesendete Chatnachricht bleibt gesendet.';

export type FrameworkKind = 'opened' | 'paused' | 'resumed' | 'closed' | 'winner' | 'boost_started' | 'boost_ended';

export const FRAMEWORK_KINDS: readonly FrameworkKind[] = ['opened', 'paused', 'resumed', 'closed', 'winner', 'boost_started', 'boost_ended'];

const P = { preis: '{preis}', keyword: '{keyword}', gewinner: '{gewinner}', frist: '{frist}', faktor: '{faktor}', dauer: '{dauer}', bis: '{bis}' } as const;

/** Erlaubte Platzhalter je Art (Festlegung 2). Kern-Arten: {preis}, {keyword}, {bis}. */
export const PLACEHOLDERS: Record<FrameworkKind, readonly string[]> = {
  opened: [P.preis, P.keyword],
  paused: [P.preis, P.keyword],
  resumed: [P.preis, P.keyword],
  closed: [P.preis, P.keyword],
  winner: [P.preis, P.gewinner, P.frist],
  boost_started: [P.preis, P.faktor, P.dauer],
  boost_ended: [P.preis],
};
export const KERNEL_PLACEHOLDERS: readonly string[] = [P.preis, P.keyword, P.bis];

/** Default-Texte des Rahmens. withoutKeyword gilt, wenn das Giveaway kein Keyword hat. */
export const DEFAULTS: Record<FrameworkKind, { text: string; withoutKeyword?: string }> = {
  opened: { text: 'Giveaway „{preis}“ ist offen! Schreib {keyword} in den Chat und mach mit.', withoutKeyword: 'Giveaway „{preis}“ ist offen! Mach im Portal mit.' },
  paused: { text: 'Giveaway „{preis}“ pausiert. Gerade zählt nichts.' },
  resumed: { text: 'Giveaway „{preis}“ läuft weiter! Schreib {keyword}, wenn du noch nicht dabei bist.', withoutKeyword: 'Giveaway „{preis}“ läuft weiter!' },
  closed: { text: 'Giveaway „{preis}“ ist geschlossen. Die Ziehung kommt gleich.' },
  winner: { text: 'Gewinner von „{preis}“: {gewinner}! Herzlichen Glückwunsch. Melde dich innerhalb von {frist} Tagen.' },
  boost_started: { text: 'Boost ×{faktor} für {dauer} bei „{preis}“! Jetzt zählt jede Minute mehr.' },
  boost_ended: { text: 'Der Boost bei „{preis}“ ist vorbei.' },
};

export interface AnnouncementSettings {
  /** Alle Ansagen stumm, außer der Gewinneransage (7.2 Schritt 6). */
  muted: boolean;
  /** Link zur öffentlichen Giveaway-Seite anhängen. Links stehen nie im Text (10.3). */
  links: boolean;
  /** Eigene Vorlagen je Art, sonst der Default. */
  texts: Record<string, string>;
}

export const ANNOUNCEMENT_DEFAULTS: AnnouncementSettings = { muted: false, links: true, texts: {} };
export const TEMPLATE_MAX = 400;
export const MESSAGE_MAX = 500;
export const NO_KEYWORD_FILL = 'im Portal';
export const UNKNOWN_WINNER_FILL = 'Teilnehmer';

const LINK_RE = /https?:\/\//i;
const PLACEHOLDER_RE = /\{[^{}]*\}/g;
const INVALID = (message: string): Rejection => reject('invalid_announcement', message);

export interface AnnouncementKind {
  kind: string;
  default: string;
  placeholders: readonly string[];
  /** Kern-ID, null für Arten des Rahmens. */
  kernel: string | null;
}

/** Katalog für ein Giveaway: Arten des Rahmens plus die Arten des Kerns aus display.announcements. */
export function kindsFor(kernel: AnyKernel): AnnouncementKind[] {
  const framework = FRAMEWORK_KINDS.map((kind) => ({ kind, default: DEFAULTS[kind].text, placeholders: PLACEHOLDERS[kind], kernel: null }));
  const own = Object.entries(kernel.display.announcements ?? {}).map(([kind, text]) => ({ kind, default: text, placeholders: KERNEL_PLACEHOLDERS, kernel: kernel.id }));
  return [...framework, ...own];
}

function placeholdersOf(kind: string, kernel: AnyKernel): readonly string[] | null {
  if ((FRAMEWORK_KINDS as readonly string[]).includes(kind)) return PLACEHOLDERS[kind as FrameworkKind];
  if (kernel.display.announcements && kind in kernel.display.announcements) return KERNEL_PLACEHOLDERS;
  return null;
}

/** Prüft die Ansage-Einstellungen eines Giveaways. undefined → Defaults. */
export function validateAnnouncements(a: unknown, kernel: AnyKernel): AnnouncementSettings | Rejection {
  if (a === undefined || a === null) return ANNOUNCEMENT_DEFAULTS;
  if (typeof a !== 'object' || Array.isArray(a)) return INVALID('Die Ansagen sind ungültig.');
  const o = a as Record<string, unknown>;
  if (typeof o.muted !== 'boolean' || typeof o.links !== 'boolean') return INVALID('Stummschalten und Link sind an oder aus.');
  const texts = o.texts ?? {};
  if (typeof texts !== 'object' || texts === null || Array.isArray(texts)) return INVALID('Die Vorlagen sind ungültig.');
  const out: Record<string, string> = {};
  for (const [kind, raw] of Object.entries(texts as Record<string, unknown>)) {
    const allowed = placeholdersOf(kind, kernel);
    if (allowed === null) return INVALID(`Die Ansage ${kind} gibt es für diesen Kern nicht.`);
    if (typeof raw !== 'string') return INVALID(`Die Vorlage ${kind} braucht einen Text.`);
    const text = raw.trim();
    if (text === '') {
      if (kind === 'winner') return INVALID('Die Gewinneransage braucht einen Text. Sie bleibt immer an.');
      continue;
    }
    if (text.length > TEMPLATE_MAX) return INVALID(`Die Vorlage ${kind} darf höchstens ${TEMPLATE_MAX} Zeichen haben.`);
    if (LINK_RE.test(text)) return INVALID('Links stehen nicht im Text. Hänge den Link per Haken an.');
    for (const ph of text.match(PLACEHOLDER_RE) ?? []) {
      if (!allowed.includes(ph)) return INVALID(`Der Platzhalter ${ph} passt nicht zur Ansage ${kind}. Erlaubt: ${allowed.join(', ')}.`);
    }
    out[kind] = text;
  }
  return { muted: o.muted, links: o.links, texts: out };
}

export interface RenderInput {
  prize: string;
  keyword: string | null;
  winners?: string[];
  claimDays?: number;
  factor?: number;
  durationSec?: number;
  until?: string;
  link?: string;
}

const BERLIN_TIME = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** Ersetzt Platzhalter, hängt den Link an, kürzt auf MESSAGE_MAX (der Link bleibt ganz). */
export function renderAnnouncement(template: string, input: RenderInput): string {
  const values: Record<string, string> = {
    [P.preis]: input.prize,
    [P.keyword]: input.keyword ?? NO_KEYWORD_FILL,
    [P.gewinner]: (input.winners ?? []).join(', '),
    [P.frist]: input.claimDays === undefined ? '' : String(input.claimDays),
    [P.faktor]: input.factor === undefined ? '' : String(input.factor),
    [P.dauer]: input.durationSec === undefined ? '' : formatDuration(input.durationSec),
    [P.bis]: input.until ? BERLIN_TIME.format(new Date(input.until)) : '',
  };
  let text = template.replace(PLACEHOLDER_RE, (ph) => values[ph] ?? ph).replace(/\s{2,}/g, ' ').trim();
  if (!input.link) return text.slice(0, MESSAGE_MAX);
  const room = MESSAGE_MAX - input.link.length - 1;
  if (text.length > room) text = text.slice(0, Math.max(0, room)).trimEnd();
  return `${text} ${input.link}`;
}

export interface AnnouncementGiveaway {
  id: string;
  prize: string;
  keyword: string | null;
  claimDays: number;
  announcements: AnnouncementSettings;
  kernel: AnyKernel;
  publicUrl: string;
  /** Dauer eines Boosts, falls bekannt; sonst aus until und createdAt des Ereignisses. */
  boostDurationSec?: number;
}

export interface AnnouncementPlan {
  kind: string;
  text: string;
}

type EventLike = { type: string; payload: unknown; createdAt?: Date };

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function kindOf(event: EventLike, kernel: AnyKernel): string | null {
  const p = (event.payload ?? {}) as Record<string, unknown>;
  switch (event.type) {
    case 'giveaway_status_changed':
      if (p.to === 'open') return p.from === 'paused' ? 'resumed' : 'opened';
      if (p.to === 'paused') return 'paused';
      if (p.to === 'closed') return 'closed';
      return null;
    case 'giveaway_drawn':
      return 'winner';
    case 'boost_started':
    case 'boost_ended':
      return event.type;
    default:
      return kernel.display.announcements && event.type in kernel.display.announcements ? event.type : null;
  }
}

/** Welche Ansage ein Ereignis auslöst, mit fertigem Text. null = keine (stumm, unbekannt, kein Text). */
export function planAnnouncement(event: EventLike, g: AnnouncementGiveaway, names: Record<string, string>): AnnouncementPlan | null {
  const kind = kindOf(event, g.kernel);
  if (kind === null) return null;
  if (g.announcements.muted && kind !== 'winner') return null;
  const own = g.announcements.texts[kind];
  let template: string | undefined = own && own.trim() !== '' ? own : undefined;
  if (template === undefined) {
    if ((FRAMEWORK_KINDS as readonly string[]).includes(kind)) {
      const d = DEFAULTS[kind as FrameworkKind];
      template = g.keyword === null && d.withoutKeyword !== undefined ? d.withoutKeyword : d.text;
    } else {
      template = g.kernel.display.announcements?.[kind];
    }
  }
  if (!template) return null;
  const p = (event.payload ?? {}) as Record<string, unknown>;
  const until = str(p.until);
  const durationSec =
    g.boostDurationSec ?? (until && event.createdAt ? Math.max(0, Math.round((Date.parse(until) - event.createdAt.getTime()) / 1000)) : undefined);
  const winners = Array.isArray(p.winners) ? p.winners.map((w) => (typeof w === 'string' ? (names[w] ?? UNKNOWN_WINNER_FILL) : UNKNOWN_WINNER_FILL)) : undefined;
  const text = renderAnnouncement(template, {
    prize: g.prize,
    keyword: g.keyword,
    ...(winners ? { winners } : {}),
    claimDays: g.claimDays,
    ...(typeof p.factor === 'number' ? { factor: p.factor } : {}),
    ...(durationSec === undefined ? {} : { durationSec }),
    ...(until ? { until } : {}),
    ...(g.announcements.links ? { link: `${g.publicUrl.replace(/\/+$/, '')}/g/${g.id}` } : {}),
  });
  return text === '' ? null : { kind, text };
}
