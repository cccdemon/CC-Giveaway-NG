// Lauf der Übernahme (NEW_DESIGN.md 15.6, 15.7): Datei prüfen, Logins auflösen, Vorhandenes lesen, je Team und Giveaway einen
// Befehl mit Akteur system:migration. Schreibt nie an der Runtime vorbei. Im Probelauf endet alles als „würde anlegen“.
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { BusLogger } from '../../framework/command-bus.js';
import type { ImportLegacyGiveawayCmd, LegacyParticipantCmd } from '../../framework/giveaway/legacy.js';
import { KEYWORD_RE, type ChatBonusSettings } from '../../framework/giveaway/services.js';
import type { Runtime } from '../../framework/runtime.js';
import { findPidByTwitchId, type TwitchUser } from '../../identity/identities.js';
import type { AccountHandlers } from '../../identity/runtime.js';
import { checkSums, loginsOf, type LegacyBackup, type LegacyInstance } from './format.js';
import { giveawayIdOf, soloTeamIdOf, teamIdOf } from './ids.js';
import type { LoginResolver } from './resolve.js';

export interface RunOptions {
  pool: pg.Pool;
  rt: Runtime;
  accounts: AccountHandlers;
  resolver: LoginResolver;
  dryRun: boolean;
  now?: () => Date;
  log?: BusLogger;
}

export interface TeamReport {
  legacyTeamId: string;
  name: string;
  kind: 'solo' | 'team';
  teamId: string | null;
  outcome: 'created' | 'existing' | 'skipped' | 'would_create';
  reason?: string;
  /** Sperren, die nicht übernommen wurden (Solo-Team hat keine Sperrliste, Login nicht auflösbar). */
  bansSkipped: string[];
  /** Mitglieder ohne auflösbaren Login. */
  membersSkipped: string[];
}

export interface ChannelReport {
  login: string;
  pid: string | null;
  imported: number;
  pgWatchSum: number;
  notImported: number;
  inactive: boolean;
}

export interface UnresolvedSeconds {
  login: string;
  channel: string;
  sec: number;
}

export interface GiveawayReport {
  sessionId: string;
  name: string | null;
  giveawayId: string;
  status: 'paused' | 'closed';
  outcome: 'created' | 'skipped' | 'would_create' | 'failed';
  reason?: string;
  participants: { total: number; imported: number; registered: number; dropped: number };
  channels: ChannelReport[];
  unresolved: UnresolvedSeconds[];
  notes: string[];
}

export interface RunResult {
  aborted: { code: 'checksum' | 'helix'; message: string } | null;
  team: TeamReport | null;
  giveaways: GiveawayReport[];
  /** Alle Logins der Datei, die Twitch nicht kennt. */
  unresolved: string[];
  failed: number;
}

const MIGRATION = 'system:migration';
const COIN_MIN = 60;
const COIN_MAX = 360_000;

const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, Math.round(v)));

interface Rules {
  coinBaseSec: number;
  followMin: number;
  chatBonus: ChatBonusSettings;
  keyword: string | null;
  prize: string;
  sponsor: string | null;
  terms: { version: number; text: string } | null;
  notes: string[];
}

