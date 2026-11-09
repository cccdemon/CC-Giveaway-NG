import { apiOf, loadOrRedirect } from '#lib/api/client.js';
import type { Terms } from '#lib/api/types.js';
import type { PageLoad } from './$types';

/** Fassungen der Nutzungsbedingungen (NEW_DESIGN.md 9.2): aktuelle zeigen, neue veröffentlichen. */
export const load: PageLoad = async ({ fetch, url, depends }) => {
  depends('api:terms');
  const terms = await loadOrRedirect(apiOf(fetch).get<Terms>('/api/terms'), url);
  return { terms };
};
