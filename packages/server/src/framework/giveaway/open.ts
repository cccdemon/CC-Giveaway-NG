// Öffnen eines Giveaways (NEW_DESIGN.md 9.4): ohne Impressum, Teilnahmebedingungen und Datenschutzhinweis öffnet nichts.
// Beim Übergang Entwurf → Offen friert der Rahmen die Fassung ein: Text als Kopie, URL mit Hash des Inhalts.
// Die URLs holt `pre` außerhalb der Transaktion. `prepare` prüft in der Sperre, dass die Texte noch dieselben sind.
import type { Queryable } from '../../db/pool.js';
import type { Actor, StreamId } from '../../journal/types.js';
import { canonicalJson } from '../../shared/canonical.js';
import { reject } from '../../shared/rejection.js';
import type { CommandContext, CommandHandler } from '../command-bus.js';
import { mergeLegal, missingLegal, type FrozenLegal, type LegalFetcher, type LegalTexts } from '../legal.js';
import { GIVEAWAY_NOT_FOUND, authorizeControl } from './authorize.js';
import { STATUS_LABEL, type GiveawayCmd, type GiveawayDeps } from './lifecycle.js';
import { GIVEAWAY_EVENTS, giveawayStream, type GiveawayState } from './state.js';

/** Rechtstexte aus dem Profil des Akteurs. Systemakteure haben keins. */
export interface LegalSource {
  profileOf(db: Queryable, actor: Actor): Promise<LegalTexts | null>;
}

export const noProfile: LegalSource = { profileOf: async () => null };

export interface OpenDeps extends GiveawayDeps {
  legalSource: LegalSource;
  fetcher: LegalFetcher;
  loadState(db: Queryable, stream: StreamId): Promise<GiveawayState>;
}

/** Ergebnis von pre (außerhalb der Sperre). `merged` ist die Fassung, zu der die Hashes gehören. */
export type OpenPre =
  | { kind: 'skip' }
  | { kind: 'missing'; names: string[] }
  | { kind: 'unreachable'; url: string }
  | { kind: 'ready'; merged: LegalTexts; frozen: FrozenLegal };

export type OpenPrepared = OpenPre | { kind: 'changed' };

async function freeze(fetcher: LegalFetcher, legal: LegalTexts, at: string): Promise<OpenPre> {
  const hashed = async (url: string): Promise<{ url: string; hash: string } | null> => {
    const r = await fetcher(url);
    return r.ok ? { url, hash: r.hash } : null;
  };
  const impressum = await hashed(legal.impressumUrl!);
  if (!impressum) return { kind: 'unreachable', url: legal.impressumUrl! };
  let terms: FrozenLegal['terms'];
  if ('text' in legal.terms!) {
    terms = { text: legal.terms.text };
  } else {
    const t = await hashed(legal.terms!.url);
    if (!t) return { kind: 'unreachable', url: legal.terms!.url };
    terms = t;
  }
  const privacy = await hashed(legal.privacyUrl!);
  if (!privacy) return { kind: 'unreachable', url: legal.privacyUrl! };
  return { kind: 'ready', merged: legal, frozen: { impressum, terms, privacy, frozenAt: at } };
}

export function openGiveawayHandler(d: OpenDeps): CommandHandler<GiveawayCmd, GiveawayState, OpenPrepared, OpenPre> {
  const mergedFor = async (db: Queryable, cmd: GiveawayCmd, ctx: CommandContext): Promise<{ state: GiveawayState; merged: LegalTexts }> => {
    const state = await d.loadState(db, giveawayStream(cmd.giveawayId));
    return { state, merged: mergeLegal(state.settings.legal, await d.legalSource.profileOf(db, ctx.actor)) };
  };
  return {
    type: 'open_giveaway',
    streamOf: (cmd) => giveawayStream(cmd.giveawayId),
    reducer: d.reducer,
    authorize: authorizeControl(d.auth),
    async pre(cmd, ctx, db) {
      const { state, merged } = await mergedFor(db, cmd, ctx);
      if (!state.exists || state.status !== 'draft') return { kind: 'skip' };
      const names = missingLegal(merged);
      if (names.length > 0) return { kind: 'missing', names };
      return freeze(d.fetcher, merged, ctx.now.toISOString());
    },
    async prepare(c, cmd, ctx, pre) {
      if (pre.kind !== 'ready') return pre;
      // Hat sich zwischen Abruf und Sperre etwas geändert, passt der Nachweis nicht mehr zu den Texten.
      const { merged } = await mergedFor(c, cmd, ctx);
      return canonicalJson(merged) === canonicalJson(pre.merged) ? pre : { kind: 'changed' };
    },
    decide(state, _cmd, _ctx, prepared) {
      if (!state.exists) return GIVEAWAY_NOT_FOUND();
      if (state.status !== 'draft') return reject('invalid_transition', `Aus dem Zustand ${STATUS_LABEL[state.status]} geht Öffnen nicht.`);
      switch (prepared.kind) {
        case 'missing':
          return reject('legal_required', `Hinterlege zuerst: ${prepared.names.join(', ')}.`);
        case 'unreachable':
          return reject('legal_unreachable', `Die Seite ${prepared.url} ist nicht erreichbar. Prüfe den Link.`);
        case 'changed':
          return reject('legal_changed', 'Die Rechtstexte haben sich gerade geändert. Öffne erneut.');
        case 'ready':
          return [
            { type: GIVEAWAY_EVENTS.legalFrozen, payload: prepared.frozen },
            { type: GIVEAWAY_EVENTS.statusChanged, payload: { from: 'draft', to: 'open' } },
          ];
        case 'skip':
          // pre sah das Giveaway nicht im Entwurf, jetzt ist es dort: Zustand hat sich geändert, erneut versuchen.
          return reject('legal_changed', 'Die Rechtstexte haben sich gerade geändert. Öffne erneut.');
      }
    },
  };
}
