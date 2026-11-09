import { apiOf, loadOrRedirect } from '#lib/api/client.js';
import type { ChannelStatus } from '#lib/api/types.js';
import { requireStreamer } from '#lib/guard.js';
import type { PageLoad } from './$types';

/** Eigener Kanal (NEW_DESIGN.md 9.2 Schritt 2, 11.2): verbinden, Statusblock, trennen. */
export const load: PageLoad = async ({ parent, fetch, url, depends }) => {
  const { me } = await parent();
  const m = requireStreamer(me, url);
  depends('api:channel');
  const channel = await loadOrRedirect(apiOf(fetch).get<ChannelStatus>('/api/me/channel'), url);
  return { me: m, channel };
};
