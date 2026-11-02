// Bedingungsprüfer über Helix (NEW_DESIGN.md 6.5, 7.2): Follows mit dem Token des Streamers, Kontoalter per Get Users.
// Holt nur, was die Bedingungen brauchen. Kann er etwas nicht holen, wirft er GateCheckError und die Ziehung bricht ab.
import type { Queryable } from '../../db/pool.js';
import { GateCheckError, evaluateGates, type GateChecker, type GateConfig, type GateFacts, type GateResult } from '../../framework/giveaway/gates.js';
import { findTwitchIdsByPids } from '../../identity/identities.js';
import type { Pid } from '../../kernel-api/index.js';
import { HelixError, type HelixClient } from './helix.js';
import type { ChannelTokenProvider } from './tokens.js';

const PARALLEL = 10;

const TOKEN_INVALID = (): GateCheckError => new GateCheckError('token_invalid', 'Ein Kanal des Giveaways ist nicht verbunden. Verbinde ihn neu, dann ziehe.');
const UNREACHABLE = (): GateCheckError => new GateCheckError('twitch_unreachable', 'Twitch antwortet nicht. Versuche die Ziehung später erneut.');

/** Kanäle, deren Follows die Bedingungen brauchen. */
function followChannels(gates: GateConfig[], channels: Pid[]): Pid[] {
  const follow = gates.find((g): g is Extract<GateConfig, { id: 'follow' }> => g.id === 'follow');
  const needsAge = gates.some((g) => g.id === 'follow_age');
  if (!follow && !needsAge) return [];
  if (follow?.mode === 'channel' && follow.channel !== undefined) return [follow.channel];
  return channels;
}

export function helixGateChecker(o: { helix: HelixClient; tokens: ChannelTokenProvider }): GateChecker {
  async function followsOf(channel: Pid, channelTwitchId: string, users: { pid: Pid; twitchId: string }[]): Promise<Map<Pid, string | null>> {
    const token = await o.tokens.accessTokenFor(channel);
    if (token === null) throw TOKEN_INVALID();
    const out = new Map<Pid, string | null>();
    for (let i = 0; i < users.length; i += PARALLEL) {
      const results = await Promise.all(
        users.slice(i, i + PARALLEL).map(async (u) => {
          try {
            return [u.pid, (await o.helix.isFollower(channelTwitchId, u.twitchId, token)).since] as const;
          } catch (e) {
            if (e instanceof HelixError && e.code === 'helix_unauthorized') {
              await o.tokens.invalidate(channel).catch(() => undefined);
              throw TOKEN_INVALID();
            }
            throw e instanceof HelixError ? UNREACHABLE() : e;
          }
        }),
      );
      for (const [pid, since] of results) out.set(pid, since);
    }
    return out;
  }

  return {
    async check(db: Queryable, input): Promise<GateResult[]> {
      const { channels, gates, pids, seen, now } = input;
      if (gates.length === 0) return pids.map((pid) => ({ pid, ok: true, reasons: [] }));
      const ids = await findTwitchIdsByPids(db, [...new Set([...pids, ...channels])]);
      const users = pids.flatMap((pid) => (ids.has(pid) ? [{ pid, twitchId: ids.get(pid)! }] : []));

      const follows = new Map<Pid, Map<Pid, string | null>>();
      for (const channel of followChannels(gates, channels)) {
        const channelTwitchId = ids.get(channel);
        if (channelTwitchId === undefined) throw TOKEN_INVALID();
        follows.set(channel, await followsOf(channel, channelTwitchId, users));
      }

      const createdAt = new Map<string, string>();
      if (gates.some((g) => g.id === 'account_age') && users.length > 0) {
        try {
          for (const u of await o.helix.getUsers(users.map((u) => u.twitchId))) createdAt.set(u.id, u.createdAt);
        } catch (e) {
          throw e instanceof HelixError ? UNREACHABLE() : e;
        }
      }

      return pids.map((pid) => {
        const twitchId = ids.get(pid);
        if (twitchId === undefined) return { pid, ok: false, reasons: ['identity_deleted'] };
        const facts: GateFacts = {
          follows: Object.fromEntries([...follows].map(([channel, m]) => [channel, m.get(pid) ?? null])),
          accountCreatedAt: createdAt.get(twitchId) ?? null,
          seenChannels: seen[pid] ?? [],
        };
        return { pid, ...evaluateGates(gates, channels, facts, now) };
      });
    },
  };
}
