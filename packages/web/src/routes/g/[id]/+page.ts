import { redirect } from '@sveltejs/kit';
import { ApiError, apiOf, loadOrRedirect } from '#lib/api/client.js';
import type { PublicGiveaway } from '#lib/api/types.js';
import type { PageLoad } from './$types';

/** Öffentliche Giveaway-Seite (Festlegung 6): ohne Sitzung Gewinn, Kern, Kanäle, Keyword, Rechtstexte. Mit Sitzung ins Portal. */
export const load: PageLoad = async ({ parent, fetch, url, params }) => {
  const { me } = await parent();
  const api = apiOf(fetch);
  if (me) {
    // Ins Portal nur, wenn es dort eine Sicht gibt (Beteiligung oder Offen). Sonst bleibt die öffentliche Seite.
    let hasPortalView = true;
    try {
      await api.get(`/api/portal/giveaways/${params.id}`);
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 404)) throw e;
      hasPortalView = false;
    }
    if (hasPortalView) redirect(303, `/portal/giveaways/${params.id}`);
  }
  const giveaway = await loadOrRedirect(api.get<PublicGiveaway>(`/api/public/giveaways/${params.id}`), url);
  return { giveaway, me };
};
