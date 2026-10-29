// Zustand des Stroms account:<pid> (NEW_DESIGN.md 5.1: Zustimmungen, Profil, Löschung). Rein und unveränderlich.
import type { StreamReducer } from '../../framework/command-bus.js';
import { EMPTY_LEGAL, type LegalTexts } from '../../framework/legal.js';
import type { EventRecord, StreamId } from '../../journal/types.js';

export interface AccountState {
  exists: boolean;
  soloTeamId: string;
  termsVersion: number;
  channelConnected: boolean;
  channelScopes: string[];
  legal: LegalTexts;
  deleted: boolean;
}

export const ACCOUNT_EVENTS = {
  created: 'account_created',
  termsAccepted: 'terms_accepted',
  termsWithdrawn: 'terms_withdrawn',
  profileUpdated: 'profile_updated',
  channelConnected: 'channel_connected',
  channelDisconnected: 'channel_disconnected',
  deleted: 'account_deleted',
} as const;

const PREFIX = 'account:';

export function accountStream(pid: string): StreamId {
  return `${PREFIX}${pid}`;
}

export function pidOfStream(stream: StreamId): string | null {
  return stream.startsWith(PREFIX) ? stream.slice(PREFIX.length) : null;
}

function apply(s: AccountState, e: EventRecord): AccountState {
  switch (e.type) {
    case ACCOUNT_EVENTS.created:
      return { ...s, exists: true, soloTeamId: (e.payload as { soloTeamId: string }).soloTeamId };
    case ACCOUNT_EVENTS.termsAccepted:
      return { ...s, termsVersion: (e.payload as { version: number }).version };
    case ACCOUNT_EVENTS.termsWithdrawn:
      return { ...s, termsVersion: (e.payload as { previous: number }).previous };
    case ACCOUNT_EVENTS.profileUpdated:
      return { ...s, legal: (e.payload as { after: LegalTexts }).after };
    case ACCOUNT_EVENTS.channelConnected:
      return { ...s, channelConnected: true, channelScopes: [...(e.payload as { scopes: string[] }).scopes] };
    case ACCOUNT_EVENTS.channelDisconnected:
      return { ...s, channelConnected: false, channelScopes: [] };
    case ACCOUNT_EVENTS.deleted:
      return { ...s, deleted: true, channelConnected: false, channelScopes: [] };
    default:
      return s;
  }
}

export const accountReducer: StreamReducer<AccountState> = {
  name: 'account',
  version: 1,
  initial: () => ({ exists: false, soloTeamId: '', termsVersion: 0, channelConnected: false, channelScopes: [], legal: EMPTY_LEGAL, deleted: false }),
  apply,
};
