// Twitch-Adapter (NEW_DESIGN.md 10.2): EventSub über Conduit-Shard für Chat, Follow und Live-Status, Helix Get Streams
// und Get Chatters je Minute für die eigenen (owned) Kanäle. Keine eigene Schleife: der Worker ruft pollPresence.
import type { BusLogger } from '../../framework/command-bus.js';
import type { Pid } from '../../kernel-api/index.js';
import { minuteOf } from '../bundler.js';
import type { AdapterHealth, ChannelRef, FollowResult, IngestAdapter, SendResult, Signal } from '../signals.js';
import { ensureConduit, subscribeChannel } from './conduit.js';
import { toSignal, type EventSubMessage, type EventSubSocket } from './eventsub.js';
import { HelixError, type HelixClient } from './helix.js';
import type { ChannelTokenProvider } from './tokens.js';

export const PRESENCE_INTERVAL_MS = 60_000;
const PARALLEL_CHANNELS = 20;

export interface TwitchAdapterOptions {
  helix: HelixClient;
  tokens: ChannelTokenProvider;
  botUserId: string;
  workers: number;
  index: number;
  socket: (o: { onSession: (id: string) => Promise<void>; onMessage: (m: EventSubMessage) => void }) => Pick<EventSubSocket, 'start' | 'close'>;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
  log: BusLogger;
}

interface Channel {
  ref: ChannelRef;
  live: boolean;
  problem: string | null;
  lastSignalAt: string | null;
  /** Beobachtungsstufe, für die Abonnements bei Twitch liegen. */
  subscribed: 'state' | 'full' | null;
}

export interface TwitchAdapter extends IngestAdapter {
  pollPresence(now: Date): Promise<void>;
  /** Wartet auf laufende Hintergrund-Abonnements. Für Tests und das Herunterfahren. */
  settled(): Promise<void>;
}

