import { isHttpError, isRedirect } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, apiOf, loadOrRedirect } from './client.js';

function fetchStub(status: number, body?: unknown) {
  return vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () =>
    new Response(body === undefined ? null : JSON.stringify(body), { status, headers: body === undefined ? {} : { 'content-type': 'application/json' } }),
  );
}

describe('api client', () => {
  it('post sends JSON content-type only with a body', async () => {
    const f = fetchStub(200, { events: [] });
    const api = apiOf(f as unknown as typeof fetch);
    await api.post('/api/giveaways/x/open');
    const [, initNoBody] = f.mock.calls[0]!;
    expect(new Headers(initNoBody?.headers).has('content-type')).toBe(false);
    expect(initNoBody?.body).toBeUndefined();
    await api.post('/api/giveaways', { teamId: 't' });
    const [, initBody] = f.mock.calls[1]!;
    expect(new Headers(initBody?.headers).get('content-type')).toBe('application/json');
    expect(initBody?.body).toBe(JSON.stringify({ teamId: 't' }));
    expect(initBody?.credentials).toBe('same-origin');
  });

  it('maps {code,message} errors to ApiError with status; 204 → undefined; get parses JSON', async () => {
    const api = apiOf(fetchStub(400, { code: 'not_open', message: 'Das Giveaway ist nicht offen.' }) as unknown as typeof fetch);
    const err = await api.post('/api/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 400, code: 'not_open', message: 'Das Giveaway ist nicht offen.' });
    const noBody = apiOf(fetchStub(502) as unknown as typeof fetch);
    const err2 = (await noBody.get('/api/x').catch((e: unknown) => e)) as ApiError;
    expect(err2.code).toBe('http_error');
    expect(err2.status).toBe(502);
    expect(err2.message.length).toBeGreaterThan(0);
    expect(await apiOf(fetchStub(204) as unknown as typeof fetch).del('/api/me')).toBeUndefined();
    expect(await apiOf(fetchStub(200, { pid: 'p' }) as unknown as typeof fetch).get('/api/me')).toEqual({ pid: 'p' });
  });

  it('loadOrRedirect turns 401 into redirect(303, "/?return=…") and 403 into error(403, message)', async () => {
    const url = new URL('https://g.example/giveaways/abc?x=1');
    const r = await loadOrRedirect(Promise.reject(new ApiError(401, 'no_session', 'Melde dich an.')), url).catch((e: unknown) => e);
    expect(isRedirect(r)).toBe(true);
    expect(r).toMatchObject({ status: 303, location: '/?return=%2Fgiveaways%2Fabc%3Fx%3D1' });
    const e = await loadOrRedirect(Promise.reject(new ApiError(403, 'not_your_team', 'Fremdes Team.')), url).catch((x: unknown) => x);
    expect(isHttpError(e)).toBe(true);
    expect(e).toMatchObject({ status: 403, body: { message: 'Fremdes Team.' } });
    expect(await loadOrRedirect(Promise.resolve(42), url)).toBe(42);
  });
});
