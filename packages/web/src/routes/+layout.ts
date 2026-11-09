import { ApiError, apiOf } from '#lib/api/client.js';
import type { Me } from '#lib/api/types.js';
import type { LayoutLoad } from './$types';

/** Die eigene Person für Kopfbereich und Rechte. Ohne Sitzung null, dann zeigen die Seiten die Anmeldung. */
export const load: LayoutLoad = async ({ fetch, depends }) => {
  depends('api:me');
  try {
    const me = await apiOf(fetch).get<Me>('/api/me');
    return { me };
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return { me: null as Me | null };
    throw e;
  }
};
