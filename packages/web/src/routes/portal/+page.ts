import { apiOf, loadOrRedirect } from '#lib/api/client.js';
import type { PortalTile } from '#lib/api/types.js';
import { requireSession } from '#lib/guard.js';
import type { PageLoad } from './$types';

/** Teilnehmer-Portal (NEW_DESIGN.md 11.3): eigene Giveaways, laufend und vergangen. Nur Sitzung nötig. */
export const load: PageLoad = async ({ parent, fetch, url, depends }) => {
  const { me } = await parent();
  const m = requireSession(me, url);
  depends('api:portal');
  const tiles = await loadOrRedirect(apiOf(fetch).get<PortalTile[]>('/api/portal/giveaways'), url);
  for (const t of tiles) depends(`api:stream:giveaway:${t.id}`);
  return { me: m, tiles };
};