/** Regeln aus der Alt-Instanz auf die Grenzen des Neubaus (Festlegung 5). Jede Änderung wird zur Notiz. */
export function rulesOf(i: LegacyInstance, channelCount: number): Rules {
  const notes: string[] = [];
  const cfg = i.cfg;
  const coinBaseSec = clamp(cfg.coin_base_sec, COIN_MIN, COIN_MAX);
  if (coinBaseSec !== cfg.coin_base_sec) notes.push(`Coin-Basis ${cfg.coin_base_sec} s auf ${coinBaseSec} s begrenzt.`);
  let followMin = Math.max(0, Math.round(cfg.follow_min));
  if (followMin > channelCount) {
    notes.push(`Follow-Bedingung ${followMin} auf die Zahl der Kanäle (${channelCount}) begrenzt.`);
    followMin = channelCount;
  }
  const chatBonus: ChatBonusSettings = { enabled: cfg.chat_enabled, sec: clamp(cfg.chat_bonus_sec, 1, 60), minWords: clamp(cfg.chat_min_words, 1, 20), cooldownSec: clamp(cfg.chat_cooldown, 1, 600) };
  if (chatBonus.sec !== cfg.chat_bonus_sec || chatBonus.minWords !== cfg.chat_min_words || chatBonus.cooldownSec !== cfg.chat_cooldown) {
    notes.push(`Chat-Bonus auf ${chatBonus.sec} s ab ${chatBonus.minWords} Wörtern mit ${chatBonus.cooldownSec} s Pause begrenzt.`);
  }
  const rawKeyword = i.keyword.trim();
  const keyword = KEYWORD_RE.test(rawKeyword) ? rawKeyword : null;
  if (keyword === null && rawKeyword !== '') notes.push(`Keyword „${rawKeyword}“ entfällt (2 bis 32 Zeichen ohne Leerzeichen).`);
  let prize = i.prize?.trim() ?? '';
  if (prize === '') {
    prize = i.name?.trim() || `Altbestand ${i.sessionId}`;
    notes.push(`Gewinn fehlte, übernommen als „${prize}“.`);
  }
  if (prize.length > 200) {
    prize = prize.slice(0, 200);
    notes.push('Gewinn auf 200 Zeichen gekürzt.');
  }
  let sponsor = i.sponsor?.trim() || null;
  if (sponsor !== null && sponsor.length > 200) {
    sponsor = sponsor.slice(0, 200);
    notes.push('Sponsor auf 200 Zeichen gekürzt.');
  }
  let terms: Rules['terms'] = null;
  if (i.termsVersion >= 1) {
    const text = i.termsText?.trim() ?? '';
    if (text === '') notes.push(`Teilnahmebedingungen Fassung ${i.termsVersion} ohne Text, keine Zustimmungsfassung.`);
    else terms = { version: i.termsVersion, text };
  }
  return { coinBaseSec, followMin, chatBonus, keyword, prize, sponsor, terms, notes };
}

async function existingGiveaways(pool: pg.Pool, sessionIds: string[]): Promise<Map<string, string>> {
  if (sessionIds.length === 0) return new Map();
  const r = await pool.query<{ legacy_session_id: string; giveaway_id: string }>('SELECT legacy_session_id, giveaway_id FROM legacy_imports WHERE legacy_session_id = ANY($1)', [sessionIds]);
  return new Map(r.rows.map((x) => [x.legacy_session_id, x.giveaway_id]));
}

async function existingTeam(pool: pg.Pool, legacyTeamId: string): Promise<string | null> {
  const r = await pool.query<{ team_id: string }>('SELECT team_id FROM legacy_teams WHERE legacy_team_id = $1', [legacyTeamId]);
  return r.rows[0]?.team_id ?? null;
}

