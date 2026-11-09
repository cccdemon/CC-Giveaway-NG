import { apiOf, loadOrRedirect } from '#lib/api/client.js';
import type { AdminStreamer } from '#lib/api/types.js';
import type { PageLoad } from './$types';

/** Streamer suchen, sperren, verwarnen (NEW_DESIGN.md 11.4). Suchbegriff in der URL (?q=). */
export const load: PageLoad = async ({ parent, fetch, url, depends }) => {
  const { me } = await parent();
  depends('api:admin:streamers');
  const q = url.searchParams.get('q') ?? '';
  const streamers = await loadOrRedirect(apiOf(fetch).get<AdminStreamer[]>(`/api/admin/streamers?q=${encodeURIComponent(q)}`), url);
  return { me, q, streamers };
};
