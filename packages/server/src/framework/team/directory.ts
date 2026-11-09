// Lese-Schnittstellen des Rahmens zu Teams. Die Umsetzung über Lesetabellen liegt in identity/team-directory.ts.
import type { Queryable } from '../../db/pool.js';
import type { Pid } from '../../kernel-api/index.js';

/** Kanäle eines Teams = pids seiner Mitglieder, beim Solo-Team die eigene pid. null = unbekanntes Team. */
export type TeamChannels = { channels: Set<Pid>; active: boolean } | null;

export interface TeamDirectory {
  channelsOf(db: Queryable, teamId: string): Promise<TeamChannels>;
}

/** Kein Verzeichnis: keine Prüfung der Kanäle (Tests, Systemprozesse ohne Konten). */
export const anyChannels: TeamDirectory = { channelsOf: async () => null };

/** Team-weite Sperren (NEW_DESIGN.md 15.3). */
export interface BanDirectory {
  bannedOf(db: Queryable, teamId: string): Promise<Set<Pid>>;
}

export const noBans: BanDirectory = { bannedOf: async () => new Set() };
