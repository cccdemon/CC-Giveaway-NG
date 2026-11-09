// Ein Befehl aus einer Route: läuft über den Bus mit der Sitzung als Akteur und antwortet mit den geschriebenen Ereignissen.
import { randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { CommandHandler } from '../framework/command-bus.js';
import type { ApiDeps } from './auth.js';
import { rejectionToHttp } from './http.js';

export interface EventRef {
  id: string;
  seq: number;
  type: string;
}

export async function executeAs<C, S, P, Q>(
  deps: ApiDeps,
  req: FastifyRequest,
  reply: FastifyReply,
  h: CommandHandler<C, S, P, Q>,
  cmd: C,
  status = 200,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const now = deps.now ?? (() => new Date());
  const r = await deps.rt.bus.execute(h, cmd, { actor: `user:${req.session!.pid}`, correlationId: randomUUID(), now: now(), ip: req.ip });
  if (!r.ok) {
    const e = rejectionToHttp(r.rejection);
    await reply.code(e.status).send(e.body);
    return;
  }
  const events: EventRef[] = r.events.map((e) => ({ id: e.id, seq: e.seq, type: e.type }));
  await reply.code(status).send({ ...extra, events });
}

/** Body als Teilobjekt, fehlender oder fremder Body als leeres Objekt. */
export function bodyOf<T>(req: FastifyRequest): Partial<T> {
  return typeof req.body === 'object' && req.body !== null ? (req.body as Partial<T>) : {};
}
