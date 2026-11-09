// Zugang zu Seiten: Sitzung Pflicht, für Streamer-Seiten zusätzlich die angenommenen Nutzungsbedingungen (NEW_DESIGN.md 9.2),
// für die Verwaltung das Admin-Recht (11.4).
import { error, redirect } from '@sveltejs/kit';
import { returnTo } from './api/client.js';
import type { Me } from './api/types.js';
import { S } from './texts/sentences.js';

type UrlLike = { pathname: string; search: string };

export function requireSession(me: Me | null, url: UrlLike): Me {
  if (!me) redirect(303, `/?return=${encodeURIComponent(returnTo(url))}`);
  return me;
}

export function requireStreamer(me: Me | null, url: UrlLike): Me {
  const m = requireSession(me, url);
  if (m.termsVersion < m.currentTermsVersion) redirect(303, `/terms?return=${encodeURIComponent(returnTo(url))}`);
  return m;
}

export function requireAdmin(me: Me | null, url: UrlLike): Me {
  const m = requireSession(me, url);
  if (!m.admin) error(403, S.admin.forbidden);
  return m;
}
