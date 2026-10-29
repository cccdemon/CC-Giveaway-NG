// Rechtstexte der Streamer (NEW_DESIGN.md 9.4): Impressum, Teilnahmebedingungen, Datenschutzhinweis.
import { createHash } from 'node:crypto';
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

/** Je Feld: Giveaway-Wert, sonst Profil-Wert des handelnden Streamers. */
export function mergeLegal(giveaway: LegalTexts | null, profile: LegalTexts | null): LegalTexts {
  const g = giveaway ?? EMPTY_LEGAL;
  const p = profile ?? EMPTY_LEGAL;
  return { impressumUrl: g.impressumUrl ?? p.impressumUrl, terms: g.terms ?? p.terms, privacyUrl: g.privacyUrl ?? p.privacyUrl };
}

/** Eingefrorene Fassung beim Öffnen: Text als Kopie, URL mit SHA-256 des Inhalts (NEW_DESIGN.md 9.4). */
export interface FrozenLegal {
  impressum: { url: string; hash: string };
  terms: { text: string } | { url: string; hash: string };
  privacy: { url: string; hash: string };
  frozenAt: string;
}

const hashed = z.object({ url: urlSchema, hash: z.string().min(1) });
export const frozenLegalSchema = z.object({
  impressum: hashed,
  terms: z.union([z.object({ text: z.string().min(1).max(TERMS_TEXT_MAX) }), hashed]),
  privacy: hashed,
  frozenAt: z.string(),
});

export type FetchResult = { ok: true; hash: string } | { ok: false };
export type LegalFetcher = (url: string) => Promise<FetchResult>;

export const FETCH_TIMEOUT_MS = 5_000;

/** Holt die Seite und liefert den SHA-256 (hex) des Bodys. Jeder Fehler und jeder Status außer 2xx ist „nicht erreichbar“. */
export async function fetchHash(url: string, o: { timeoutMs?: number; fetch?: typeof fetch } = {}): Promise<FetchResult> {
  const doFetch = o.fetch ?? fetch;
  try {
    const res = await doFetch(url, { signal: AbortSignal.timeout(o.timeoutMs ?? FETCH_TIMEOUT_MS), redirect: 'follow' });
    if (!res.ok) return { ok: false };
    const body = Buffer.from(await res.arrayBuffer());
    return { ok: true, hash: createHash('sha256').update(body).digest('hex') };
  } catch {
    return { ok: false };
  }
}
