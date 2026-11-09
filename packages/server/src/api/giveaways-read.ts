// Lesesichten für die Streamer-App (NEW_DESIGN.md 11.1, 11.2): Detail per Zustand (Snapshot + Replay), Teilnehmer aus der
// Lesetabelle plus Kern-Sicht, Verlauf seitenweise mit Umkehrart und Umkehrstatus. Namen nur über identities.
import type pg from 'pg';
import type { Queryable } from '../db/pool.js';
import { pidOfActor } from '../framework/authorize.js';
import { loadGiveawayRow, type GiveawayRow } from '../framework/giveaway/authorize.js';
import { giveawayStream, type GiveawayState, type WinnerStatus } from '../framework/giveaway/state.js';
import type { Runtime } from '../framework/runtime.js';
import { loadStreamState } from '../framework/state.js';
import { displayNamesOf, displayNameOf } from '../identity/identities.js';
import { channelStatusView, type ChannelStatusView } from '../ingest/status-view.js';
import { readEvent, readStreamPage, revertedIds } from '../journal/journal.js';
import type { EventTypeRegistry } from '../journal/event-types.js';
import type { EventRecord, StreamId } from '../journal/types.js';
import type { AnyKernel, Pid } from '../kernel-api/index.js';

export interface KernelInfo {
  id: string;
  label: string;
  version: number;
  display: AnyKernel['display'];
  configSchema: AnyKernel['configSchema'];
  supportedGates: readonly string[];
  usesServices: readonly string[];
  drawMode: AnyKernel['drawMode'];
  commands: readonly AnyKernel['commands'][number][];
}

export function kernelInfo(k: AnyKernel): KernelInfo {
  return {
    id: k.id,
    label: k.label,
    version: k.version,
    display: k.display,
    configSchema: k.configSchema,
    supportedGates: k.supportedGates,
    usesServices: k.usesServices,
    drawMode: k.drawMode,
    commands: k.commands,
  };
}

export async function loadGiveaway(c: pg.PoolClient, rt: Runtime, id: string): Promise<{ state: GiveawayState; row: GiveawayRow } | null> {
  const row = await loadGiveawayRow(c, id);
  if (!row) return null;
  const state = await loadStreamState(c, rt.registry, giveawayStream(id), rt.reducer);
  return state.exists ? { state, row } : null;
}

export interface NamedChannelStatus extends ChannelStatusView {
  displayName: string;
}

export interface GiveawayDetail {
  id: string;
  teamId: string;
  kernel: KernelInfo;
  status: GiveawayState['status'];
  settings: GiveawayState['settings'];
  legal: GiveawayState['legal'];
  legalEventId: string | null;
  boost: GiveawayState['boost'];
  pool: { size: number; weight: number };
  registeredCount: number;
  winners: { pid: Pid; displayName: string; status: WinnerStatus }[];
  draws: GiveawayState['draws'];
  channels: NamedChannelStatus[];
  /** Zeitpunkt der gültigen Ziehung, null ohne. Meldefrist = drawnAt + claimDays (NEW_DESIGN.md 7.3). */
  drawnAt: string | null;
  closedAt: string | null;
  purgedAt: string | null;
}

/** Zeitpunkt der gültigen (nicht aufgehobenen) Ziehung aus dem Journal, null ohne Ziehung. */
export async function drawnAtOf(c: Queryable, registry: EventTypeRegistry, state: GiveawayState): Promise<string | null> {
  const draw = [...state.draws].reverse().find((d) => !d.voided);
  if (!draw) return null;
  const e = await readEvent(c, registry, draw.eventId);
  return e ? e.createdAt.toISOString() : null;
}

export async function giveawayDetail(c: Queryable, rt: Runtime, id: string, state: GiveawayState, now: Date): Promise<GiveawayDetail> {
  const kernel = rt.kernels.get(state.kernelId);
  const pool = kernel.pool(state.kernelState, state.settings.config);
  const winnerPids = Object.keys(state.winners);
  const [names, statuses, drawnAt] = await Promise.all([
    displayNamesOf(c, [...state.settings.channels, ...winnerPids]),
    channelStatusView(c, state.settings.channels, now),
    drawnAtOf(c, rt.registry, state),
  ]);
  const channels = statuses.map((v) => ({ ...v, displayName: names.get(v.pid) ?? displayNameOf(null, v.pid) }));
  return {
    id,
    teamId: state.teamId,
    kernel: kernelInfo(kernel),
    status: state.status,
    settings: state.settings,
    legal: state.legal,
    legalEventId: state.legalEventId,
    boost: state.boost,
    pool: { size: pool.length, weight: pool.reduce((sum, e) => sum + e.weight, 0) },
    registeredCount: Object.keys(state.registered).length,
    winners: winnerPids.sort().map((pid) => ({ pid, displayName: names.get(pid) ?? displayNameOf(null, pid), status: state.winners[pid]! })),
    draws: state.draws,
    channels,
    drawnAt,
    closedAt: state.closedAt,
    purgedAt: state.purgedAt,
  };
}

