// Ablehnungen des Command-Bus als HTTP-Antworten.
import type { Rejection } from '../shared/rejection.js';

export interface HttpError {
  status: number;
  body: { code: string; message: string };
}

const FORBIDDEN = new Set(['not_you', 'no_accounts', 'not_your_team']);
const NOT_FOUND = new Set(['no_account']);

export function rejectionToHttp(r: Rejection): HttpError {
  let status = 400;
  if (r.code === 'no_session') status = 401;
  else if (FORBIDDEN.has(r.code)) status = 403;
  else if (NOT_FOUND.has(r.code) || r.code.endsWith('_not_found')) status = 404;
  return { status, body: { code: r.code, message: r.message } };
}

export const NO_SESSION: HttpError = { status: 401, body: { code: 'no_session', message: 'Melde dich an.' } };
