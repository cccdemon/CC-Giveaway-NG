// Server-Rendern: Anfragen an /api/* gehen an den Fastify-Prozess (API_URL), das Sitzungs-Cookie der Seitenanfrage geht mit.
// Im Browser ruft die Seite /api/* same-origin, im Dev-Modus leitet Vite weiter, in Produktion Caddy (Teilprojekt 10).
import type { HandleFetch } from '@sveltejs/kit/hooks';

const API_URL = (process.env.API_URL ?? 'http://localhost:3000').replace(/\/+$/, '');

export const handleFetch: HandleFetch = ({ event, request, fetch }) => {
  const url = new URL(request.url);
  if (url.origin !== event.url.origin || !url.pathname.startsWith('/api/')) return fetch(request);
  const target = `${API_URL}${url.pathname}${url.search}`;
  const headers = new Headers(request.headers);
  const cookie = event.request.headers.get('cookie');
  if (cookie) headers.set('cookie', cookie);
  // Der Server sieht die echte Adresse der Person für das Zugriffslog, nicht die der Web-App.
  headers.set('x-forwarded-for', event.getClientAddress());
  return fetch(new Request(target, { method: request.method, headers, body: request.body, ...(request.body ? { duplex: 'half' } : {}) } as RequestInit));
};
