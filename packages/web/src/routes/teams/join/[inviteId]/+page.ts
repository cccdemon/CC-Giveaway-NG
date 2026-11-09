import { apiOf, loadOrRedirect } from '#lib/api/client.js';
import type { InviteInfo } from '#lib/api/types.js';
import type { PageLoad } from './$types';

/** Einladungsseite (NEW_DESIGN.md 9.3): ohne Sitzung Name und Gültigkeit, mit Sitzung Beitreten. */
export const load: PageLoad = async ({ parent, fetch, url, params }) => {
  const { me } = await parent();
  const invite = await loadOrRedirect(apiOf(fetch).get<InviteInfo>(`/api/teams/join/${params.inviteId}`), url);
  return { me, invite, inviteId: params.inviteId };
};
