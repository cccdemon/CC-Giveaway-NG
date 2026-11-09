import { apiOf, loadOrRedirect } from '#lib/api/client.js';
import type { TeamDetail } from '#lib/api/types.js';
import { requireStreamer } from '#lib/guard.js';
import type { PageLoad } from './$types';

/** Team-Detail (NEW_DESIGN.md 9.3): Mitglieder, Einladungen, Sperren, verlassen, deaktivieren. Nur Mitglieder. */
export const load: PageLoad = async ({ parent, fetch, url, params, depends }) => {
  const { me } = await parent();
  const m = requireStreamer(me, url);
  depends(`api:stream:team:${params.id}`);
  const team = await loadOrRedirect(apiOf(fetch).get<TeamDetail>(`/api/teams/${params.id}`), url);
  return { me: m, team };
};
