import { requireAdmin } from '#lib/guard.js';
import type { LayoutLoad } from './$types';

/** Verwaltung (NEW_DESIGN.md 11.4): nur Superadmins. */
export const load: LayoutLoad = async ({ parent, url }) => {
  const { me } = await parent();
  return { me: requireAdmin(me, url) };
};
