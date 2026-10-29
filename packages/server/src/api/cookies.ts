// Cookies von Hand: ein Sitzungs-Cookie und ein OAuth-Cookie brauchen kein Plugin.

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const name = part.slice(0, i).trim();
    if (!name) continue;
    try {
      out[name] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      // Ungültig kodiert: Cookie ignorieren.
    }
  }
  return out;
}

export interface CookieOptions {
  /** 0 löscht das Cookie. */
  maxAgeSec?: number;
  secure: boolean;
  path?: string;
}

export function serializeCookie(name: string, value: string, o: CookieOptions): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${o.path ?? '/'}`, 'HttpOnly', 'SameSite=Lax'];
  if (o.maxAgeSec !== undefined) parts.push(`Max-Age=${o.maxAgeSec}`);
  if (o.secure) parts.push('Secure');
  return parts.join('; ');
}
