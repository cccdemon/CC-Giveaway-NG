// Rechtstexte der Streamer (NEW_DESIGN.md 9.4): Impressum, Teilnahmebedingungen, Datenschutzhinweis.
import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
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
export const FETCH_MAX_BYTES = 2 * 1024 * 1024;
export const FETCH_MAX_REDIRECTS = 3;

function ipv4Private(a: number, b: number): boolean {
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

/** Loopback, link-local, private Netze, Multicast, unspecified; IPv6 inklusive ::ffff:-Abbildung von IPv4. */
export function isPrivateAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) {
    const [a, b] = ip.split('.').map(Number);
    return ipv4Private(a!, b!);
  }
  if (kind !== 6) return true;
  const lower = ip.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return isPrivateAddress(mapped[1]!);
  if (lower === '::' || lower === '::1') return true;
  const first = parseInt(lower.split(':')[0] || '0', 16);
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00;
}

export interface FetchOptions {
  timeoutMs?: number;
  fetch?: typeof fetch;
  /** Nur für Tests: erlaubt Loopback, private Netze und beliebige Ports. */
  allowPrivate?: boolean;
}

/** Ein Ziel ist erlaubt: http(s), Standardport, und alle aufgelösten Adressen sind öffentlich. */
async function targetAllowed(url: URL, allowPrivate: boolean): Promise<boolean> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (allowPrivate) return true;
  if (url.port !== '') return false;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  return addresses.length > 0 && addresses.every((a) => !isPrivateAddress(a));
}

async function readLimited(res: Response, max: number): Promise<Buffer | null> {
  if (!res.body) return Buffer.alloc(0);
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > max) return null;
  const chunks: Buffer[] = [];
  let size = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/**
 * Holt die Seite und liefert den SHA-256 (hex) des Bodys. Jeder Fehler, jeder Status außer 2xx, jedes private Ziel
 * (auch nach Umleitung), ein Body über FETCH_MAX_BYTES und mehr als FETCH_MAX_REDIRECTS Umleitungen sind „nicht erreichbar“.
 * Streamer geben diese URLs vor, darum darf der Server damit nie ins interne Netz greifen.
 */
export async function fetchHash(url: string, o: FetchOptions = {}): Promise<FetchResult> {
  const doFetch = o.fetch ?? fetch;
  const allowPrivate = o.allowPrivate ?? false;
  const signal = AbortSignal.timeout(o.timeoutMs ?? FETCH_TIMEOUT_MS);
  try {
    let current = new URL(url);
    for (let hop = 0; hop <= FETCH_MAX_REDIRECTS; hop++) {
      if (!(await targetAllowed(current, allowPrivate))) return { ok: false };
      const res = await doFetch(current, { signal, redirect: 'manual', headers: { 'user-agent': 'CC-Giveaway (Rechtstext-Nachweis)' } });
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (!location) return { ok: false };
        current = new URL(location, current);
        continue;
      }
      if (!res.ok) return { ok: false };
      const body = await readLimited(res, FETCH_MAX_BYTES);
      if (body === null) return { ok: false };
      return { ok: true, hash: createHash('sha256').update(body).digest('hex') };
    }
    return { ok: false };
  } catch {
    return { ok: false };
  }
}
