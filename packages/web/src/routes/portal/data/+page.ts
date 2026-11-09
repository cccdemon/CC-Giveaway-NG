import { requireSession } from '#lib/guard.js';
import type { PageLoad } from './$types';

/** Meine Daten (NEW_DESIGN.md 11.3): ansehen, herunterladen, alles löschen. */
export const load: PageLoad = async ({ parent, url }) => {
  const { me } = await parent();
  return { me: requireSession(me, url) };
};
