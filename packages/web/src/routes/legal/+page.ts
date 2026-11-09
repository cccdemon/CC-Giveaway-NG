import { requireStreamer } from '#lib/guard.js';
import type { PageLoad } from './$types';

/** Rechtstexte im Profil (NEW_DESIGN.md 9.4): gelten für jedes Giveaway ohne eigene Texte. */
export const load: PageLoad = async ({ parent, url }) => {
  const { me } = await parent();
  return { me: requireStreamer(me, url) };
};
