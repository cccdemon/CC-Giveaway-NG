// Bedingungen (NEW_DESIGN.md 6.5): Form je Bedingung und Prüfung der Einstellung. Die Auswertung folgt in der Ziehung.
import { z } from 'zod';
import type { GateId, Pid } from '../../kernel-api/index.js';
import { reject, type Rejection } from '../../shared/rejection.js';
import { UUID_RE } from '../authorize.js';

export type GateConfig =
  | { id: 'follow'; mode: 'all' | 'min' | 'channel'; min?: number; channel?: Pid }
  | { id: 'account_age'; days: number }
  | { id: 'follow_age'; days: number }
  | { id: 'presence'; minChannels: number };

export const GATE_IDS = ['follow', 'account_age', 'follow_age', 'presence'] as const satisfies readonly GateId[];

const DAYS_MIN = 1;
const DAYS_MAX = 3650;

const days = z.int().min(DAYS_MIN).max(DAYS_MAX);
const gateSchema = z.discriminatedUnion('id', [
  z.object({ id: z.literal('follow'), mode: z.enum(['all', 'min', 'channel']), min: z.int().min(1).optional(), channel: z.string().regex(UUID_RE).optional() }),
  z.object({ id: z.literal('account_age'), days }),
  z.object({ id: z.literal('follow_age'), days }),
  z.object({ id: z.literal('presence'), minChannels: z.int().min(1) }),
]);

const INVALID = (message: string): Rejection => reject('invalid_gate', message);

/** Prüft eine Bedingung gegen die Kanäle des Giveaways. Liefert die bereinigte Bedingung oder eine Ablehnung. */
export function checkGateConfig(gate: unknown, channels: Pid[]): GateConfig | Rejection {
  const parsed = gateSchema.safeParse(gate);
  if (!parsed.success) return INVALID('Eine Bedingung ist ungültig. Prüfe Art und Werte.');
  const g = parsed.data;
  switch (g.id) {
    case 'follow':
      if (g.mode === 'channel') {
        if (g.channel === undefined || !channels.includes(g.channel)) return INVALID('Die Follow-Bedingung braucht einen Kanal des Giveaways.');
        return { id: 'follow', mode: 'channel', channel: g.channel };
      }
      if (g.mode === 'min') {
        if (g.min === undefined || g.min > channels.length) return INVALID('Die Follow-Bedingung braucht eine Mindestzahl bis zur Zahl der Kanäle.');
        return { id: 'follow', mode: 'min', min: g.min };
      }
      return { id: 'follow', mode: 'all' };
    case 'presence':
      if (g.minChannels > channels.length) return INVALID('Die Anwesenheitsbedingung braucht höchstens so viele Kanäle, wie das Giveaway hat.');
      return g;
    default:
      return g;
  }
}
