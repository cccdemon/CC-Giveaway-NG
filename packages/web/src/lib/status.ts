// Zustände als Wort + Icon, nie nur Farbe (NEW_DESIGN.md 11.5). Tätigkeit und Aktionen je Zustand (11.2, 7.1) kommen in Task 4 dazu.
import type { GiveawayStatus } from './api/types.js';
import type { IconName } from './components/icons.js';
import { L } from './texts/labels.js';

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
