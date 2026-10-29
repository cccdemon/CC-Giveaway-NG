// Öffnen eines Giveaways (NEW_DESIGN.md 9.4): ohne Impressum, Teilnahmebedingungen und Datenschutzhinweis öffnet nichts.
// Beim Übergang Entwurf → Offen friert der Rahmen die Fassung ein: Text als Kopie, URL mit Hash des Inhalts.
import type pg from 'pg';
import type { Actor, StreamId } from '../../journal/types.js';
import { reject, type Rejection } from '../../shared/rejection.js';
import type { CommandHandler } from '../command-bus.js';
import { mergeLegal, missingLegal, type FrozenLegal, type LegalFetcher, type LegalTexts } from '../legal.js';
import { GIVEAWAY_NOT_FOUND, authorizeControl } from './authorize.js';
import { STATUS_LABEL, type GiveawayCmd, type GiveawayDeps } from './lifecycle.js';
import { GIVEAWAY_EVENTS, giveawayStream, type GiveawayState } from './state.js';

/** Rechtstexte aus dem Profil des Akteurs. Systemakteure haben keins. */
export interface LegalSource {
  profileOf(c: pg.PoolClient, actor: Actor): Promise<LegalTexts | null>;
}

export const noProfile: LegalSource = { profileOf: async () => null };

export interface OpenDeps extends GiveawayDeps {
  legalSource: LegalSource;
  fetcher: LegalFetcher;
  loadState(c: pg.PoolClient, stream: StreamId): Promise<GiveawayState>;
}

export type OpenPrepared =
  | { kind: 'skip' }
  | { kind: 'missing'; names: string[] }
  | { kind: 'unreachable'; url: string }
  | { kind: 'ready'; frozen: FrozenLegal };

async function freeze(fetcher: LegalFetcher, legal: LegalTexts, at: string): Promise<OpenPrepared> {
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
  return { kind: 'ready', frozen: { impressum, terms, privacy, frozenAt: at } };
}

export function openGiveawayHandler(d: OpenDeps): CommandHandler<GiveawayCmd, GiveawayState, OpenPrepared> {
  return {
    type: 'open_giveaway',
    streamOf: (cmd) => giveawayStream(cmd.giveawayId),
    reducer: d.reducer,
    authorize: authorizeControl(d.auth),
    async prepare(c, cmd, ctx) {
      const state = await d.loadState(c, giveawayStream(cmd.giveawayId));
      if (!state.exists || state.status !== 'draft') return { kind: 'skip' };
      const merged = mergeLegal(state.settings.legal, await d.legalSource.profileOf(c, ctx.actor));
      const names = missingLegal(merged);
      if (names.length > 0) return { kind: 'missing', names };
      return freeze(d.fetcher, merged, ctx.now.toISOString());
    },
    decide(state, _cmd, _ctx, prepared): Rejection | ReturnType<CommandHandler<GiveawayCmd, GiveawayState, OpenPrepared>['decide']> {
      if (!state.exists) return GIVEAWAY_NOT_FOUND();
      if (state.status !== 'draft') return reject('invalid_transition', `Aus dem Zustand ${STATUS_LABEL[state.status]} geht Öffnen nicht.`);
      switch (prepared.kind) {
        case 'missing':
          return reject('legal_required', `Hinterlege zuerst: ${prepared.names.join(', ')}.`);
        case 'unreachable':
          return reject('legal_unreachable', `Die Seite ${prepared.url} ist nicht erreichbar. Prüfe den Link.`);
        case 'ready':
          return [
            { type: GIVEAWAY_EVENTS.legalFrozen, payload: prepared.frozen },
            { type: GIVEAWAY_EVENTS.statusChanged, payload: { from: 'draft', to: 'open' } },
          ];
        case 'skip':
          // prepare sah einen anderen Zustand als decide. Beide lesen in derselben Sperre, das kommt nicht vor.
          return reject('invalid_transition', 'Der Zustand hat sich geändert. Versuche es noch einmal.');
      }
    },
  };
}
