import { apiOf, loadOrRedirect } from '#lib/api/client.js';
import type { ChannelStatus, TeamList, Tile } from '#lib/api/types.js';
import { requireStreamer } from '#lib/guard.js';
import type { PageLoad } from './$types';

/** Übersicht (NEW_DESIGN.md 11.1): Kacheln aller Giveaways der eigenen Teams, eigener Kanal, Teams. */
export const load: PageLoad = async ({ parent, fetch, url, depends }) => {
  const { me } = await parent();
  requireStreamer(me, url);
  depends('api:giveaways', 'api:channel');
  const api = apiOf(fetch);
  const [tiles, channel, teams] = await loadOrRedirect(
    Promise.all([api.get<Tile[]>('/api/giveaways'), api.get<ChannelStatus>('/api/me/channel'), api.get<TeamList>('/api/me/teams')]),
    url,
  );
  for (const t of tiles) depends(`api:stream:giveaway:${t.id}`);
  return { tiles, channel, teams };
};
