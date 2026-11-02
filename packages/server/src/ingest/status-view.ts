// Statusblock je Kanal (NEW_DESIGN.md 11.2): Lesesicht über accounts, channel_tokens und channel_status plus Warnung.
import type { Queryable } from '../db/pool.js';
import type { Pid } from '../kernel-api/index.js';

export type ChannelWarning = { level: 'rot' | 'gelb' | 'hinweis'; text: string } | null;

export interface ChannelStatusView {
  pid: Pid;
  connected: boolean;
  tokenStatus: 'ok' | 'invalid' | 'none';
  live: boolean;
  liveSince: string | null;
  viewers: number | null;
  chatters: number | null;
  /** Chatters ÷ Zuschauer, nur Diagnose. */
  coverage: number | null;
  lastSignalAt: string | null;
  problem: string | null;
  warning: ChannelWarning;
}

import { SIGNAL_STALE_MS } from './channel-status.js';
export { SIGNAL_STALE_MS };
export const COVERAGE_MIN = 0.5;

const RECONNECT_TOKEN = 'Kanal neu verbinden. Das Twitch-Token ist abgelaufen oder ein Recht fehlt.';
const RECONNECT_SILENT = 'Kanal neu verbinden. Seit über 2 Minuten kommt kein Signal.';
const TWITCH_ERROR = 'Twitch antwortet nicht. Der Ingest versucht es weiter.';
const LOW_COVERAGE = 'Abdeckung unter 50 %. Twitch meldet nicht alle Zuschauer im Chat.';

export function channelWarning(
  v: Pick<ChannelStatusView, 'connected' | 'tokenStatus' | 'live' | 'lastSignalAt' | 'coverage' | 'problem'>,
  now: Date,
): ChannelWarning {
  if (!v.connected) return null;
  if (v.tokenStatus !== 'ok') return { level: 'rot', text: RECONNECT_TOKEN };
  if (v.live && (v.lastSignalAt === null || now.getTime() - Date.parse(v.lastSignalAt) > SIGNAL_STALE_MS)) return { level: 'gelb', text: RECONNECT_SILENT };
  if (v.problem === 'twitch_error') return { level: 'gelb', text: TWITCH_ERROR };
  if (v.coverage !== null && v.coverage < COVERAGE_MIN) return { level: 'hinweis', text: LOW_COVERAGE };
  return null;
}

interface Row {
  pid: string;
  connected: boolean | null;
  token_status: 'ok' | 'invalid' | null;
  live: boolean | null;
  live_since: Date | null;
  viewers: number | null;
  chatters: number | null;
  last_signal_at: Date | null;
  problem: string | null;
}

export async function channelStatusView(db: Queryable, pids: Pid[], now: Date): Promise<ChannelStatusView[]> {
  if (pids.length === 0) return [];
  const r = await db.query<Row>(
    `SELECT p.pid, (a.channel_connected AND NOT a.deleted) AS connected, t.status AS token_status,
            s.live, s.live_since, s.viewers, s.chatters, s.last_signal_at, s.problem
       FROM unnest($1::uuid[]) WITH ORDINALITY AS p (pid, n)
       LEFT JOIN accounts a ON a.pid = p.pid
       LEFT JOIN channel_tokens t ON t.pid = p.pid
       LEFT JOIN channel_status s ON s.pid = p.pid
      ORDER BY p.n`,
    [pids],
  );
  return r.rows.map((x) => {
    const coverage = x.viewers !== null && x.chatters !== null && x.viewers > 0 && x.chatters > 0 ? x.chatters / x.viewers : null;
    const base: Omit<ChannelStatusView, 'warning'> = {
      pid: x.pid,
      connected: x.connected === true,
      tokenStatus: x.token_status ?? 'none',
      live: x.live === true,
      liveSince: x.live_since?.toISOString() ?? null,
      viewers: x.viewers,
      chatters: x.chatters,
      coverage,
      lastSignalAt: x.last_signal_at?.toISOString() ?? null,
      problem: x.problem,
    };
    return { ...base, warning: channelWarning(base, now) };
  });
}
