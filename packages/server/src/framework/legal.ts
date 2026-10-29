// Rechtstexte der Streamer (NEW_DESIGN.md 9.4): Impressum, Teilnahmebedingungen, Datenschutzhinweis.
import { z } from 'zod';
import { reject, type Rejection } from '../shared/rejection.js';

export interface LegalTexts {
  impressumUrl: string | null;
  terms: { text: string } | { url: string } | null;
  privacyUrl: string | null;
}

export const EMPTY_LEGAL: LegalTexts = { impressumUrl: null, terms: null, privacyUrl: null };

export const URL_MAX = 500;
export const TERMS_TEXT_MAX = 20_000;

const urlSchema = z.string().max(URL_MAX).refine((s) => /^https?:\/\/\S+$/i.test(s), { message: 'url' });

export const legalSchema = z.object({
  impressumUrl: urlSchema.nullable(),
  terms: z.union([z.object({ text: z.string().min(1).max(TERMS_TEXT_MAX) }), z.object({ url: urlSchema })]).nullable(),
  privacyUrl: urlSchema.nullable(),
});

const INVALID_URL = (): Rejection => reject('invalid_url', 'Ein Link ist ungültig. Gib eine vollständige Adresse mit https:// an.');
const TERMS_TOO_LONG = (): Rejection => reject('terms_too_long', `Die Teilnahmebedingungen dürfen höchstens ${TERMS_TEXT_MAX} Zeichen haben.`);
const INVALID_LEGAL = (): Rejection => reject('invalid_legal', 'Die Rechtstexte sind ungültig.');

function checkUrl(u: unknown): Rejection | null {
  if (u === null) return null;
  if (typeof u !== 'string') return INVALID_LEGAL();
  return urlSchema.safeParse(u).success ? null : INVALID_URL();
}

/** Prüft ein vollständiges LegalTexts-Objekt und liefert es normalisiert zurück. */
export function checkLegal(x: unknown): LegalTexts | Rejection {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return INVALID_LEGAL();
  const o = x as Record<string, unknown>;
  const impressum = checkUrl(o.impressumUrl ?? null);
  if (impressum) return impressum;
  const privacy = checkUrl(o.privacyUrl ?? null);
  if (privacy) return privacy;
  const terms = o.terms ?? null;
  if (terms !== null) {
    if (typeof terms !== 'object' || Array.isArray(terms)) return INVALID_LEGAL();
    const t = terms as Record<string, unknown>;
    if ('text' in t) {
      if (typeof t.text !== 'string' || !t.text.trim()) return INVALID_LEGAL();
      if (t.text.length > TERMS_TEXT_MAX) return TERMS_TOO_LONG();
    } else if ('url' in t) {
      const u = checkUrl(t.url);
      if (u) return u;
    } else {
      return INVALID_LEGAL();
    }
  }
  const parsed = legalSchema.safeParse({ impressumUrl: o.impressumUrl ?? null, terms, privacyUrl: o.privacyUrl ?? null });
  return parsed.success ? parsed.data : INVALID_LEGAL();
}

/** Namen der Felder, die noch fehlen, in der Reihenfolge der Checkliste. */
export function missingLegal(l: LegalTexts): string[] {
  const out: string[] = [];
  if (!l.impressumUrl) out.push('Impressum');
  if (!l.terms) out.push('Teilnahmebedingungen');
  if (!l.privacyUrl) out.push('Datenschutzhinweis');
  return out;
}
