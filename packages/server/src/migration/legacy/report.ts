// Bericht eines Laufs (NEW_DESIGN.md 15.6): reiner Text neben der Datei und auf der Konsole. Enthält Logins, darum nach 30 Tagen löschen.
import type { GiveawayReport, RunResult, TeamReport } from './run.js';

export function reportPathOf(file: string): string {
  return `${file}.bericht.txt`;
}

const OUTCOME: Record<string, string> = {
  created: 'angelegt',
  existing: 'vorhanden, genutzt',
  skipped: 'übersprungen',
  would_create: 'würde anlegen',
  failed: 'fehlgeschlagen',
};

const STATUS: Record<'paused' | 'closed', string> = { paused: 'Pausiert', closed: 'Geschlossen' };

function teamLines(t: TeamReport): string[] {
  const out = [`Team ${t.legacyTeamId} „${t.name}“ (${t.kind === 'solo' ? 'Solo-Team' : 'Team'}): ${OUTCOME[t.outcome]}${t.teamId ? `, ID ${t.teamId}` : ''}${t.reason ? `. ${t.reason}` : ''}`];
  if (t.membersSkipped.length > 0) out.push(`  Mitglieder nicht auflösbar: ${t.membersSkipped.join(', ')}`);
  if (t.bansSkipped.length > 0) out.push(`  Sperren nicht übernommen (${t.kind === 'solo' ? 'Solo-Team hat keine Sperrliste' : 'Login nicht auflösbar'}): ${t.bansSkipped.join(', ')}`);
  return out;
}

function giveawayLines(g: GiveawayReport): string[] {
  const out = [`Giveaway ${g.sessionId} „${g.name ?? ''}“ → ${g.giveawayId}: ${OUTCOME[g.outcome]}, Zustand ${STATUS[g.status]}${g.reason ? `. ${g.reason}` : ''}`];
  const p = g.participants;
  out.push(`  Teilnehmer: ${p.total} gesamt, ${p.imported} übernommen, davon ${p.registered} angemeldet, ${p.dropped} ohne Zeit und Anmeldung oder nicht auflösbar`);
  for (const c of g.channels) {
    out.push(`  Kanal ${c.login}${c.inactive ? ' (inaktiv, kein Mitglied)' : ''}: ${c.imported} s übernommen, Altsystem ${c.pgWatchSum} s, nicht übernommen ${c.notImported} s`);
  }
  for (const u of g.unresolved) out.push(`  Nicht auflösbar: ${u.login}, ${u.sec} s auf ${u.channel}`);
  for (const n of g.notes) out.push(`  Hinweis: ${n}`);
  return out;
}

export function renderReport(file: string, dryRun: boolean, at: Date, r: RunResult): string {
  const lines: string[] = [];
  lines.push(`Übernahme des Altbestands – ${dryRun ? 'Probelauf, nichts geschrieben' : 'Lauf'}`);
  lines.push(`Datei: ${file}`);
  lines.push(`Zeit: ${at.toISOString()}`);
  lines.push('');
  if (r.aborted) {
    lines.push(`Abbruch (${r.aborted.code === 'checksum' ? 'Kontrollsumme' : 'Twitch'}): ${r.aborted.message}`);
    lines.push('Es wurde nichts geschrieben.');
    return `${lines.join('\n')}\n`;
  }
  if (r.team) lines.push(...teamLines(r.team));
  lines.push('');
  for (const g of r.giveaways) {
    lines.push(...giveawayLines(g));
    lines.push('');
  }
  if (r.unresolved.length > 0) lines.push(`Logins, die Twitch nicht kennt: ${r.unresolved.join(', ')}`);
  const count = (outcome: GiveawayReport['outcome']) => r.giveaways.filter((g) => g.outcome === outcome).length;
  const imported = r.giveaways.reduce((sum, g) => sum + g.channels.reduce((s, c) => s + c.imported, 0), 0);
  const notImported = r.giveaways.reduce((sum, g) => sum + g.channels.reduce((s, c) => s + c.notImported, 0), 0);
  lines.push(`Giveaways: ${r.giveaways.length} gesamt, ${count('created')} angelegt, ${count('would_create')} würde anlegen, ${count('skipped')} übersprungen, ${count('failed')} fehlgeschlagen`);
  lines.push(`Sekunden: ${imported} übernommen, ${notImported} nicht übernommen`);
  lines.push('Dieser Bericht enthält Logins. Lösche ihn nach 30 Tagen.');
  return `${lines.join('\n')}\n`;
}
