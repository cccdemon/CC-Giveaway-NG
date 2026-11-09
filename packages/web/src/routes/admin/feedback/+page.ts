import { apiOf, loadOrRedirect } from '#lib/api/client.js';
import type { FeedbackRow } from '#lib/api/types.js';
import type { PageLoad } from './$types';

/** Rückmeldungen (NEW_DESIGN.md 11.4): offen oder erledigt (?done=true). */
export const load: PageLoad = async ({ fetch, url, depends }) => {
  depends('api:admin:feedback');
  const done = url.searchParams.get('done') === 'true';
  const rows = await loadOrRedirect(apiOf(fetch).get<FeedbackRow[]>(`/api/admin/feedback?done=${done}`), url);
  return { done, rows };
};
