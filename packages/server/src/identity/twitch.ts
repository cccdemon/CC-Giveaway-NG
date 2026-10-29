// Twitch-OAuth (NEW_DESIGN.md 9.2, 10.2). Der Client folgt in Teilprojekt 3, Aufgabe 3.

/** Scopes für „Kanal verbinden“ (NEW_DESIGN.md 9.2). */
export const REQUIRED_CHANNEL_SCOPES = ['moderator:read:followers', 'moderator:read:chatters', 'channel:bot'] as const;
