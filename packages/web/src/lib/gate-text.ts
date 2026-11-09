// Bedingungen (NEW_DESIGN.md 6.5) und ihre Gründe in Worten. Kanalnamen sind Streamer, nicht maskiert.
import type { GateConfig } from './api/types.js';
import { L } from './texts/labels.js';

type Channels = { pid: string; displayName: string }[];

const channelName = (pid: string | undefined, channels: Channels): string => channels.find((c) => c.pid === pid)?.displayName ?? L.participant.deletedWith(pid ?? '');

export function gateText(g: GateConfig, channels: Channels): string {
  switch (g.id) {
    case 'follow':
      if (g.mode === 'all') return L.gates.followAll(channels.length);
      if (g.mode === 'min') return L.gates.followMin(g.min ?? 1);
      return L.gates.followChannel(channelName(g.channel, channels));
    case 'account_age':
      return L.gates.accountAge(g.days);
    case 'follow_age':
      return L.gates.followAge(g.days);
    case 'presence':
      return L.gates.presence(g.minChannels);
  }
}

/** Grund aus dem Ziehungsnachweis oder der Live-Prüfung: `follow:<pid>`, `follow_min`, `account_age`, `follow_age`, `presence`, `banned`, `not_registered`. */
export function reasonText(reason: string, channels: Channels): string {
  if (reason.startsWith('follow:')) return L.gates.followMissing(channelName(reason.slice('follow:'.length), channels));
  switch (reason) {
    case 'follow_min':
      return L.gates.reasonFollowMin;
    case 'account_age':
      return L.gates.reasonAccountAge;
    case 'follow_age':
      return L.gates.reasonFollowAge;
    case 'presence':
      return L.gates.reasonPresence;
    case 'banned':
      return L.gates.reasonBanned;
    case 'not_registered':
      return L.gates.reasonNotRegistered;
    default:
      return reason;
  }
}
