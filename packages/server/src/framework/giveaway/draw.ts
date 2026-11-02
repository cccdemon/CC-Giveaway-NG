// Ziehung, Ersatzziehung und Gewinnerstatus (NEW_DESIGN.md 7.2, 7.3). Das Ereignis giveaway_drawn ist der Nachweis.
// Die Bedingungen prüft `pre` außerhalb der Sperre (Helix). `prepare` stellt sicher, dass der Topf noch derselbe ist.
import { createHash, randomBytes } from 'node:crypto';
import type { Queryable } from '../../db/pool.js';
import type { DrawMode, Pid, PoolEntry } from '../../kernel-api/index.js';
import type { StreamId } from '../../journal/types.js';
import { reject, type Rejection } from '../../shared/rejection.js';
import type { CommandContext, CommandHandler } from '../command-bus.js';
import { EVENT_VOIDED } from '../revert.js';
import { GIVEAWAY_NOT_FOUND, authorizeControl } from './authorize.js';
import { GateCheckError, type GateChecker, type GateResult } from './gates.js';
import type { GiveawayDeps } from './lifecycle.js';
import { GIVEAWAY_EVENTS, giveawayStream, type GiveawayState, type GiveawayStatus, type WinnerStatus } from './state.js';

export type { GateChecker, GateResult } from './gates.js';
export { noGates } from './gates.js';

export type Rng = () => number; // in [0, 1)

/** 48 Zufallsbits aus der CSPRNG, gleichverteilt in [0, 1). */
export const csprng: Rng = () => randomBytes(6).readUIntBE(0, 6) / 2 ** 48;

/** Spielt gespeicherte Zufallswerte ab, z. B. aus `random` eines Nachweises. */
export function rngFrom(values: number[]): Rng {
  const queue = [...values];
  return () => {
    const next = queue.shift();
    if (next === undefined) throw new Error('Der Zufallsgenerator ist erschöpft.');
    return next;
  };
}

const byPid = (a: PoolEntry, b: PoolEntry): number => (a.pid < b.pid ? -1 : a.pid > b.pid ? 1 : 0);
const drawable = (e: PoolEntry): boolean => Number.isFinite(e.weight) && e.weight > 0;

export function poolHash(pool: PoolEntry[]): string {
  const sorted = pool.map((e) => ({ pid: e.pid, weight: e.weight })).sort(byPid);
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}

/** Zieht `count` Einträge ohne Zurücklegen, gewichtet. Schreibt jeden Zufallswert nach `random`. */
function pickWeighted(entries: PoolEntry[], count: number, rng: Rng, random: number[]): Pid[] {
  const rest = [...entries];
  const winners: Pid[] = [];
  while (winners.length < count && rest.length > 0) {
    const r = rng();
    random.push(r);
    const target = r * rest.reduce((s, e) => s + e.weight, 0);
    let acc = 0;
    let idx = rest.length - 1; // Rundungsrest landet beim letzten Eintrag
    for (let i = 0; i < rest.length; i++) {
      acc += rest[i]!.weight;
      if (acc > target) {
        idx = i;
        break;
      }
    }
    winners.push(rest[idx]!.pid);
    rest.splice(idx, 1);
  }
  return winners;
}

export function drawWinners(pool: PoolEntry[], mode: DrawMode, count: number, rng: Rng): { winners: Pid[]; random: number[] } {
  const entries = pool.filter(drawable).sort(byPid);
  const n = Math.min(count, entries.length);
  const random: number[] = [];
  if (n <= 0) return { winners: [], random };
  switch (mode) {
    case 'weighted':
      return { winners: pickWeighted(entries, n, rng, random), random };
    case 'equal':
      return { winners: pickWeighted(entries.map((e) => ({ pid: e.pid, weight: 1 })), n, rng, random), random };
    case 'highest': {
      const ranked = [...entries].sort((a, b) => b.weight - a.weight || byPid(a, b));
      const cut = ranked[n - 1]!.weight;
      const certain = ranked.filter((e) => e.weight > cut).map((e) => e.pid);
      const tied = ranked.filter((e) => e.weight === cut).map((e) => ({ pid: e.pid, weight: 1 }));
      const need = n - certain.length;
      const picked = tied.length === need ? tied.map((e) => e.pid) : pickWeighted(tied, need, rng, random);
      return { winners: [...certain, ...picked], random };
    }
  }
}

/**
 * `pre` läuft vor der Transaktion ohne Sperre und holt die Fakten bei Twitch. `loadState` liest dafür den Strom.
 * `prepare` vergleicht in der Sperre den Topf mit dem aus `pre`. Die Runtime liefert loadStreamState.
 */
export interface DrawDeps extends GiveawayDeps {
  gates: GateChecker;
  rng: Rng;
  loadState(c: Queryable, stream: StreamId): Promise<GiveawayState>;
}

