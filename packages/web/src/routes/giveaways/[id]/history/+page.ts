import { apiOf, loadOrRedirect } from '#lib/api/client.js';
import type { GiveawayDetail, HistoryPage } from '#lib/api/types.js';
import { requireStreamer } from '#lib/guard.js';
import { HISTORY_PAGE } from '#lib/history-limits.js';
import type { PageLoad } from './$types';

/** Ganzer Verlauf, seitenweise (NEW_DESIGN.md 5.3). */
export const load: PageLoad = async ({ parent, fetch, url, params, depends }) => {
  const { me } = await parent();
  const m = requireStreamer(me, url);
  depends(`api:stream:giveaway:${params.id}`);
  const api = apiOf(fetch);
  const base = `/api/giveaways/${params.id}`;
  const [detail, history] = await loadOrRedirect(Promise.all([api.get<GiveawayDetail>(base), api.get<HistoryPage>(`${base}/history?limit=${HISTORY_PAGE}`)]), url);
  return { me: m, detail, history };
};
