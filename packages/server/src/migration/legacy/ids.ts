// Deterministische IDs für die Übernahme (Teilprojekt 9, Festlegung 2): ein zweiter Lauf trifft dieselben Ströme.
import { uuidV5 } from '../../shared/uuid.js';

export const NS_GIVEAWAY = '7a1d5a52-9f3c-4b8e-9e55-0c1b2d3e4f01';
export const NS_TEAM = '7a1d5a52-9f3c-4b8e-9e55-0c1b2d3e4f02';
export const NS_SOLO = '7a1d5a52-9f3c-4b8e-9e55-0c1b2d3e4f03';

/** Giveaway-ID aus der Session-ID des Altsystems (sess_…). */
export const giveawayIdOf = (sessionId: string): string => uuidV5(NS_GIVEAWAY, sessionId);
/** Team-ID eines Mehrpersonen-Teams aus der Team-ID des Altsystems. */
export const teamIdOf = (legacyTeamId: string): string => uuidV5(NS_TEAM, legacyTeamId);
/** Solo-Team-ID eines Kontos, das die Übernahme anlegt, aus der Twitch-ID. */
export const soloTeamIdOf = (twitchId: string): string => uuidV5(NS_SOLO, twitchId);