export interface DrawCmd {
  giveawayId: string;
}

export interface RedrawCmd {
  giveawayId: string;
  replace: Pid;
  reason: string;
}

export interface WinnerStatusCmd {
  giveawayId: string;
  pid: Pid;
  status: WinnerStatus;
}

export type DrawPre =
  | { kind: 'skip' }
  | { kind: 'failed'; code: string; message: string }
  | { kind: 'ready'; pids: Pid[]; gates: GateResult[] };

export type DrawPrepared = DrawPre | { kind: 'changed' };

const SETTABLE: readonly WinnerStatus[] = ['reported', 'shipped', 'done', 'forfeited'];

const NOT_A_WINNER = (): Rejection => reject('not_a_winner', 'Diese Person ist kein Gewinner.');
const NOT_DRAWN_REDRAW = (): Rejection => reject('not_drawn', 'Es gibt keine gültige Ziehung, die du ersetzen könntest.');
const POOL_CHANGED = (): Rejection => reject('pool_changed', 'Der Topf hat sich geändert. Ziehe erneut.');

function kernelPool(d: DrawDeps, state: GiveawayState): PoolEntry[] {
  return d.kernels.get(state.kernelId).pool(state.kernelState, state.settings.config);
}

const sortedPids = (d: DrawDeps, state: GiveawayState): Pid[] => kernelPool(d, state).map((p) => p.pid).sort();

/** Bedingungen für alle Einträge des Kern-Topfs, außerhalb der Sperre. Ohne passenden Zustand `skip`, decide lehnt dann ab. */
function checkGates(d: DrawDeps, status: GiveawayStatus) {
  return async (cmd: { giveawayId: string }, ctx: CommandContext, db: Queryable): Promise<DrawPre> => {
    const state = await d.loadState(db, giveawayStream(cmd.giveawayId));
    if (!state.exists || state.status !== status) return { kind: 'skip' };
    const pids = kernelPool(d, state).map((p) => p.pid);
    const seen = Object.fromEntries(Object.entries(state.seen).map(([pid, s]) => [pid, s.channels]));
    try {
      const results = await d.gates.check(db, { channels: state.settings.channels, gates: state.settings.gates, pids, seen, now: ctx.now });
      // Genau ein Ergebnis je pid des Topfs: fremde und doppelte Ergebnisse fallen weg, fehlende gelten als nicht erfüllt.
      const gates = pids.map((pid) => results.find((r) => r.pid === pid) ?? { pid, ok: false, reasons: ['no_result'] });
      return { kind: 'ready', pids: [...pids].sort(), gates };
    } catch (e) {
      if (e instanceof GateCheckError) return { kind: 'failed', code: e.code, message: e.message };
      throw e;
    }
  };
}

/** In der Sperre: Ist der Topf noch derselbe wie bei der Prüfung? */
function comparePool(d: DrawDeps) {
  return async (_c: unknown, _cmd: unknown, _ctx: CommandContext, pre: DrawPre, state: GiveawayState): Promise<DrawPrepared> => {
    if (pre.kind !== 'ready') return pre;
    const now = sortedPids(d, state);
    return now.length === pre.pids.length && now.every((pid, i) => pid === pre.pids[i]) ? pre : { kind: 'changed' };
  };
}

/** Anmeldung als eingebaute Bedingung: Nutzt der Kern den Dienst registration, fällt jeder Unangemeldete heraus (Glossar: Teilnehmer). */
function withRegistration(d: DrawDeps, state: GiveawayState, gates: GateResult[]): GateResult[] {
  if (!d.kernels.get(state.kernelId).usesServices.includes('registration')) return gates;
  return gates.map((g) => (g.pid in state.registered ? g : { pid: g.pid, ok: false, reasons: ['not_registered', ...g.reasons] }));
}

/** Kern-Topf ohne Einträge, die eine Bedingung verfehlen, in `without` stehen oder kein positives Gewicht haben. */
function eligible(d: DrawDeps, state: GiveawayState, gates: GateResult[], without: readonly Pid[]): PoolEntry[] {
  const ok = new Set(gates.filter((g) => g.ok).map((g) => g.pid));
  return kernelPool(d, state).filter((p) => drawable(p) && ok.has(p.pid) && !without.includes(p.pid));
}

function emptyPool(d: DrawDeps, state: GiveawayState): Rejection {
  return reject('empty_pool', d.kernels.get(state.kernelId).display.emptyPool);
}

