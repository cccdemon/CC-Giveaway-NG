// IdentityResolver des Rahmens auf Basis von identities (NEW_DESIGN.md 9.1).
import type { IdentityResolver } from '../framework/giveaway/signals.js';
import { findPidsByTwitchIds, touchIdentities } from './identities.js';

export function identityResolver(): IdentityResolver {
  return {
    resolve: (c, twitchIds) => findPidsByTwitchIds(c, twitchIds),
    touch: async (c, pids, now) => {
      await touchIdentities(c, pids, now);
    },
  };
}