export interface ParticipantView {
  pid: Pid;
  displayName: string;
  registered: boolean;
  inPool: boolean;
  seen: boolean;
  weight: number;
  /** Gewicht ÷ Topf-Gewicht, null ohne Topf. Die Oberfläche formatiert. */
  chance: number | null;
  winnerStatus: WinnerStatus | null;
  lines: { label: string; value: string }[];
}

interface ParticipantRow {
  pid: string;
  registered: boolean;
  in_pool: boolean;
  seen: boolean;
  weight: number;
  winner_status: WinnerStatus | null;
}

export async function participantRows(c: Queryable, rt: Runtime, id: string, state: GiveawayState): Promise<ParticipantView[]> {
  const kernel = rt.kernels.get(state.kernelId);
  const r = await c.query<ParticipantRow>(
    'SELECT pid, registered, in_pool, seen, weight, winner_status FROM giveaway_participants WHERE giveaway_id = $1 ORDER BY weight DESC, pid',
    [id],
  );
  const poolWeight = r.rows.reduce((sum, x) => sum + (x.in_pool ? x.weight : 0), 0);
  const names = await displayNamesOf(c, r.rows.map((x) => x.pid));
  return r.rows.map((x) => ({
    pid: x.pid,
    displayName: names.get(x.pid) ?? displayNameOf(null, x.pid),
    registered: x.registered,
    inPool: x.in_pool,
    seen: x.seen,
    weight: x.weight,
    chance: x.in_pool && poolWeight > 0 ? x.weight / poolWeight : null,
    winnerStatus: x.winner_status,
    lines: kernel.viewerView(state.kernelState, x.pid, state.settings.config).lines,
  }));
}

export type HistoryActor = { kind: 'user'; pid: Pid; displayName: string } | { kind: 'system'; name: string };

export interface HistoryEntry {
  id: string;
  seq: number;
  type: string;
  at: string;
  actor: HistoryActor;
  reason: string | null;
  reversesEventId: string | null;
  reverted: boolean;
  reversal: { kind: 'compensate' | 'void' } | { kind: 'none'; why: string };
  payload: unknown;
}

export const HISTORY_LIMIT_DEFAULT = 50;

const UUID_IN_PAYLOAD_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Alle UUID-Zeichenketten in einer Payload (rekursiv), Kandidaten für pids. */
export function uuidsIn(value: unknown, out = new Set<string>()): Set<string> {
  if (typeof value === 'string') {
    if (UUID_IN_PAYLOAD_RE.test(value)) out.add(value);
  } else if (Array.isArray(value)) {
    for (const v of value) uuidsIn(v, out);
  } else if (typeof value === 'object' && value !== null) {
    for (const v of Object.values(value)) uuidsIn(v, out);
  }
  return out;
}

/**
 * Eine Seite des Verlaufs, neueste zuerst. nextBeforeSeq ist null, wenn die Seite nicht voll war oder bei seq 1 endet.
 * names: Anzeigenamen aller pids in den Payloads der Seite, die in identities stehen (Verlaufstexte der Oberfläche).
 */
export async function historyPage(
  c: Queryable,
  rt: Runtime,
  stream: StreamId,
  o: { beforeSeq?: number; limit?: number },
): Promise<{ entries: HistoryEntry[]; nextBeforeSeq: number | null; names: Record<string, string> }> {
  const limit = Math.min(200, Math.max(1, Math.trunc(o.limit ?? HISTORY_LIMIT_DEFAULT)));
  const events = await readStreamPage(c, rt.registry, stream, { ...(o.beforeSeq === undefined ? {} : { beforeSeq: o.beforeSeq }), limit });
  const actorPids = events.map((e) => pidOfActor(e.actor)).filter((p): p is string => p !== null);
  const payloadPids = [...uuidsIn(events.map((e) => e.payload))];
  // Drei Abfragen je Seite statt einer je Eintrag: Namen der Akteure, Namen in den Payloads, Umkehrstatus im Bündel.
  const [names, payloadNames, reverted] = await Promise.all([
    displayNamesOf(c, actorPids),
    displayNamesOf(c, payloadPids),
    revertedIds(c, events.map((e) => e.id)),
  ]);
  const entries = events.map((e) => historyEntry(rt, e, names, reverted.has(e.id)));
  const last = entries.at(-1);
  return { entries, nextBeforeSeq: last !== undefined && entries.length === limit && last.seq > 1 ? last.seq : null, names: Object.fromEntries(payloadNames) };
}

function historyEntry(rt: Runtime, e: EventRecord, names: Map<string, string>, reverted: boolean): HistoryEntry {
  const spec = rt.registry.get(e.type).reversal;
  const pid = pidOfActor(e.actor);
  return {
    id: e.id,
    seq: e.seq,
    type: e.type,
    at: e.createdAt.toISOString(),
    actor: pid === null ? { kind: 'system', name: e.actor.replace(/^system:/, '') } : { kind: 'user', pid, displayName: names.get(pid) ?? displayNameOf(null, pid) },
    reason: e.reason,
    reversesEventId: e.reversesEventId,
    reverted,
    reversal: spec.kind === 'none' ? { kind: 'none', why: spec.why } : { kind: spec.kind },
    payload: e.payload,
  };
}
