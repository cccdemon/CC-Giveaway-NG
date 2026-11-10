// Verlaufseinträge als deutsche Sätze (NEW_DESIGN.md 5.3, 11.1). Teilnehmer-Namen maskiert der Streamermodus, Kanalnamen nicht.
import { kindLabel } from './announcements.js';
import type { HistoryEntry } from './api/types.js';
import { dateTime, duration, number } from './format.js';
import { maskName } from './mask.js';
import { L } from './texts/labels.js';
import { S } from './texts/sentences.js';

type Names = Record<string, string>;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Sekunden lesbar: unter einer Minute in Sekunden, sonst als Dauer, mit Vorzeichen. */
export function signedSeconds(sec: number): string {
  const sign = sec < 0 ? '-' : '+';
  const abs = Math.abs(sec);
  return `${sign}${abs < 60 ? `${abs} s` : duration(abs)}`;
}

export function historyText(e: HistoryEntry, names: Names, mask: boolean): string {
  const p = obj(e.payload);
  const participant = (pid: string): string => (mask ? maskName(pid) : (names[pid] ?? L.participant.deletedWith(pid)));
  const channel = (pid: string): string => names[pid] ?? L.participant.deletedWith(pid);
  const h = S.history;
  switch (e.type) {
    case 'giveaway_created':
      return h.created;
    case 'giveaway_status_changed': {
      const to = str(p.to) as keyof typeof h.status;
      return h.status[to] ?? h.statusOther(str(p.to));
    }
    case 'giveaway_settings_changed': {
      const before = obj(p.before);
      const after = obj(p.after);
      const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
      const labels = keys.map((k) => (L.fields as Record<string, unknown>)[k]).map((v, i) => (typeof v === 'string' ? v : keys[i]!));
      return labels.length === 0 ? h.settingsUnchanged : h.settings(labels.join(', '));
    }
    case 'giveaway_legal_frozen':
      return h.legalFrozen;
    case 'participant_registered':
      return h.registered(participant(str(p.pid)));
    case 'participant_withdrawn':
      return h.withdrawn(participant(str(p.pid)));
    case 'watch_credited': {
      const entries = arr(p.entries).map(obj);
      const factor = num(p.factor) || 1;
      const sum = entries.reduce((acc, x) => acc + num(x.sec) * factor, 0);
      return h.watchCredited(channel(str(p.channel)), entries.length, duration(sum));
    }
    case 'chat_credited': {
      const entries = arr(p.entries).map(obj);
      const factor = num(p.factor) || 1;
      const sum = entries.reduce((acc, x) => acc + num(x.sec) * factor, 0);
      return h.chatCredited(channel(str(p.channel)), entries.length, sum);
    }
    case 'watch_corrected': {
      const first = obj(arr(p.entries)[0]);
      return h.corrected(participant(str(first.pid)), channel(str(p.channel)), signedSeconds(num(first.sec)));
    }
    case 'boost_started':
      return h.boostStarted(num(p.factor), dateTime(str(p.until)));
    case 'boost_ended':
      return h.boostEnded;
    case 'giveaway_drawn':
      return h.drawn(arr(p.winners).map((w) => participant(str(w))).join(', '));
    case 'winner_status_set': {
      const to = str(p.to) as keyof typeof L.winner;
      return h.winnerStatus(participant(str(p.pid)), L.winner[to] ?? str(p.to));
    }
    case 'event_voided':
      return h.voided(typeLabel(str(p.targetType)));
    case 'unregistered_purged':
      return h.purged(arr(p.pids).length);
    case 'instant_window_opened':
      return h.windowOpened(dateTime(str(p.until)));
    case 'instant_window_closed':
      return h.windowClosed;
    case 'tickets_bought':
      return h.ticketsBought(participant(str(p.pid)), number(num(p.count)), number(num(p.coins)));
    case 'tickets_refunded':
      return h.ticketsRefunded(participant(str(p.pid)), number(num(p.count)), number(num(p.coins)));
    case 'announcement_sent': {
      const kind = kindLabel(str(p.kind));
      return p.ok === false ? h.announcementFailed(kind, channel(str(p.channel)), str(p.error) || '–') : h.announced(kind, channel(str(p.channel)));
    }
    default: {
      const keys = Object.keys(p);
      return keys.length === 0 ? `${e.type}.` : `${e.type}: ${keys.join(', ')}.`;
    }
  }
}

/** Kurzname eines Ereignistyps für „Aufgehoben: …“. */
export function typeLabel(type: string): string {
  return (L.events as Record<string, string>)[type] ?? type;
}
