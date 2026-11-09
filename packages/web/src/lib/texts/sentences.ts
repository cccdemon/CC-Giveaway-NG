// Ganze Sätze: Hinweise, Fehler, Erklärungen. Aktiv, höchstens 20 Wörter, Fehler = was passiert ist + was zu tun ist (NEW_DESIGN.md 11.6).
// Der Text-Linter prüft jede Zeichenkette dieser Datei mit checkText (lint:text). Vorlagen sind Funktionen mit Template-Literalen.

export const S = {
  noSession: 'Melde dich an.',
  serverError: 'Der Server antwortet nicht. Versuche es gleich noch einmal.',
  reconnecting: 'Die Live-Verbindung ist weg. Die Seite verbindet neu.',
  reasonRequired: 'Gib einen Grund an.',
  startTitle: 'Giveaways für Twitch.',
  startForStreamers: 'Du streamst? Melde dich an, verbinde deinen Kanal und starte ein Giveaway.',
  startForViewers: 'Du schaust zu? Melde dich an und sieh deine Teilnahmen, deine Chance und deine Daten.',
  errorTitle: (status: number) => `Fehler ${status}.`,
  notFound: 'Diese Seite gibt es nicht. Prüfe den Link.',
  chanceHint: 'Chance = eigenes Gewicht geteilt durch alle Gewichte im Topf. Sie ändert sich bis zur Ziehung.',
  streamerModeHint: 'Der Streamermodus maskiert Namen von Teilnehmern. Kanalnamen bleiben sichtbar.',
  activity: {
    draft: 'Entwurf. Noch nicht geöffnet.',
    open: 'Sammelt Signale.',
    paused: 'Pausiert. Zählt nichts.',
    closed: 'Wartet auf die Ziehung.',
    drawn: 'Gewinner melden sich.',
    completed: 'Abgeschlossen.',
    cancelled: 'Abgebrochen. Keine Ziehung.',
    drawing: 'Prüft Bedingungen bei Twitch.',
  },
} as const;
