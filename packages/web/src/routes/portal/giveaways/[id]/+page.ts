import { apiOf, loadOrRedirect } from '#lib/api/client.js';
import type { PortalDetail } from '#lib/api/types.js';
import { requireSession } from '#lib/guard.js';
import type { PageLoad } from './$types';

/** Eigene Sicht auf ein Giveaway (NEW_DESIGN.md 11.3). Ohne Beteiligung nur, wenn es offen ist (der Server antwortet sonst 404). */
export const load: PageLoad = async ({ parent, fetch, url, params, depends }) => {
  const { me } = await parent();
  const m = requireSession(me, url);
  depends(`api:stream:giveaway:${params.id}`);
  const detail = await loadOrRedirect(apiOf(fetch).get<PortalDetail>(`/api/portal/giveaways/${params.id}`), url);
  return { me: m, detail };
};
