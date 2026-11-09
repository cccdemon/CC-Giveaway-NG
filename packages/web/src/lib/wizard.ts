// Start-Assistent (NEW_DESIGN.md 11.1): Entwurf, Defaults aus dem Kern, Prüfung je Schritt, Umbau in die Einstellungen der API.
// Rein, ohne I/O. Die Grenzen entsprechen denen des Servers (lifecycle.ts, services.ts, gates.ts, legal.ts).
import type { ChatBonusSettings, Counting, CreateSettings, GateConfig, KernelInfo, LegalTexts } from './api/types.js';
import { L } from './texts/labels.js';
import { S } from './texts/sentences.js';

export type Step = 1 | 2 | 3 | 4 | 5 | 6;
export const STEPS: readonly Step[] = [1, 2, 3, 4, 5, 6];

export interface WizardDraft {
  kernelId: string | null;
  teamId: string | null;
  prize: string;
  sponsor: string;
  winnersCount: number;
  claimDays: number;
  contact: string;
  config: Record<string, unknown>;
  counting: Counting;
  purgeDays: number;
  keyword: string;
  chatBonus: ChatBonusSettings;
  channels: string[];
  gates: GateConfig[];
  /** 'profile' = die Texte des Profils gelten (settings.legal = null). */
  legal: 'profile' | LegalTexts;
}

export const LIMITS = {
  prizeMax: 200,
  sponsorMax: 200,
  contactMax: 200,
  winners: { min: 1, max: 100 },
  claimDays: { min: 1, max: 90 },
  purgeDays: { min: 1, max: 90 },
  days: { min: 1, max: 3650 },
  keyword: /^\S{2,32}$/,
} as const;

export function emptyDraft(): WizardDraft {
  return {
    kernelId: null,
    teamId: null,
    prize: '',
    sponsor: '',
    winnersCount: 1,
    claimDays: 14,
    contact: '',
    config: {},
    counting: 'registered',
    purgeDays: 7,
    keyword: '',
    chatBonus: { enabled: true, sec: 2, minWords: 4, cooldownSec: 10 },
    channels: [],
    gates: [],
    legal: 'profile',
  };
}

/** Kern wählen: Konfiguration auf die Defaults des Schemas, Bedingungen auf die unterstützten begrenzen. */
export function withKernel(d: WizardDraft, k: KernelInfo): WizardDraft {
  const config = Object.fromEntries(Object.entries(k.configSchema).map(([key, f]) => [key, f.default]));
  return { ...d, kernelId: k.id, config, gates: d.gates.filter((g) => k.supportedGates.includes(g.id)) };
}

export const legalComplete = (l: LegalTexts | null | undefined): boolean => !!l && l.impressumUrl !== null && l.terms !== null && l.privacyUrl !== null;

