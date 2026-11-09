import { safeReturnPath } from '#lib/api/client.js';
import { requireSession } from '#lib/guard.js';
import type { PageLoad } from './$types';

/** Nutzungsbedingungen der Plattform (NEW_DESIGN.md 9.2 Schritt 3): versioniert, Zustimmung Pflicht vor Streamer-Seiten. */
export const load: PageLoad = async ({ parent, url }) => {
  const { me } = await parent();
  const m = requireSession(me, url);
  return { me: m, ret: safeReturnPath(url.searchParams.get('return')) ?? '/giveaways' };
};
