import { apiOf, loadOrRedirect, safeReturnPath } from '#lib/api/client.js';
import type { Terms } from '#lib/api/types.js';
import { requireSession } from '#lib/guard.js';
import type { PageLoad } from './$types';

/** Nutzungsbedingungen der Plattform (NEW_DESIGN.md 9.2 Schritt 3): versioniert, Zustimmung Pflicht vor Streamer-Seiten. */
export const load: PageLoad = async ({ parent, fetch, url, depends }) => {
  const { me } = await parent();
  const m = requireSession(me, url);
  depends('api:terms');
  const terms = await loadOrRedirect(apiOf(fetch).get<Terms>('/api/terms'), url);
  return { me: m, terms, ret: safeReturnPath(url.searchParams.get('return')) ?? '/giveaways' };
};