export function twitchAdapter(o: TwitchAdapterOptions): TwitchAdapter {
  const byPid = new Map<Pid, Channel>();
  const byTwitchId = new Map<string, Channel>();
  let handler: (s: Signal) => void = () => {};
  let socket: Pick<EventSubSocket, 'start' | 'close'> | null = null;
  let conduitId: string | null = null;
  let subscribing: Promise<void> | null = null;

  const emit = (ch: Channel, s: Signal): void => {
    ch.lastSignalAt = o.now().toISOString();
    if (s.kind === 'stream_state') ch.live = s.live;
    handler(s);
  };

  /** Nach jeder Sitzung (auch Reconnect) nur den Shard binden. Twitch gibt dafür etwa 10 s. */
  const onSession = async (sessionId: string): Promise<void> => {
    if (conduitId === null) throw new Error('Kein Conduit. start() legt es vor der Verbindung an.');
    await o.helix.bindShard(conduitId, o.index, sessionId);
  };

  const onMessage = (m: EventSubMessage): void => {
    if (m.type === 'notification') {
      const s = toSignal(m, (id) => byTwitchId.get(id)?.ref, o.botUserId, o.now);
      if (!s) return;
      const ch = byPid.get(s.channel);
      if (ch) emit(ch, s);
      return;
    }
    if (m.type === 'revocation') {
      const ch = m.broadcasterId === null ? undefined : byTwitchId.get(m.broadcasterId);
      o.log.error({ subscriptionType: m.subscriptionType, status: m.status, channel: ch?.ref.pid ?? null }, 'Twitch hat ein Abonnement widerrufen. Der Streamer muss den Kanal neu verbinden.');
      if (ch) ch.problem = 'revoked';
    }
  };

  async function subscribeOne(ch: Channel): Promise<void> {
    if (conduitId === null) return;
    const watch = ch.ref.watch;
    try {
      await subscribeChannel(o.helix, conduitId, ch.ref, o.botUserId);
      ch.subscribed = watch;
    } catch (err) {
      ch.problem = 'twitch_error';
      o.log.error({ err, channel: ch.ref.pid }, 'Die EventSub-Abonnements eines Kanals ließen sich nicht anlegen. Nächster Versuch beim nächsten Verzeichnislauf.');
    }
  }

  /** Abonniert in Gruppen, läuft im Hintergrund. Ein zweiter Aufruf hängt sich hinter den laufenden. */
  function subscribeOwned(): void {
    const run = async () => {
      const due = owned().filter((ch) => ch.subscribed !== ch.ref.watch);
      for (let i = 0; i < due.length; i += PARALLEL_CHANNELS) {
        await Promise.all(due.slice(i, i + PARALLEL_CHANNELS).map(subscribeOne));
      }
    };
    const previous = subscribing ?? Promise.resolve();
    const next: Promise<void> = previous.then(run).finally(() => {
      if (subscribing === next) subscribing = null;
    });
    subscribing = next;
  }

  const owned = (): Channel[] => [...byPid.values()].filter((ch) => ch.ref.owned);

  async function pollChatters(ch: Channel, minute: string): Promise<void> {
    try {
      const token = await o.tokens.accessTokenFor(ch.ref.pid);
      if (token === null) {
        ch.problem = 'token_invalid';
        return;
      }
      const users = await o.helix.getChatters(ch.ref.twitchId, token);
      ch.problem = null;
      emit(ch, { kind: 'presence', channel: ch.ref.pid, minute, users });
    } catch (err) {
      if (err instanceof HelixError && err.code === 'helix_unauthorized') {
        await o.tokens.invalidate(ch.ref.pid).catch(() => undefined);
        ch.problem = 'token_invalid';
      } else {
        ch.problem = 'twitch_error';
      }
      o.log.error({ err, channel: ch.ref.pid }, 'Die Anwesenheitsliste eines Kanals ließ sich nicht holen. Diese Minute fehlt.');
    }
  }

  return {
    async start(channels) {
      for (const ref of channels) {
        const old = byPid.get(ref.pid);
        if (old) byTwitchId.delete(old.ref.twitchId);
        const ch: Channel = old ? { ...old, ref } : { ref, live: false, problem: null, lastSignalAt: null, subscribed: null };
        if (old && old.ref.twitchId !== ref.twitchId) ch.subscribed = null;
        byPid.set(ref.pid, ch);
        byTwitchId.set(ref.twitchId, ch);
      }
      if (socket === null) {
        // Reihenfolge zählt: Conduit vor der Verbindung, damit onSession den Shard sofort binden kann.
        conduitId ??= await ensureConduit(o.helix, { workers: o.workers, index: o.index, sleep: o.sleep });
        socket = o.socket({ onSession, onMessage });
        await socket.start();
      }
      subscribeOwned();
    },

    async stop(channel) {
      const ch = byPid.get(channel.pid);
      if (!ch) return;
      byPid.delete(channel.pid);
      byTwitchId.delete(ch.ref.twitchId);
    },

    onSignal(h) {
      handler = h;
    },

    async settled() {
      while (subscribing !== null) await subscribing;
    },

    async pollPresence(now) {
      const list = owned();
      if (list.length === 0) return;
      let streams: Awaited<ReturnType<HelixClient['getStreams']>>;
      try {
        streams = await o.helix.getStreams(list.map((ch) => ch.ref.twitchId));
      } catch (err) {
        for (const ch of list) ch.problem = 'twitch_error';
        o.log.error({ err }, 'Der Live-Status der Kanäle ließ sich nicht holen. Nächster Versuch in einer Minute.');
        return;
      }
      const at = now.toISOString();
      const minute = minuteOf(now);
      for (const ch of list) {
        if (ch.problem === 'twitch_error') ch.problem = null;
        const info = streams.find((s) => s.userId === ch.ref.twitchId);
        emit(ch, info ? { kind: 'stream_state', channel: ch.ref.pid, at, live: true, viewers: info.viewers } : { kind: 'stream_state', channel: ch.ref.pid, at, live: false });
      }
      const due = list.filter((ch) => ch.ref.watch === 'full' && ch.live);
      for (let i = 0; i < due.length; i += PARALLEL_CHANNELS) {
        await Promise.allSettled(due.slice(i, i + PARALLEL_CHANNELS).map((ch) => pollChatters(ch, minute)));
      }
    },

    async sendChat(channel, text): Promise<SendResult> {
      try {
        return await o.helix.sendChatMessage(channel.twitchId, o.botUserId, text);
      } catch (err) {
        o.log.error({ err, channel: channel.pid }, 'Die Chat-Nachricht ließ sich nicht senden.');
        return { ok: false, reason: err instanceof HelixError ? err.code : 'send_failed', detail: err instanceof Error ? err.message : String(err) };
      }
    },

    async checkFollows(channel, userIds): Promise<FollowResult[]> {
      const token = await o.tokens.accessTokenFor(channel.pid);
      if (token === null) {
        const ch = byPid.get(channel.pid);
        if (ch) ch.problem = 'token_invalid';
        return userIds.map((userId) => ({ userId, follows: false, since: null }));
      }
      const out: FollowResult[] = [];
      for (const userId of userIds) out.push(await o.helix.isFollower(channel.twitchId, userId, token));
      return out;
    },

    health(): AdapterHealth[] {
      return owned().map((ch) => ({ channel: ch.ref.pid, ok: ch.problem === null, lastSignalAt: ch.lastSignalAt, problem: ch.problem }));
    },

    async close() {
      await socket?.close();
      socket = null;
      byPid.clear();
      byTwitchId.clear();
    },
  };
}
