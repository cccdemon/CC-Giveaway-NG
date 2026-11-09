// Live-Push per WebSocket (NEW_DESIGN.md 3.2, 11): Oberflächen abonnieren Ströme und laden bei jedem Ereignis neu.
// Nachrichten tragen keine Payloads, nur stream, seq, type, id, at. Rechte je Strom wie bei den Lese-Routen.
import '@fastify/websocket';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import type { WebSocket } from 'ws';
import { loadGiveawayRow } from '../framework/giveaway/authorize.js';
import type { EventRecord, StreamId } from '../journal/types.js';
import type { ApiDeps } from './auth.js';
import { sessionOf } from './session.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** Alle offenen Live-Verbindungen, für das Schließen beim Redis-Ausfall. */
    wsSockets: Set<WebSocket>;
  }
}

export const WS_PING_MS = 30_000;
/** Größte Client-Nachricht. Abos sind wenige hundert Byte. */
export const WS_MAX_PAYLOAD = 16 * 1024;
export const WS_CLOSE_NO_SESSION = 4401;
export const WS_CLOSE_SERVICE_RESTART = 1012;

const STREAM_RE = /^(giveaway|team):([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

type Outgoing =
  | { subscribed: StreamId[] }
  | { unsubscribed: StreamId[] }
  | { error: { code: string; message: string; stream: string | null } }
  | { event: { stream: StreamId; seq: number; type: string; id: string; at: string } };

const INVALID_MESSAGE: Outgoing = { error: { code: 'invalid_message', message: 'Die Nachricht ist kein gültiges JSON-Objekt.', stream: null } };
const invalidStream = (stream: string): Outgoing => ({ error: { code: 'invalid_stream', message: 'Dieser Verlauf ist unbekannt.', stream } });
const notAllowed = (stream: string): Outgoing => ({ error: { code: 'not_allowed', message: 'Diesen Verlauf darfst du nicht abonnieren.', stream } });

export function registerWsRoutes(app: FastifyInstance, deps: ApiDeps, pool: pg.Pool): void {
  const now = deps.now ?? (() => new Date());
  const subscriber = deps.subscriber;
  if (!subscriber) return;

  /** Darf diese Person den Strom sehen? Team: Mitglied. Giveaway: Mitglied, Beteiligte oder Offen (Festlegung 9). */
  const allowed = async (pid: string, kind: string, id: string): Promise<boolean> => {
    const c = await pool.connect();
    try {
      const actor = `user:${pid}`;
      if (kind === 'team') return (await deps.auth.controls(c, actor, id)) === null;
      const row = await loadGiveawayRow(c, id);
      if (!row) return false;
      if ((await deps.auth.controls(c, actor, row.teamId)) === null) return true;
      const part = await c.query('SELECT 1 FROM giveaway_participants WHERE giveaway_id = $1 AND pid = $2', [id, pid]);
      return (part.rowCount ?? 0) > 0 || row.status === 'open';
    } finally {
      c.release();
    }
  };

  app.get('/ws', { websocket: true }, (socket: WebSocket, req: FastifyRequest) => {
    // Handler sofort anhängen: eine Nachricht, die während der Sitzungsprüfung eintrifft, darf nicht verloren gehen.
    const sessionReady = sessionOf(req, pool, now()).then((session) => {
      if (!session) socket.close(WS_CLOSE_NO_SESSION, 'no_session');
      return session;
    });
    app.wsSockets.add(socket);
    const subs = new Map<StreamId, () => void>();
    const send = (m: Outgoing) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(m));
    };
    const onEvents = (stream: StreamId) => (events: EventRecord[]) => {
      for (const e of events) send({ event: { stream, seq: e.seq, type: e.type, id: e.id, at: e.createdAt.toISOString() } });
    };
    const ping = setInterval(() => {
      if (socket.readyState === socket.OPEN) socket.ping();
    }, WS_PING_MS);
    ping.unref?.();

    const handle = async (raw: unknown): Promise<void> => {
        const session = await sessionReady;
        if (!session) return;
        let m: unknown;
        try {
          m = JSON.parse(String(raw));
        } catch {
          return send(INVALID_MESSAGE);
        }
        if (typeof m !== 'object' || m === null || Array.isArray(m)) return send(INVALID_MESSAGE);
        const { subscribe, unsubscribe } = m as { subscribe?: unknown; unsubscribe?: unknown };
        if (Array.isArray(subscribe)) {
          const ok: StreamId[] = [];
          for (const stream of subscribe) {
            const match = typeof stream === 'string' ? STREAM_RE.exec(stream) : null;
            if (!match) {
              send(invalidStream(String(stream)));
              continue;
            }
            if (subs.has(stream as string)) {
              ok.push(stream as string);
              continue;
            }
            if (!(await allowed(session.pid, match[1]!, match[2]!))) {
              send(notAllowed(stream as string));
              continue;
            }
            // Während der Prüfung kann die Verbindung zugegangen sein: dann keinen Listener mehr anlegen (sonst Leck).
            if (socket.readyState !== socket.OPEN) return;
            if (subs.has(stream as string)) {
              ok.push(stream as string);
              continue;
            }
            subs.set(stream as string, subscriber.subscribe(stream as string, onEvents(stream as string)));
            ok.push(stream as string);
          }
          if (ok.length > 0) send({ subscribed: ok });
        }
        if (Array.isArray(unsubscribe)) {
          const gone: StreamId[] = [];
          for (const stream of unsubscribe) {
            const stop = typeof stream === 'string' ? subs.get(stream) : undefined;
            if (!stop) continue;
            stop();
            subs.delete(stream as string);
            gone.push(stream as string);
          }
          if (gone.length > 0) send({ unsubscribed: gone });
        }
    };
    // Nachrichten je Verbindung nacheinander: zwei schnelle Abos desselben Stroms dürfen nur einen Listener anlegen.
    let chain: Promise<void> = Promise.resolve();
    socket.on('message', (raw) => {
      chain = chain.then(() => handle(raw)).catch(() => undefined);
    });

    socket.on('close', () => {
      clearInterval(ping);
      for (const stop of subs.values()) stop();
      subs.clear();
      app.wsSockets.delete(socket);
    });
    socket.on('error', () => {
      // Ein Fehler löst auch close aus. Nichts zu tun, nur kein ungefangener Fehler.
    });
  });
}

export function registerNoPush(app: FastifyInstance): void {
  app.get('/ws', async (_req: FastifyRequest, reply: FastifyReply) =>
    reply.code(503).send({ code: 'no_push', message: 'Live-Aktualisierung ist in diesem Prozess nicht verfügbar.' }),
  );
}

/** Schließt alle Live-Verbindungen, z. B. beim Redis-Ausfall. Die Oberflächen verbinden neu. */
export function closeAllSockets(app: FastifyInstance, code = WS_CLOSE_SERVICE_RESTART, reason = 'restart'): number {
  let n = 0;
  for (const s of app.wsSockets) {
    s.close(code, reason);
    n += 1;
  }
  return n;
}