/** Was im Profil fehlt, als Wörter für den Hinweis. */
export function legalMissing(l: LegalTexts): string[] {
  const out: string[] = [];
  if (l.impressumUrl === null) out.push(L.legal.impressum);
  if (l.terms === null) out.push(L.legal.terms);
  if (l.privacyUrl === null) out.push(L.legal.privacy);
  return out;
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const inRange = (v: unknown, min: number, max: number): boolean => isInt(v) && v >= min && v <= max;

/** Fehler je Feld (leer = Schritt in Ordnung). Konfig-Fehler stehen unter `config.<feld>`. */
export function validateStep(step: Step, d: WizardDraft, k: KernelInfo | null, teamChannels: string[], profileLegal?: LegalTexts | null): Record<string, string> {
  const e: Record<string, string> = {};
  switch (step) {
    case 1:
      if (!d.kernelId || !k) e.kernelId = S.wizard.kernelRequired;
      break;
    case 2: {
      if (d.prize.trim() === '') e.prize = S.wizard.prizeRequired;
      else if (d.prize.trim().length > LIMITS.prizeMax) e.prize = S.wizard.tooLong(LIMITS.prizeMax);
      if (d.sponsor.trim().length > LIMITS.sponsorMax) e.sponsor = S.wizard.tooLong(LIMITS.sponsorMax);
      if (!inRange(d.winnersCount, LIMITS.winners.min, LIMITS.winners.max)) e.winnersCount = S.wizard.range(LIMITS.winners.min, LIMITS.winners.max);
      if (!inRange(d.claimDays, LIMITS.claimDays.min, LIMITS.claimDays.max)) e.claimDays = S.wizard.range(LIMITS.claimDays.min, LIMITS.claimDays.max);
      if (d.contact.trim().length > LIMITS.contactMax) e.contact = S.wizard.tooLong(LIMITS.contactMax);
      if (d.keyword.trim() !== '' && !LIMITS.keyword.test(d.keyword.trim())) e.keyword = S.wizard.keywordInvalid;
      if (d.counting === 'first_seen' && !inRange(d.purgeDays, LIMITS.purgeDays.min, LIMITS.purgeDays.max)) e.purgeDays = S.wizard.range(LIMITS.purgeDays.min, LIMITS.purgeDays.max);
      if (d.chatBonus.enabled) {
        if (!inRange(d.chatBonus.sec, 1, 60)) e['chatBonus.sec'] = S.wizard.range(1, 60);
        if (!inRange(d.chatBonus.minWords, 1, 50)) e['chatBonus.minWords'] = S.wizard.range(1, 50);
        if (!inRange(d.chatBonus.cooldownSec, 0, 3600)) e['chatBonus.cooldownSec'] = S.wizard.range(0, 3600);
      }
      if (k) {
        for (const [key, f] of Object.entries(k.configSchema)) {
          const v = d.config[key];
          if (f.kind === 'int' && !inRange(v, f.min, f.max)) e[`config.${key}`] = f.unit === 'sec' ? S.wizard.rangeMinutes(Math.ceil(f.min / 60), Math.floor(f.max / 60)) : S.wizard.range(f.min, f.max);
          if (f.kind === 'text' && (typeof v !== 'string' || v.length > f.maxLength)) e[`config.${key}`] = S.wizard.tooLong(f.maxLength);
          if (f.kind === 'bool' && typeof v !== 'boolean') e[`config.${key}`] = S.wizard.boolRequired;
        }
      }
      break;
    }
    case 3:
      if (d.channels.length === 0) e.channels = S.wizard.channelsRequired;
      else if (d.channels.some((c) => !teamChannels.includes(c))) e.channels = S.wizard.channelsOutside;
      break;
    case 4: {
      const n = d.channels.length;
      for (const g of d.gates) {
        if (k && !k.supportedGates.includes(g.id)) e.gates = S.wizard.gateUnsupported;
        switch (g.id) {
          case 'follow':
            if (g.mode === 'channel' && (g.channel === undefined || !d.channels.includes(g.channel))) e.gates = S.wizard.gateChannel;
            if (g.mode === 'min' && !inRange(g.min, 1, n)) e.gates = S.wizard.gateMin(n);
            break;
          case 'presence':
            if (!inRange(g.minChannels, 1, n)) e.gates = S.wizard.gatePresence(n);
            break;
          case 'account_age':
          case 'follow_age':
            if (!inRange(g.days, LIMITS.days.min, LIMITS.days.max)) e.gates = S.wizard.gateDays(LIMITS.days.min, LIMITS.days.max);
            break;
        }
      }
      break;
    }
    case 5:
      if (d.legal === 'profile') {
        if (!legalComplete(profileLegal)) e.legal = S.wizard.profileIncomplete(profileLegal ? legalMissing(profileLegal).join(', ') : L.wizard.all);
      } else if (!legalComplete(d.legal)) e.legal = S.wizard.ownRequired;
      break;
    case 6:
      break;
  }
  return e;
}

const clean = (s: string): string | null => (s.trim() === '' ? null : s.trim());

export function toSettings(d: WizardDraft): CreateSettings {
  return {
    prize: d.prize.trim(),
    sponsor: clean(d.sponsor),
    channels: [...d.channels],
    winnersCount: d.winnersCount,
    claimDays: d.claimDays,
    gates: d.gates.map((g) => ({ ...g })),
    legal: d.legal === 'profile' ? null : d.legal,
    contact: clean(d.contact),
    counting: d.counting,
    purgeDays: d.purgeDays,
    keyword: clean(d.keyword),
    chatBonus: { ...d.chatBonus },
    config: { ...d.config },
  };
}

const STEP_OF_CODE: Record<string, Step> = {
  prize_required: 2,
  prize_too_long: 2,
  sponsor_too_long: 2,
  invalid_winners_count: 2,
  invalid_claim_days: 2,
  contact_too_long: 2,
  invalid_keyword: 2,
  keyword_reserved: 2,
  invalid_config: 2,
  invalid_counting: 2,
  invalid_purge_days: 2,
  invalid_chat_bonus: 2,
  channels_required: 3,
  invalid_channel: 3,
  channel_not_in_team: 3,
  invalid_gate: 4,
  gate_unsupported: 4,
  legal_required: 5,
  invalid_legal: 5,
  invalid_url: 5,
  terms_too_long: 5,
  legal_unreachable: 5,
  legal_changed: 5,
};

/** Zu welchem Schritt eine Ablehnung des Servers gehört (Festlegung 9). */
export function stepOfRejection(code: string): 2 | 3 | 4 | 5 | 6 {
  return (STEP_OF_CODE[code] as 2 | 3 | 4 | 5 | undefined) ?? 6;
}
