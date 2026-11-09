import { apiOf, loadOrRedirect } from '#lib/api/client.js';
import type { OpsView } from '#lib/api/types.js';
import type { PageLoad } from './$types';

/** Betrieb (NEW_DESIGN.md 11.4): Health, Ingest je Kanal, abgelehnte Befehle, Browser-Fehler. */
export const load: PageLoad = async ({ fetch, url, depends }) => {
  depends('api:admin:ops');
  const ops = await loadOrRedirect(apiOf(fetch).get<OpsView>('/api/admin/ops'), url);
  return { ops };
};
