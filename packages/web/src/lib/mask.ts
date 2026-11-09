// Streamermodus (NEW_DESIGN.md 11.1): maskiert Teilnehmer-Namen in jeder Ansicht. Kanalnamen sind Streamer und bleiben.
import { persisted } from './storage.js';

export const STREAMER_MODE_KEY = 'ccg.streamerMode';

export const streamerMode = persisted<boolean>(STREAMER_MODE_KEY, false, (raw) => raw === '1', (v) => (v ? '1' : '0'));

/** Ersatzname aus der pid, stabil je Person, ohne Rückschluss auf Twitch. */
export function maskName(pid: string): string {
  return `Teilnehmer ·${pid.slice(0, 4)}`;
}
