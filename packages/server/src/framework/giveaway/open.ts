// Öffnen, Fortsetzen und Wiederöffnen eines Giveaways (NEW_DESIGN.md 9.4, 15.4): ohne Impressum, Teilnahmebedingungen
// und Datenschutzhinweis öffnet nichts. Beim ersten Übergang nach Offen friert der Rahmen die Fassung ein: Text als Kopie,
// URL mit Hash des Inhalts. Ist schon eine Fassung eingefroren (jedes normal geöffnete Giveaway), schreibt der Befehl nur den
// Übergang. Ein übernommenes Giveaway (Pausiert oder Geschlossen ohne Fassung) friert beim Fortsetzen oder Wiederöffnen ein.
// Öffnen aus dem Entwurf friert immer ein, auch nach einem zurückgenommenen Öffnen (die Profiltexte können sich geändert haben).
// Die URLs holt `pre` außerhalb der Transaktion. `prepare` prüft in der Sperre, dass die Texte noch dieselben sind.
import type { Queryable } from '../../db/pool.js';
import type { Actor, StreamId } from '../../journal/types.js';
import { canonicalJson } from '../../shared/canonical.js';
import { reject } from '../../shared/rejection.js';
import type { CommandContext, CommandHandler } from '../command-bus.js';
import { mergeLegal, missingLegal, type FrozenLegal, type LegalFetcher, type LegalTexts } from '../legal.js';
import { GIVEAWAY_NOT_FOUND, authorizeControl } from './authorize.js';
import { STATUS_LABEL, type GiveawayCmd, type GiveawayDeps } from './lifecycle.js';
import { GIVEAWAY_EVENTS, giveawayStream, type GiveawayState, type GiveawayStatus } from './state.js';

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

export type OpenType = 'open_giveaway' | 'resume_giveaway' | 'reopen_giveaway';

const OPEN_SPEC: Record<OpenType, { from: GiveawayStatus; label: string }> = {
  open_giveaway: { from: 'draft', label: 'Öffnen' },
  resume_giveaway: { from: 'paused', label: 'Fortsetzen' },
  reopen_giveaway: { from: 'closed', label: 'Wieder öffnen' },
};

/** Ergebnis von pre (außerhalb der Sperre). `merged` ist die Fassung, zu der die Hashes gehören. `frozen`: schon eingefroren, kein Netz. */
export type OpenPre =
  | { kind: 'skip' }
  | { kind: 'frozen' }
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

export function openGiveawayHandler(d: OpenDeps, type: OpenType = 'open_giveaway'): CommandHandler<GiveawayCmd, GiveawayState, OpenPrepared, OpenPre> {
  const spec = OPEN_SPEC[type];
  const mergedFor = async (db: Queryable, cmd: GiveawayCmd, ctx: CommandContext): Promise<{ state: GiveawayState; merged: LegalTexts }> => {
    const state = await d.loadState(db, giveawayStream(cmd.giveawayId));
    return { state, merged: mergeLegal(state.settings.legal, await d.legalSource.profileOf(db, ctx.actor)) };
  };
  const wrongState = (status: GiveawayStatus) => reject('invalid_transition', `Aus dem Zustand ${STATUS_LABEL[status]} geht ${spec.label} nicht.`);
  return {
    type,
    streamOf: (cmd) => giveawayStream(cmd.giveawayId),
    reducer: d.reducer,
    authorize: authorizeControl(d.auth),
    async pre(cmd, ctx, db) {
      const { state, merged } = await mergedFor(db, cmd, ctx);
      if (!state.exists || state.status !== spec.from) return { kind: 'skip' };
      // Öffnen aus dem Entwurf friert immer ein (9.4). Fortsetzen und Wiederöffnen nur, wenn noch keine Fassung eingefroren ist (15.4).
      if (type !== 'open_giveaway' && state.legal !== null) return { kind: 'frozen' };
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
      if (state.status !== spec.from) return wrongState(state.status);
      const transition = { type: GIVEAWAY_EVENTS.statusChanged, payload: { from: spec.from, to: 'open' } };
      switch (prepared.kind) {
        case 'frozen':
          // pre sah die Fassung eingefroren. Ist sie es in der Sperre nicht (Zustand zwischendurch neu gebaut), erneut versuchen.
          return state.legal !== null ? [transition] : reject('legal_changed', 'Die Rechtstexte haben sich gerade geändert. Öffne erneut.');
        case 'missing':
          return reject('legal_required', `Hinterlege zuerst: ${prepared.names.join(', ')}.`);
        case 'unreachable':
          return reject('legal_unreachable', `Die Seite ${prepared.url} ist nicht erreichbar. Prüfe den Link.`);
        case 'changed':
          return reject('legal_changed', 'Die Rechtstexte haben sich gerade geändert. Öffne erneut.');
        case 'ready':
          if (type !== 'open_giveaway' && state.legal !== null) return reject('legal_changed', 'Die Rechtstexte haben sich gerade geändert. Öffne erneut.');
          return [{ type: GIVEAWAY_EVENTS.legalFrozen, payload: prepared.frozen }, transition];
        case 'skip':
          // pre sah das Giveaway in einem anderen Zustand, jetzt passt er: der Zustand hat sich gerade geändert, erneut versuchen.
          return reject('legal_changed', 'Die Rechtstexte haben sich gerade geändert. Öffne erneut.');
      }
    },
  };
}
