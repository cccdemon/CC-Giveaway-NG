// Lebenszeichen der Web-App für den Healthcheck in Compose (NEW_DESIGN.md 12.3), ohne API-Aufruf.
import type { RequestHandler } from './$types';

export const GET: RequestHandler = () => new Response('ok', { headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' } });
