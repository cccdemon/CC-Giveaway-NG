// Gültige Fassung der Nutzungsbedingungen (NEW_DESIGN.md 9.2): die höchste veröffentlichte Version, sonst Version 1 ohne Text.
import type { Queryable } from '../db/pool.js';

/** Fassung, bevor der Betreiber je eine veröffentlicht hat. Konten mit dieser Version bleiben gültig. */
export const TERMS_FALLBACK_VERSION = 1;

export interface CurrentTerms {
  version: number;
  text: string | null;
  publishedAt: string | null;
}

export async function currentTerms(db: Queryable): Promise<CurrentTerms> {
  const r = await db.query<{ version: number; text: string; published_at: Date }>('SELECT version, text, published_at FROM platform_terms ORDER BY version DESC LIMIT 1');
  const row = r.rows[0];
  if (!row) return { version: TERMS_FALLBACK_VERSION, text: null, publishedAt: null };
  return { version: row.version, text: row.text, publishedAt: row.published_at.toISOString() };
}
