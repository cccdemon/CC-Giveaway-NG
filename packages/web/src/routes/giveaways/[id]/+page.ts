import { apiOf, loadOrRedirect } from '#lib/api/client.js';
import type { GiveawayDetail, HistoryPage, ParticipantView } from '#lib/api/types.js';
import { requireStreamer } from '#lib/guard.js';
import { HISTORY_PREVIEW } from '#lib/history-limits.js';
import type { PageLoad } from './$types';

/** Giveaway-Detail (NEW_DESIGN.md 11.1): Detail, Teilnehmer und die neuesten Verlaufseinträge parallel. Live über den Strom. */
export const load: PageLoad = async ({ parent, fetch, url, params, depends }) => {
  const { me } = await parent();
  const m = requireStreamer(me, url);
  depends(`api:stream:giveaway:${params.id}`);
  const api = apiOf(fetch);
  const base = `/api/giveaways/${params.id}`;
  const [detail, participants, history] = await loadOrRedirect(
    Promise.all([api.get<GiveawayDetail>(base), api.get<ParticipantView[]>(`${base}/participants`), api.get<HistoryPage>(`${base}/history?limit=${HISTORY_PREVIEW}`)]),
    url,
  );
  // Kanäle für die Einstellungen lädt die Seite erst, wenn das Panel aufgeht (sonst ein Team-Aufruf je Live-Ereignis).
  return { me: m, detail, participants, history };
};
