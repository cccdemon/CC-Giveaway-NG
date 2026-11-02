// Bedingungen (NEW_DESIGN.md 6.5): Form je Bedingung, Prüfung der Einstellung und reine Auswertung aus Fakten.
// Die Fakten holt ein GateChecker (Helix, Umsetzung in ingest/twitch/gates.ts) bei der Ziehung.
import { z } from 'zod';
import type { Queryable } from '../../db/pool.js';
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
const DAY_MS = 86_400_000;

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

/** Fakten zu einer Person. follows[kanal] = followed_at oder null (folgt nicht); fehlender Kanal zählt wie null. */
export interface GateFacts {
  follows: Record<Pid, string | null>;
  accountCreatedAt: string | null;
  seenChannels: Pid[];
}

export interface GateResult {
  pid: Pid;
  ok: boolean;
  reasons: string[];
}

/** Kanäle, auf die eine Follow-Regel passt. Ohne Regel: mindestens ein Kanal. */
function followRuleHolds(rule: Extract<GateConfig, { id: 'follow' }> | undefined, channels: Pid[], followed: Set<Pid>): string[] {
  if (rule === undefined) return followed.size >= 1 ? [] : ['follow_age'];
  switch (rule.mode) {
    case 'all':
      return channels.filter((ch) => !followed.has(ch)).map((ch) => `follow:${ch}`);
    case 'min':
      return followed.size >= (rule.min ?? 1) ? [] : ['follow_min'];
    case 'channel':
      return rule.channel !== undefined && followed.has(rule.channel) ? [] : [`follow:${rule.channel}`];
  }
}

/** Rein: wertet alle Bedingungen gegen die Fakten aus. Gründe sind Codes für Nachweis und UI. */
export function evaluateGates(gates: GateConfig[], channels: Pid[], facts: GateFacts, now: Date): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const followRule = gates.find((g): g is Extract<GateConfig, { id: 'follow' }> => g.id === 'follow');
  const followed = new Set(channels.filter((ch) => typeof facts.follows[ch] === 'string'));
  for (const g of gates) {
    switch (g.id) {
      case 'follow':
        reasons.push(...followRuleHolds(g, channels, followed));
        break;
      case 'account_age': {
        const created = facts.accountCreatedAt === null ? NaN : Date.parse(facts.accountCreatedAt);
        if (!(now.getTime() - created >= g.days * DAY_MS)) reasons.push('account_age');
        break;
      }
      case 'follow_age': {
        const old = new Set([...followed].filter((ch) => now.getTime() - Date.parse(facts.follows[ch]!) >= g.days * DAY_MS));
        if (followRuleHolds(followRule, channels, old).length > 0) reasons.push('follow_age');
        break;
      }
      case 'presence':
        if (facts.seenChannels.filter((ch) => channels.includes(ch)).length < g.minChannels) reasons.push('presence');
        break;
    }
  }
  return { ok: reasons.length === 0, reasons };
}

export interface GateCheckInput {
  channels: Pid[];
  gates: GateConfig[];
  pids: Pid[];
  /** pid → Kanäle mit Gutschrift (Anwesenheitsbedingung). */
  seen: Record<Pid, Pid[]>;
  now: Date;
}

export type GateCheckErrorCode = 'twitch_unreachable' | 'token_invalid' | 'no_checker';

/** Die Bedingungen lassen sich nicht prüfen. Die Ziehung bricht ab, ohne Ereignis (NEW_DESIGN.md 12.1). */
export class GateCheckError extends Error {
  constructor(
    readonly code: GateCheckErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'GateCheckError';
  }
}

export interface GateChecker {
  /** Ein Ergebnis je pid. Wirft GateCheckError, wenn die Fakten nicht zu holen sind. */
  check(db: Queryable, input: GateCheckInput): Promise<GateResult[]>;
}

/** Ohne Bedingungen besteht jeder. Mit Bedingungen prüft nur ein echter Prüfer (App-Prozess). */
export const noGates: GateChecker = {
  check: async (_db, input) => {
    if (input.gates.length > 0) throw new GateCheckError('no_checker', 'Bedingungen lassen sich in diesem Prozess nicht prüfen. Ziehe in der App.');
    return input.pids.map((pid) => ({ pid, ok: true, reasons: [] }));
  },
};
