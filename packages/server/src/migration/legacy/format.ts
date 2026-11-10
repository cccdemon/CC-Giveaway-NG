// Export v2 des Altsystems (NEW_DESIGN.md 15.5): Form, Kontrollsumme je Kanal, alle Logins. Rein, ohne I/O.
import { z } from 'zod';

export const BACKUP_FORMAT = 'cc-giveaway-backup';
export const BACKUP_VERSION = 2;

const login = z.string().min(1).max(64);
const sec = z.number().finite().min(0);

const memberSchema = z.object({ login, twitchId: z.string().min(1).nullable(), channel: login });
const participantSchema = z.object({
  login,
  registered: z.boolean(),
  perChannel: z.record(login, z.object({ watchSec: sec })),
});
const cfgSchema = z.object({
  coin_base_sec: z.number().finite(),
  follow_min: z.number().finite(),
  chat_enabled: z.boolean(),
  chat_bonus_sec: z.number().finite(),
  chat_min_words: z.number().finite(),
  chat_cooldown: z.number().finite(),
});
const instanceSchema = z.object({
  sessionId: z.string().min(1).max(100),
  name: z.string().max(200).nullable().default(null),
  keyword: z.string().max(200),
  channels: z.array(login),
  open: z.boolean(),
  paused: z.boolean(),
  cfg: cfgSchema,
  prize: z.string().max(2000).nullable(),
  sponsor: z.string().max(2000).nullable(),
  termsVersion: z.int().min(0),
  termsText: z.string().nullable(),
  participants: z.array(participantSchema),
  pgWatchSum: z.record(login, sec),
});
// looseObject: die v1-Felder des Altsystems (channels, config, state, participants) bleiben stehen und stören nicht.
const backupSchema = z.looseObject({
  format: z.literal(BACKUP_FORMAT),
  version: z.literal(BACKUP_VERSION),
  exportedAt: z.string().optional(),
  team: z.object({ id: z.string().min(1).max(100), name: z.string().max(200), members: z.array(memberSchema), banned: z.array(login) }),
  instances: z.array(instanceSchema),
});

export type LegacyMember = z.infer<typeof memberSchema>;
export type LegacyParticipant = z.infer<typeof participantSchema>;
export type LegacyInstance = z.infer<typeof instanceSchema>;
export interface LegacyBackup {
  exportedAt?: string;
  team: { id: string; name: string; members: LegacyMember[]; banned: string[] };
  instances: LegacyInstance[];
}

export type LegacyFormatCode = 'invalid_json' | 'wrong_format' | 'wrong_version' | 'invalid_shape';

export class LegacyFormatError extends Error {
  constructor(
    readonly code: LegacyFormatCode,
    message: string,
  ) {
    super(message);
    this.name = 'LegacyFormatError';
  }
}

/** Liest den Export. Wirft LegacyFormatError mit Hinweis, was fehlt und welche Version erwartet ist (NEW_DESIGN.md 15.7). */
export function parseBackup(text: string): LegacyBackup {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new LegacyFormatError('invalid_json', 'Die Datei ist kein gültiges JSON. Erzeuge den Export neu im Altsystem.');
  }
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  if (o.format !== BACKUP_FORMAT) {
    throw new LegacyFormatError('wrong_format', `Die Datei hat das Format ${String(o.format ?? 'unbekannt')}, erwartet ist ${BACKUP_FORMAT}.`);
  }
  if (o.version !== BACKUP_VERSION) {
    throw new LegacyFormatError('wrong_version', `Die Datei hat Version ${String(o.version ?? 'unbekannt')}, erwartet ist Version ${BACKUP_VERSION}. Erzeuge den Export neu im Altsystem.`);
  }
  const parsed = backupSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new LegacyFormatError('invalid_shape', `Die Datei hat nicht die erwartete Form: ${first ? `${first.path.join('.')} ${first.message}` : 'unbekannter Fehler'}.`);
  }
  const b = parsed.data;
  return {
    ...(b.exportedAt === undefined ? {} : { exportedAt: b.exportedAt }),
    team: { ...b.team, members: b.team.members.map((m) => ({ ...m, login: lower(m.login), channel: lower(m.channel) })), banned: b.team.banned.map(lower) },
    instances: b.instances.map((i) => ({
      ...i,
      channels: i.channels.map(lower),
      participants: i.participants.map((p) => ({ ...p, login: lower(p.login), perChannel: lowerKeys(p.perChannel) })),
      pgWatchSum: lowerKeys(i.pgWatchSum),
    })),
  };
}

const lower = (s: string): string => s.toLowerCase();
const lowerKeys = <V>(r: Record<string, V>): Record<string, V> => Object.fromEntries(Object.entries(r).map(([k, v]) => [lower(k), v]));

export interface ChecksumDeviation {
  sessionId: string;
  channel: string;
  fileSum: number;
  pgWatchSum: number;
}

/** Summe watchSec je Kanal in der Datei (gerundet) gegen pgWatchSum. Fehlender pgWatchSum-Kanal = 0, fremder Kanal in pgWatchSum = Abweichung. */
export function checkSums(backup: LegacyBackup): ChecksumDeviation[] {
  const out: ChecksumDeviation[] = [];
  for (const i of backup.instances) {
    const sums = new Map<string, number>();
    for (const ch of Object.keys(i.pgWatchSum)) sums.set(ch, 0);
    for (const p of i.participants) {
      for (const [ch, v] of Object.entries(p.perChannel)) sums.set(ch, (sums.get(ch) ?? 0) + v.watchSec);
    }
    for (const [channel, raw] of [...sums.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const fileSum = Math.round(raw);
      const pg = Math.round(i.pgWatchSum[channel] ?? 0);
      if (fileSum !== pg) out.push({ sessionId: i.sessionId, channel, fileSum, pgWatchSum: pg });
    }
  }
  return out;
}

/** Alle Logins der Datei: Mitglieder, Kanäle, Teilnehmer, Gesperrte. Klein, eindeutig, sortiert. */
export function loginsOf(backup: LegacyBackup): string[] {
  const set = new Set<string>();
  for (const m of backup.team.members) {
    set.add(m.login);
    set.add(m.channel);
  }
  for (const b of backup.team.banned) set.add(b);
  for (const i of backup.instances) {
    for (const ch of i.channels) set.add(ch);
    for (const p of i.participants) {
      set.add(p.login);
      for (const ch of Object.keys(p.perChannel)) set.add(ch);
    }
  }
  return [...set].sort();
}
