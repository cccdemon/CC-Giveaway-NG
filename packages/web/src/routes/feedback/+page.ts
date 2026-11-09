import { requireSession } from '#lib/guard.js';
import type { PageLoad } from './$types';

/** Rückmeldung an den Betreiber (NEW_DESIGN.md 11.4). Sitzung Pflicht. */
export const load: PageLoad = async ({ parent, url }) => {
  const { me } = await parent();
  return { me: requireSession(me, url) };
};
