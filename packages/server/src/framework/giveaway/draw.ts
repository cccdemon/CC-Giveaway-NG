// Ziehung, Ersatzziehung und Gewinnerstatus (NEW_DESIGN.md 7.2, 7.3). Das Ereignis giveaway_drawn ist der Nachweis.
import { createHash, randomBytes } from 'node:crypto';
import type pg from 'pg';
import type { DrawMode, Pid, PoolEntry } from '../../kernel-api/index.js';
import type { StreamId } from '../../journal/types.js';
import { reject, type Rejection } from '../../shared/rejection.js';
import type { CommandHandler } from '../command-bus.js';
import { EVENT_VOIDED } from '../revert.js';
import { GIVEAWAY_NOT_FOUND, authorizeControl } from './authorize.js';
import type { GiveawayDeps } from './lifecycle.js';
import { GIVEAWAY_EVENTS, giveawayStream, type GateConfig, type GiveawayState, type WinnerStatus } from './state.js';

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

export interface GateResult {
  pid: Pid;
  ok: boolean;
  reasons: string[];
}

export interface GateChecker {
  check(c: pg.PoolClient, gates: GateConfig[], pids: Pid[]): Promise<GateResult[]>;
}

export const noGates: GateChecker = {
  check: async (_c, _gates, pids) => pids.map((pid) => ({ pid, ok: true, reasons: [] })),
};

/**
 * `prepare` läuft vor `decide` und ohne Zustand. `loadState` liest den Strom innerhalb der Stromsperre derselben
 * Transaktion, darum sieht `prepare` denselben Zustand wie `decide`. Die Runtime liefert dafür loadStreamState.
 */
export interface DrawDeps extends GiveawayDeps {
  gates: GateChecker;
  rng: Rng;
  loadState(c: pg.PoolClient, stream: StreamId): Promise<GiveawayState>;
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

const SETTABLE: readonly WinnerStatus[] = ['reported', 'shipped', 'done', 'forfeited'];

const NOT_A_WINNER = (): Rejection => reject('not_a_winner', 'Diese Person ist kein Gewinner.');
const NOT_DRAWN_REDRAW = (): Rejection => reject('not_drawn', 'Es gibt keine gültige Ziehung, die du ersetzen könntest.');

function kernelPool(d: DrawDeps, state: GiveawayState): PoolEntry[] {
  return d.kernels.get(state.kernelId).pool(state.kernelState, state.settings.config);
}

/** Bedingungen für alle Einträge des Kern-Topfs. Ohne passenden Zustand leer, decide lehnt dann ab.
 *  Genau ein Ergebnis je pid des Topfs: fremde und doppelte Ergebnisse fallen weg, fehlende gelten als nicht erfüllt. */
function checkGates(d: DrawDeps, status: GiveawayState['status']) {
  return async (c: pg.PoolClient, cmd: { giveawayId: string }): Promise<GateResult[]> => {
    const state = await d.loadState(c, giveawayStream(cmd.giveawayId));
    if (!state.exists || state.status !== status) return [];
    const pids = kernelPool(d, state).map((p) => p.pid);
    const results = await d.gates.check(c, state.settings.gates, pids);
    return pids.map((pid) => results.find((r) => r.pid === pid) ?? { pid, ok: false, reasons: ['no_result'] });
  };
}

/** Kern-Topf ohne Einträge, die eine Bedingung verfehlen, in `without` stehen oder kein positives Gewicht haben. */
function eligible(d: DrawDeps, state: GiveawayState, gates: GateResult[], without: readonly Pid[]): PoolEntry[] {
  const ok = new Set(gates.filter((g) => g.ok).map((g) => g.pid));
  return kernelPool(d, state).filter((p) => drawable(p) && ok.has(p.pid) && !without.includes(p.pid));
}

function emptyPool(d: DrawDeps, state: GiveawayState): Rejection {
  return reject('empty_pool', d.kernels.get(state.kernelId).display.emptyPool);
}

export function drawHandler(d: DrawDeps): CommandHandler<DrawCmd, GiveawayState, GateResult[]> {
  return {
    type: 'draw',
    streamOf: (cmd) => giveawayStream(cmd.giveawayId),
    reducer: d.reducer,
    authorize: authorizeControl(d.auth),
    prepare: checkGates(d, 'closed'),
    decide(state, _cmd, _ctx, gates) {
      if (!state.exists) return GIVEAWAY_NOT_FOUND();
      if (state.status !== 'closed') return reject('not_closed', 'Schließe das Giveaway, bevor du ziehst.');
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

export function redrawHandler(d: DrawDeps): CommandHandler<RedrawCmd, GiveawayState, GateResult[]> {
  return {
    type: 'redraw',
    streamOf: (cmd) => giveawayStream(cmd.giveawayId),
    reducer: d.reducer,
    authorize: authorizeControl(d.auth),
    prepare: checkGates(d, 'drawn'),
    decide(state, cmd, _ctx, gates) {
      if (!state.exists) return GIVEAWAY_NOT_FOUND();
      if (state.status !== 'drawn') return NOT_DRAWN_REDRAW();
      if (typeof cmd.reason !== 'string' || !cmd.reason.trim()) return reject('reason_required', 'Gib einen Grund für die Ersatzziehung an.');
      const target = state.draws.find((r) => !r.voided && r.winners.includes(cmd.replace));
      if (!target || !Object.hasOwn(state.winners, cmd.replace)) return NOT_A_WINNER();
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