async function soloTeamOf(pool: pg.Pool, twitchId: string): Promise<{ pid: string; soloTeamId: string | null } | null> {
  const pid = await findPidByTwitchId(pool, twitchId);
  if (pid === null) return null;
  const r = await pool.query<{ solo_team_id: string }>('SELECT solo_team_id FROM accounts WHERE pid = $1 AND NOT deleted', [pid]);
  return { pid, soloTeamId: r.rows[0]?.solo_team_id ?? null };
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export async function runImport(backup: LegacyBackup, o: RunOptions): Promise<RunResult> {
  const now = o.now ?? (() => new Date());
  const result: RunResult = { aborted: null, team: null, giveaways: [], unresolved: [], failed: 0 };

  // 1. Kontrollsumme vor jedem Netzzugriff und vor dem ersten Schreiben (15.7).
  const deviations = checkSums(backup);
  if (deviations.length > 0) {
    const lines = deviations.map((d) => `Giveaway ${d.sessionId}, Kanal ${d.channel}: Datei ${d.fileSum}, Altsystem ${d.pgWatchSum}, Differenz ${d.fileSum - d.pgWatchSum}.`);
    result.aborted = { code: 'checksum', message: ['Die Kontrollsumme weicht ab.', ...lines].join(' ') };
    return result;
  }

  // 2. Logins auflösen, auch im Probelauf.
  const logins = loginsOf(backup);
  let resolved: Map<string, TwitchUser>;
  try {
    resolved = await o.resolver.byLogin(logins);
  } catch (e) {
    result.aborted = { code: 'helix', message: `Twitch antwortet nicht (${errorText(e)}). Der Lauf hat nichts geschrieben.` };
    return result;
  }
  result.unresolved = logins.filter((l) => !resolved.has(l));
  const userOf = (login: string): TwitchUser | null => resolved.get(login) ?? null;

  // 3. Team: Solo oder Team anlegen, vorhandenes nutzen.
  const team = backup.team;
  const members = team.members.map((m) => ({ ...m, user: userOf(m.login) }));
  const resolvedMembers = members.filter((m): m is typeof m & { user: TwitchUser } => m.user !== null);
  const memberChannels = new Set(team.members.map((m) => m.channel));
  const teamReport: TeamReport = {
    legacyTeamId: team.id, name: team.name, kind: team.members.length === 1 ? 'solo' : 'team', teamId: null, outcome: 'skipped',
    bansSkipped: [], membersSkipped: members.filter((m) => m.user === null).map((m) => m.login),
  };
  result.team = teamReport;
  const bannedUsers = team.banned.map((login) => ({ login, user: userOf(login) }));
  teamReport.bansSkipped.push(...bannedUsers.filter((b) => b.user === null).map((b) => b.login));

  if (resolvedMembers.length === 0) {
    teamReport.reason = 'Kein Mitglied ließ sich bei Twitch auflösen.';
  } else if (teamReport.kind === 'solo') {
    const owner = resolvedMembers[0]!.user;
    teamReport.bansSkipped.push(...bannedUsers.filter((b) => b.user !== null).map((b) => b.login));
    const existing = await soloTeamOf(o.pool, owner.id);
    if (existing?.soloTeamId) {
      teamReport.teamId = existing.soloTeamId;
      teamReport.outcome = 'existing';
    } else {
      teamReport.teamId = soloTeamIdOf(owner.id);
      if (o.dryRun) teamReport.outcome = 'would_create';
      else {
        const r = await o.rt.bus.execute(o.accounts.signIn, { pid: existing?.pid ?? randomUUID(), soloTeamId: teamReport.teamId, user: owner }, { actor: MIGRATION, correlationId: randomUUID(), now: now() });
        if (r.ok) teamReport.outcome = 'created';
        else {
          teamReport.outcome = 'skipped';
          teamReport.reason = `${r.rejection.code}: ${r.rejection.message}`;
          teamReport.teamId = null;
        }
      }
    }
  } else {
    const existing = await existingTeam(o.pool, team.id);
    if (existing !== null) {
      teamReport.teamId = existing;
      teamReport.outcome = 'existing';
    } else {
      teamReport.teamId = teamIdOf(team.id);
      if (o.dryRun) teamReport.outcome = 'would_create';
      else {
        const r = await o.rt.bus.execute(
          o.rt.teams.importLegacy,
          { teamId: teamReport.teamId, legacyTeamId: team.id, name: team.name || team.id, members: resolvedMembers.map((m) => m.user), banned: bannedUsers.flatMap((b) => (b.user ? [b.user] : [])) },
          { actor: MIGRATION, correlationId: randomUUID(), now: now() },
        );
        if (r.ok) teamReport.outcome = 'created';
        else {
          teamReport.outcome = 'skipped';
          teamReport.reason = `${r.rejection.code}: ${r.rejection.message}`;
          teamReport.teamId = null;
        }
      }
    }
  }

  // 4. Giveaways.
  const existing = await existingGiveaways(o.pool, backup.instances.map((i) => i.sessionId));
  for (const i of backup.instances) {
    const g = await planGiveaway(i, { userOf, memberChannels, teamId: teamReport.teamId, pool: o.pool });
    const already = existing.get(i.sessionId);
    if (already !== undefined) {
      g.report.outcome = 'skipped';
      g.report.reason = `Als Giveaway ${already} schon übernommen.`;
      g.report.giveawayId = already;
    } else if (teamReport.teamId === null) {
      g.report.outcome = 'skipped';
      g.report.reason = 'Das Team wurde nicht übernommen.';
    } else if (g.cmd === null) {
      g.report.outcome = 'skipped';
    } else if (o.dryRun) {
      g.report.outcome = 'would_create';
    } else {
      try {
        const r = await o.rt.bus.execute(o.rt.handlers.importLegacy, g.cmd, { actor: MIGRATION, correlationId: randomUUID(), now: now() });
        if (r.ok) {
          g.report.outcome = 'created';
          // Identitäten der Kanäle entstehen erst im Befehl: pids für den Bericht nachlesen.
          for (const c of g.report.channels) if (c.pid === null && g.cmd.channels.some((u) => u.login === c.login)) c.pid = await findPidByTwitchId(o.pool, g.cmd.channels.find((u) => u.login === c.login)!.id);
        } else {
          g.report.outcome = 'failed';
          g.report.reason = `${r.rejection.code}: ${r.rejection.message}`;
          result.failed += 1;
        }
      } catch (e) {
        g.report.outcome = 'failed';
        g.report.reason = errorText(e);
        result.failed += 1;
        o.log?.error({ err: e, sessionId: i.sessionId }, 'Die Übernahme eines Giveaways ist fehlgeschlagen. Der Lauf geht weiter.');
      }
    }
    result.giveaways.push(g.report);
  }
  return result;
}

interface PlanDeps {
  userOf(login: string): TwitchUser | null;
  memberChannels: Set<string>;
  teamId: string | null;
  pool: pg.Pool;
}

/** Plant ein Giveaway: Befehl (oder null mit Grund im Bericht) und Bericht mit Sekunden je Kanal. */
async function planGiveaway(i: LegacyInstance, d: PlanDeps): Promise<{ cmd: ImportLegacyGiveawayCmd | null; report: GiveawayReport }> {
  const status: 'paused' | 'closed' = i.open ? 'paused' : 'closed';
  const channelLogins = [...new Set(i.channels)];
  const rules = rulesOf(i, channelLogins.length);
  const report: GiveawayReport = {
    sessionId: i.sessionId, name: i.name, giveawayId: giveawayIdOf(i.sessionId), status, outcome: 'skipped',
    participants: { total: i.participants.length, imported: 0, registered: 0, dropped: 0 }, channels: [], unresolved: [], notes: rules.notes,
  };
  const channels = new Map<string, { user: TwitchUser | null; imported: number; notImported: number }>();
  for (const login of channelLogins) channels.set(login, { user: d.userOf(login), imported: 0, notImported: 0 });
  const missingChannels = channelLogins.filter((l) => channels.get(l)!.user === null);

  const participants: LegacyParticipantCmd[] = [];
  for (const p of i.participants) {
    const user = d.userOf(p.login);
    const perChannel: Record<string, number> = {};
    let seconds = 0;
    for (const [ch, v] of Object.entries(p.perChannel)) {
      const sec = Math.round(v.watchSec);
      const channel = channels.get(ch);
      if (channel === undefined) {
        if (sec >= 1) report.notes.push(`${p.login}: ${sec} s auf dem fremden Kanal ${ch} nicht übernommen.`);
        continue;
      }
      if (user === null || channel.user === null) {
        if (sec >= 1) {
          channel.notImported += sec;
          if (user === null) report.unresolved.push({ login: p.login, channel: ch, sec });
        }
        continue;
      }
      if (sec >= 1) {
        perChannel[channel.user.id] = sec;
        channel.imported += sec;
        seconds += sec;
      }
    }
    if (user === null || (seconds === 0 && !p.registered)) {
      report.participants.dropped += 1;
      continue;
    }
    report.participants.imported += 1;
    if (p.registered) report.participants.registered += 1;
    participants.push({ user, registered: p.registered, perChannel });
  }
  for (const [login, c] of channels) {
    report.channels.push({
      login, pid: c.user === null ? null : await findPidByTwitchId(d.pool, c.user.id), imported: c.imported, pgWatchSum: Math.round(i.pgWatchSum[login] ?? 0),
      notImported: c.notImported, inactive: !d.memberChannels.has(login),
    });
  }
  if (channelLogins.length === 0) {
    report.reason = 'Das Giveaway hat keinen Kanal.';
    return { cmd: null, report };
  }
  if (missingChannels.length > 0) {
    report.reason = `Kanal nicht auflösbar: ${missingChannels.join(', ')}. Die Sekunden ließen sich keinem Kanal zuordnen.`;
    return { cmd: null, report };
  }
  for (const c of report.channels) if (c.inactive) report.notes.push(`Kanal ${c.login} gehört keinem Mitglied und ist inaktiv.`);
  const cmd: ImportLegacyGiveawayCmd = {
    giveawayId: report.giveawayId,
    teamId: d.teamId ?? '',
    legacySessionId: i.sessionId,
    prize: rules.prize,
    sponsor: rules.sponsor,
    keyword: rules.keyword,
    coinBaseSec: rules.coinBaseSec,
    followMin: rules.followMin,
    chatBonus: rules.chatBonus,
    channels: channelLogins.map((l) => channels.get(l)!.user!),
    status,
    terms: rules.terms,
    participants,
  };
  return { cmd, report };
}