/** Gemeinsame Prüfung des Prüfergebnisses. Liefert die Bedingungsergebnisse oder eine Ablehnung. */
function gatesOf(d: DrawDeps, state: GiveawayState, prepared: DrawPrepared): GateResult[] | Rejection {
  switch (prepared.kind) {
    case 'failed':
      return reject(prepared.code, prepared.message);
    case 'changed':
    case 'skip':
      return POOL_CHANGED();
    case 'ready':
      return withRegistration(d, state, prepared.gates);
  }
}

export function drawHandler(d: DrawDeps): CommandHandler<DrawCmd, GiveawayState, DrawPrepared, DrawPre> {
  return {
    type: 'draw',
    streamOf: (cmd) => giveawayStream(cmd.giveawayId),
    reducer: d.reducer,
    authorize: authorizeControl(d.auth),
    pre: checkGates(d, 'closed'),
    prepare: comparePool(d),
    decide(state, _cmd, _ctx, prepared) {
      if (!state.exists) return GIVEAWAY_NOT_FOUND();
      if (state.status !== 'closed') return reject('not_closed', 'Schließe das Giveaway, bevor du ziehst.');
      const gates = gatesOf(d, state, prepared);
      if (!Array.isArray(gates)) return gates;
      const pool = eligible(d, state, gates, []);
      if (pool.length === 0) return emptyPool(d, state);
      const mode = d.kernels.get(state.kernelId).drawMode;
      const { winners, random } = drawWinners(pool, mode, state.settings.winnersCount, d.rng);
      if (winners.length === 0) return emptyPool(d, state);
      return [
        { type: GIVEAWAY_EVENTS.drawn, payload: { mode, winners, pool, poolHash: poolHash(pool), random, gates, excluded: [] } },
      ];
    },
  };
}

export function redrawHandler(d: DrawDeps): CommandHandler<RedrawCmd, GiveawayState, DrawPrepared, DrawPre> {
  return {
    type: 'redraw',
    streamOf: (cmd) => giveawayStream(cmd.giveawayId),
    reducer: d.reducer,
    authorize: authorizeControl(d.auth),
    pre: checkGates(d, 'drawn'),
    prepare: comparePool(d),
    decide(state, cmd, _ctx, prepared) {
      if (!state.exists) return GIVEAWAY_NOT_FOUND();
      if (state.status !== 'drawn') return NOT_DRAWN_REDRAW();
      if (typeof cmd.reason !== 'string' || !cmd.reason.trim()) return reject('reason_required', 'Gib einen Grund für die Ersatzziehung an.');
      const target = state.draws.find((r) => !r.voided && r.winners.includes(cmd.replace));
      if (!target || !Object.hasOwn(state.winners, cmd.replace)) return NOT_A_WINNER();
      const gates = gatesOf(d, state, prepared);
      if (!Array.isArray(gates)) return gates;
      const excluded = [cmd.replace, ...target.excluded.filter((p) => p !== cmd.replace)];
      const pool = eligible(d, state, gates, [...Object.keys(state.winners), ...excluded]);
      if (pool.length === 0) return emptyPool(d, state);
      const mode = d.kernels.get(state.kernelId).drawMode;
      const { winners: fresh, random } = drawWinners(pool, mode, 1, d.rng);
      if (fresh.length === 0) return emptyPool(d, state);
      const winners = [...target.winners.filter((p) => p !== cmd.replace), ...fresh];
      // Neue Ziehung vor dem Void der alten: nur so behält der Reducer die Stati bleibender Gewinner (state.ts).
      return [
        { type: GIVEAWAY_EVENTS.drawn, payload: { mode, winners, pool, poolHash: poolHash(pool), random, gates, excluded } },
        { type: EVENT_VOIDED, payload: { targetType: GIVEAWAY_EVENTS.drawn }, reason: cmd.reason, reversesEventId: target.eventId },
      ];
    },
  };
}

export function winnerStatusHandler(d: GiveawayDeps): CommandHandler<WinnerStatusCmd, GiveawayState> {
  return {
    type: 'set_winner_status',
    streamOf: (cmd) => giveawayStream(cmd.giveawayId),
    reducer: d.reducer,
    authorize: authorizeControl(d.auth),
    decide(state, cmd) {
      if (!state.exists) return GIVEAWAY_NOT_FOUND();
      if (state.status !== 'drawn') return reject('not_drawn', 'Den Gewinnerstatus setzt du nur im Zustand Gezogen.');
      if (!SETTABLE.includes(cmd.status)) {
        return reject('invalid_winner_status', 'Wähle gemeldet, versendet, erledigt oder verfallen.');
      }
      if (!Object.hasOwn(state.winners, cmd.pid)) return NOT_A_WINNER();
      const from = state.winners[cmd.pid]!;
      if (from === cmd.status) return [];
      return [{ type: GIVEAWAY_EVENTS.winnerStatusSet, payload: { pid: cmd.pid, from, to: cmd.status } }];
    },
  };
}
