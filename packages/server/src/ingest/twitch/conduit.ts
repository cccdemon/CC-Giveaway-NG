// Ein Conduit je Plattform, ein Shard je Worker (NEW_DESIGN.md 10.2). Worker 0 legt es an, die anderen warten darauf.
import type { ChannelRef } from '../signals.js';
import type { HelixClient } from './helix.js';

export const CONDUIT_WAIT_MS = 2_000;
export const CONDUIT_ATTEMPTS = 30;

export async function ensureConduit(
  helix: HelixClient,
  o: { workers: number; index: number; sleep: (ms: number) => Promise<void>; attempts?: number },
): Promise<string> {
  if (o.index === 0) {
    const first = (await helix.listConduits())[0];
    if (!first) return (await helix.createConduit(o.workers)).id;
    if (first.shardCount !== o.workers) await helix.updateConduit(first.id, o.workers);
    return first.id;
  }
  const attempts = o.attempts ?? CONDUIT_ATTEMPTS;
  for (let i = 0; i < attempts; i++) {
    const found = (await helix.listConduits()).find((c) => c.shardCount >= o.workers);
    if (found) return found.id;
    if (i + 1 < attempts) await o.sleep(CONDUIT_WAIT_MS);
  }
  throw new Error('Kein Conduit. Starte Worker 0 zuerst.');
}

/** state: Live-Status. full: dazu Chat über den Bot und Follows. Ein vorhandenes Abonnement ist kein Fehler. */
export async function subscribeChannel(helix: HelixClient, conduitId: string, ref: ChannelRef, botUserId: string): Promise<void> {
  const b = ref.twitchId;
  await helix.subscribe('stream.online', '1', { broadcaster_user_id: b }, conduitId);
  await helix.subscribe('stream.offline', '1', { broadcaster_user_id: b }, conduitId);
  if (ref.watch !== 'full') return;
  await helix.subscribe('channel.chat.message', '1', { broadcaster_user_id: b, user_id: botUserId }, conduitId);
  await helix.subscribe('channel.follow', '2', { broadcaster_user_id: b, moderator_user_id: b }, conduitId);
}
