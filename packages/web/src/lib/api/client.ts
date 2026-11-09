// Der eine Weg zur API (NEW_DESIGN.md 3.4: web spricht nur mit api). Same-origin /api/*, Cookie der Sitzung geht mit.
import { error, redirect } from '@sveltejs/kit';
import { S } from '../texts/sentences.js';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface Api {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  put<T>(path: string, body: unknown): Promise<T>;
  del<T>(path: string): Promise<T>;
}

async function toError(res: Response): Promise<ApiError> {
  try {
    const body = (await res.json()) as { code?: unknown; message?: unknown };
    if (typeof body.code === 'string' && typeof body.message === 'string') return new ApiError(res.status, body.code, body.message);
  } catch {
    // kein JSON
  }
  return new ApiError(res.status, 'http_error', S.serverError);
}

/** Client über eine fetch-Funktion: in load die von SvelteKit (Server-Rendern reicht das Cookie weiter), im Browser globalThis.fetch. */
export function apiOf(fetchFn: typeof fetch): Api {
  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const init: RequestInit = { method, credentials: 'same-origin', headers: { accept: 'application/json' } };
    // Fastify lehnt einen leeren JSON-Body ab: content-type nur, wenn ein Body mitgeht.
    if (body !== undefined) {
      init.headers = { ...init.headers, 'content-type': 'application/json' };
      init.body = JSON.stringify(body);
    }
    const res = await fetchFn(path, init);
    if (!res.ok) throw await toError(res);
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  };
  return {
    get: (path) => call('GET', path),
    post: (path, body) => call('POST', path, body),
    put: (path, body) => call('PUT', path, body),
    del: (path) => call('DELETE', path),
  };
}

/** Nur relative Pfade innerhalb der Seite. */
export function safeReturnPath(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return null;
  return raw;
}

export const returnTo = (url: { pathname: string; search: string }): string => `${url.pathname}${url.search}`;

/** Für load: 401 leitet zur Anmeldung mit Rücksprung, andere Ablehnungen werden zur Fehlerseite mit dem Text des Servers. */
export async function loadOrRedirect<T>(p: Promise<T>, url: URL): Promise<T> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof ApiError) {
      if (e.status === 401) redirect(303, `/?return=${encodeURIComponent(returnTo(url))}`);
      error(e.status, e.message);
    }
    throw e;
  }
}
