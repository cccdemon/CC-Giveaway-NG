// Zustände als Wort + Icon, nie nur Farbe (NEW_DESIGN.md 11.5). Tätigkeit (11.2) und Aktionen je Zustand (7.1).
import type { BoostState, GiveawayStatus, KernelInfo, WinnerStatus } from './api/types.js';
import type { IconName } from './components/icons.js';
import { L } from './texts/labels.js';
import { S } from './texts/sentences.js';

export type Tone = 'ok' | 'info' | 'warn' | 'err' | 'muted' | 'text';

export const STATUS_VIEW: Record<GiveawayStatus, { word: string; icon: IconName; tone: Tone }> = {
  draft: { word: L.status.draft, icon: 'circle', tone: 'muted' },
  open: { word: L.status.open, icon: 'check', tone: 'ok' },
  paused: { word: L.status.paused, icon: 'pause', tone: 'info' },
  closed: { word: L.status.closed, icon: 'lock', tone: 'text' },
  drawn: { word: L.status.drawn, icon: 'star', tone: 'ok' },
  completed: { word: L.status.completed, icon: 'check', tone: 'muted' },
  cancelled: { word: L.status.cancelled, icon: 'x', tone: 'err' },
};

/** Der Server liefert keinen Tätigkeits-Feed. Die Oberfläche leitet die Tätigkeit aus Zustand und laufendem Befehl ab (Festlegung 7). */
export function activityOf(status: GiveawayStatus, busy: 'draw' | 'redraw' | null): string {
  if (busy !== null) return S.activity.drawing;
  return S.activity[status];
}

export type Action =
  | 'open'
  | 'pause'
  | 'resume'
  | 'close'
  | 'reopen'
  | 'draw'
  | 'complete'
  | 'cancel'
  | 'boost'
  | 'stopBoost'
  | 'correct'
  | 'settings'
  | `kernel:${string}`;

export interface ActionsView {
  /** Genau eine Hauptaktion je Ansicht (Kupfer), null ohne. */
  primary: Action | null;
  others: Action[];
  /** Aktion sichtbar, aber gesperrt, mit Grund am Knopf (NEW_DESIGN.md 11.2). */
  hints: Partial<Record<Action, string>>;
}

export interface ActionsInput {
  status: GiveawayStatus;
  boost: BoostState | null;
  kernel: Pick<KernelInfo, 'usesServices' | 'commands'>;
  winners: { status: WinnerStatus }[];
}

const CORRECTABLE: readonly GiveawayStatus[] = ['draft', 'open', 'paused', 'closed'];

export function actionsOf(d: ActionsInput): ActionsView {
  const hints: Partial<Record<Action, string>> = {};
  const others: Action[] = [];
  let primary: Action | null = null;
  const collecting = d.status === 'open' || d.status === 'paused';
  switch (d.status) {
    case 'draft':
      primary = 'open';
      break;
    case 'open':
      primary = 'pause';
      others.push('close', 'draw');
      hints.draw = S.hints.drawAfterClose;
      break;
    case 'paused':
      primary = 'resume';
      others.push('close', 'draw');
      hints.draw = S.hints.drawAfterClose;
      break;
    case 'closed':
      primary = 'draw';
      others.push('reopen');
      break;
    case 'drawn': {
      const allDone = d.winners.length > 0 && d.winners.every((w) => w.status === 'done' || w.status === 'forfeited');
      if (allDone) primary = 'complete';
      else hints.complete = S.hints.completeAfterWinners;
      break;
    }
    case 'completed':
    case 'cancelled':
      return { primary: null, others: [], hints: {} };
  }
  if (collecting && d.kernel.usesServices.includes('boost')) others.push(d.boost ? 'stopBoost' : 'boost');
  if (CORRECTABLE.includes(d.status) && d.kernel.usesServices.includes('watchtime')) others.push('correct');
  if (d.status === 'draft' || collecting) others.push('settings');
  if (d.status === 'open') {
    for (const c of d.kernel.commands) if (c.issuer === 'streamer') others.push(`kernel:${c.type}`);
  }
  others.push('cancel');
  return { primary, others, hints };
}

export const ACTION_LABELS: Record<Exclude<Action, `kernel:${string}`>, string> = {
  open: L.actions.open,
  pause: L.actions.pause,
  resume: L.actions.resume,
  close: L.actions.close,
  reopen: L.actions.reopen,
  draw: L.actions.draw,
  complete: L.actions.complete,
  cancel: L.actions.cancel,
  boost: L.actions.boost,
  stopBoost: L.actions.stopBoost,
  correct: L.actions.correct,
  settings: L.actions.settings,
};

export const ACTION_ICONS: Partial<Record<Exclude<Action, `kernel:${string}`>, IconName>> = {
  open: 'play',
  pause: 'pause',
  resume: 'play',
  close: 'lock',
  reopen: 'undo',
  draw: 'star',
  complete: 'check',
  cancel: 'x',
  boost: 'bolt',
  stopBoost: 'bolt',
};
