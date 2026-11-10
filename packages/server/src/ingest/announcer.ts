// Chat-Ansagen (NEW_DESIGN.md 10.3): der Ingest hört die veröffentlichten Ereignisse, plant je Giveaway-Ereignis eine Ansage
// und sendet sie in jeden eigenen Kanal des Giveaways. Jede Sendung wird als announcement_sent gemeldet, ohne Text.
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { BusLogger } from '../framework/command-bus.js';
import { planAnnouncement, type AnnouncementSettings } from '../framework/giveaway/announcements.js';
import type { Runtime } from '../framework/runtime.js';
import type { Subscriber } from '../framework/subscriber.js';
import type { EventRecord, StreamId } from '../journal/types.js';
import type { ChannelRef, IngestAdapter, SendResult } from './signals.js';

export interface AnnouncerOptions {
  pool: pg.Pool;
  rt: Runtime;
  adapter: IngestAdapter;
  directory: { current(): ChannelRef[] };
  publicUrl: string;
  log: BusLogger;
  now?: () => Date;
}

export interface AnnounceResult {
  sent: number;
  failed: number;
  skipped: number;
}

/** Fehlercode im Nachweis, wenn der Adapter wirft statt ein Ergebnis zu liefern. */
export const SEND_FAILED = 'send_failed';
/** Gemerkte Sendungen je Ereignis und Kanal, damit ein doppelt zugestelltes Bündel nicht doppelt sendet (Festlegung 4). */
export const SEEN_MAX = 5_000;

const STREAM_PREFIX = 'giveaway:';

interface GiveawayRow {
  prize: string;
  keyword: string | null;
  claim_days: number;
  channels: string[];
  announcements: AnnouncementSettings;
  kernel: string;
  status: string;
}

const none = (): AnnounceResult => ({ sent: 0, failed: 0, skipped: 0 });

export class Announcer {
  private readonly seen = new Set<string>();
  private chain: Promise<void> = Promise.resolve();
  private readonly now: () => Date;

  constructor(private readonly o: AnnouncerOptions) {
    this.now = o.now ?? (() => new Date());
  }

  /** Hört alle Ströme; Bündel laufen nacheinander, damit das Merken je Ereignis und Kanal hält. */
  attach(subscriber: Subscriber): () => void {
    return subscriber.subscribeAll((stream, events) => {
      this.chain = this.chain.then(() => this.handle(stream, events)).then(
        () => undefined,
        (err: unknown) => this.o.log.error({ err, stream }, 'Ansagen zu einem Ereignisbündel sind fehlgeschlagen. Das nächste Bündel läuft wie geplant.'),
      );
    });
  }

  /** Wartet, bis alle angenommenen Bündel verarbeitet sind (Tests, Stopp). */
  async idle(): Promise<void> {
    await this.chain;
  }

  /** Ein Bündel Ereignisse eines Stroms: plant, sendet je eigenem Kanal, meldet. Wirft nie. */
  async handle(stream: StreamId, events: EventRecord[]): Promise<AnnounceResult> {
    const result = none();
    if (!stream.startsWith(STREAM_PREFIX) || events.length === 0) return result;
    const giveawayId = stream.slice(STREAM_PREFIX.length);
    const owned = this.o.directory.current().filter((c) => c.owned);
    if (owned.length === 0) return result;
    const row = await this.loadRow(giveawayId);
    if (row === null || !this.o.rt.kernels.has(row.kernel)) return result;
    const channels = owned.filter((c) => row.channels.includes(c.pid));
    if (channels.length === 0) return result;
    const giveaway = {
      id: giveawayId, prize: row.prize, keyword: row.keyword, claimDays: row.claim_days, announcements: row.announcements,
      kernel: this.o.rt.kernels.get(row.kernel), publicUrl: this.o.publicUrl,
    };
    const names = await this.namesFor(events);
    for (const event of events) {
      const plan = planAnnouncement(event, giveaway, names);
      if (plan === null) continue;
      for (const channel of channels) {
        const key = `${event.id}:${channel.pid}`;
        if (this.seen.has(key)) {
          result.skipped++;
          continue;
        }
        this.remember(key);
        const sent = await this.send(channel, plan.text, giveawayId);
        if (sent.ok) result.sent++;
        else result.failed++;
        await this.record(giveawayId, plan.kind, channel.pid, event.id, sent);
      }
    }
    return result;
  }

  private async send(channel: ChannelRef, text: string, giveawayId: string): Promise<SendResult> {
    try {
      return await this.o.adapter.sendChat(channel, text);
    } catch (err) {
      this.o.log.error({ err, giveawayId, channel: channel.pid }, 'Eine Ansage ließ sich nicht senden. Der Nachweis trägt den Fehler.');
      return { ok: false, reason: SEND_FAILED };
    }
  }

  private async record(giveawayId: string, kind: string, channel: ChannelRef['pid'], triggerEventId: string, sent: SendResult): Promise<void> {
    try {
      const r = await this.o.rt.bus.execute(
        this.o.rt.handlers.recordAnnouncement,
        { giveawayId, kind, channel, triggerEventId, ok: sent.ok, ...(sent.ok ? { messageId: sent.messageId } : { error: sent.reason }) },
        { actor: 'system:ingest', correlationId: randomUUID(), now: this.now() },
      );
      if (!r.ok) this.o.log.error({ giveawayId, kind, channel, code: r.rejection.code }, 'Der Nachweis einer Ansage wurde abgelehnt. Die Ansage ist gesendet.');
    } catch (err) {
      this.o.log.error({ err, giveawayId, kind, channel }, 'Der Nachweis einer Ansage ist fehlgeschlagen. Die Ansage ist gesendet.');
    }
  }

  private remember(key: string): void {
    this.seen.add(key);
    if (this.seen.size <= SEEN_MAX) return;
    const oldest = this.seen.values().next().value;
    if (oldest !== undefined) this.seen.delete(oldest);
  }

  private async loadRow(giveawayId: string): Promise<GiveawayRow | null> {
    const r = await this.o.pool.query<GiveawayRow>(
      'SELECT prize, keyword, claim_days, channels, announcements, kernel, status FROM giveaways WHERE id = $1',
      [giveawayId],
    );
    return r.rows[0] ?? null;
  }

  /** Anzeigenamen der Gewinner aus den Payloads (nur giveaway_drawn trägt winners). Namen bleiben außerhalb des Journals. */
  private async namesFor(events: EventRecord[]): Promise<Record<string, string>> {
    const pids = new Set<string>();
    for (const e of events) {
      const winners = (e.payload as { winners?: unknown } | null)?.winners;
      if (Array.isArray(winners)) for (const w of winners) if (typeof w === 'string') pids.add(w);
    }
    if (pids.size === 0) return {};
    const r = await this.o.pool.query<{ pid: string; display_name: string }>('SELECT pid, display_name FROM identities WHERE pid = ANY($1::uuid[])', [[...pids]]);
    return Object.fromEntries(r.rows.map((x) => [x.pid, x.display_name]));
  }
}
