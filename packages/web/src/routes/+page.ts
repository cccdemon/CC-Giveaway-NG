import { redirect } from '@sveltejs/kit';
import { safeReturnPath } from '#lib/api/client.js';
import type { PageLoad } from './$types';

/** Startseite: mit Sitzung weiter zur Übersicht oder zum gewünschten Pfad, ohne Sitzung die Anmeldung. */
export const load: PageLoad = async ({ parent, url }) => {
  const { me } = await parent();
  const ret = safeReturnPath(url.searchParams.get('return'));
  if (me) redirect(303, ret ?? '/giveaways');
  return { ret };
};
