// Chat-Ansagen (NEW_DESIGN.md 10.3): Katalog je Kern filtern, Vorlagen prüfen wie der Server (announcements.ts im Server).
// Rein, ohne I/O.
import type { AnnouncementKind, AnnouncementSettings } from './api/types.js';
import { L } from './texts/labels.js';
import { S } from './texts/sentences.js';

export const TEMPLATE_MAX = 400;
export const EMPTY_ANNOUNCEMENTS: AnnouncementSettings = { muted: false, links: true, texts: {} };

const LINK_RE = /https?:\/\//i;
const PLACEHOLDER_RE = /\{[^{}]*\}/g;

/** Arten des Rahmens plus die Arten des gewählten Kerns, in Katalogreihenfolge. */
export function kindsForKernel(kinds: AnnouncementKind[], kernelId: string | null): AnnouncementKind[] {
  return kinds.filter((k) => k.kernel === null || k.kernel === kernelId);
}

/** Beschriftung einer Art; unbekannte Arten zeigen ihren Schlüssel. */
export function kindLabel(kind: string): string {
  return (L.announcements.kinds as Record<string, string>)[kind] ?? kind;
}

/** Fehler je Art (leer = in Ordnung). Ohne Katalog bleibt die Platzhalter-Prüfung aus, Link und Länge gelten immer. */
export function validateAnnouncements(a: AnnouncementSettings, kinds: AnnouncementKind[], kernelId: string | null): Record<string, string> {
  const e: Record<string, string> = {};
  const allowed = new Map(kindsForKernel(kinds, kernelId).map((k) => [k.kind, k.placeholders]));
  for (const [kind, raw] of Object.entries(a.texts)) {
    const text = raw.trim();
    if (text === '') {
      if (kind === 'winner') e[kind] = S.announcements.winnerRequired;
      continue;
    }
    if (text.length > TEMPLATE_MAX) {
      e[kind] = S.wizard.tooLong(TEMPLATE_MAX);
      continue;
    }
    if (LINK_RE.test(text)) {
      e[kind] = S.announcements.noLinks;
      continue;
    }
    const ok = allowed.get(kind);
    if (!ok) continue;
    const bad = (text.match(PLACEHOLDER_RE) ?? []).find((ph) => !ok.includes(ph));
    if (bad) e[kind] = S.announcements.unknownPlaceholder(bad, ok.join(' '));
  }
  return e;
}

/** Leere Vorlagen fallen weg, Texte werden getrimmt: so geht es an den Server. */
export function cleanAnnouncements(a: AnnouncementSettings): AnnouncementSettings {
  const texts: Record<string, string> = {};
  for (const [kind, raw] of Object.entries(a.texts)) {
    const text = raw.trim();
    if (text !== '') texts[kind] = text;
  }
  return { muted: a.muted, links: a.links, texts };
}
