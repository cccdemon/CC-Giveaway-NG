import { apiOf, loadOrRedirect } from '#lib/api/client.js';
import type { TeamList } from '#lib/api/types.js';
import { requireStreamer } from '#lib/guard.js';
import type { PageLoad } from './$types';

/** Teams (NEW_DESIGN.md 9.3): Solo-Team und echte Teams, gründen. */
export const load: PageLoad = async ({ parent, fetch, url, depends }) => {
  const { me } = await parent();
  const m = requireStreamer(me, url);
  depends('api:teams');
  const teams = await loadOrRedirect(apiOf(fetch).get<TeamList>('/api/me/teams'), url);
  return { me: m, teams };
};
