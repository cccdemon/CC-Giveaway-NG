import { redirect } from '@sveltejs/kit';
import { apiOf, loadOrRedirect } from '#lib/api/client.js';
import type { PublicGiveaway } from '#lib/api/types.js';
import type { PageLoad } from './$types';

/** Öffentliche Giveaway-Seite (Festlegung 6): ohne Sitzung Gewinn, Kern, Kanäle, Keyword, Rechtstexte. Mit Sitzung ins Portal. */
export const load: PageLoad = async ({ parent, fetch, url, params }) => {
  const { me } = await parent();
  if (me) redirect(303, `/portal/giveaways/${params.id}`);
  const giveaway = await loadOrRedirect(apiOf(fetch).get<PublicGiveaway>(`/api/public/giveaways/${params.id}`), url);
  return { giveaway };
};
