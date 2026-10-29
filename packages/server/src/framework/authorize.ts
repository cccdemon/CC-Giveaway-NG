// Rechte-Helfer, die jeder Strom nutzt. Giveaway-spezifisches steht in giveaway/authorize.ts.
import type { Actor } from '../journal/types.js';
import { reject, type Rejection } from '../shared/rejection.js';

/** Wie z.uuid() im Ereignisschema: Version 1–8, Variante 8–b. */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const INVALID_ID = (): Rejection => reject('invalid_id', 'Die ID ist keine gültige UUID.');

/** Befehle über die eigene Person: nur der Akteur `user:<pid>` selbst. pid muss eine UUID sein. */
export function authorizeSelf(pid: unknown, actor: Actor, text = 'Du kannst nur dich selbst anmelden oder abmelden.'): Rejection | null {
  if (typeof pid !== 'string' || !UUID_RE.test(pid)) return INVALID_ID();
  if (actor === `user:${pid}`) return null;
  return reject('not_you', text);
}

/** pid aus einem Nutzer-Akteur, sonst null. */
export function pidOfActor(actor: Actor): string | null {
  return actor.startsWith('user:') && UUID_RE.test(actor.slice(5)) ? actor.slice(5) : null;
}
