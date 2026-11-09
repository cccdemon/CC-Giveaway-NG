import { isRedirect } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';
import type { Me } from '#lib/api/types.js';
import { load } from './+page.js';

const me: Me = { pid: 'a1', login: 'alice', displayName: 'Alice', soloTeamId: 's', termsVersion: 1, currentTermsVersion: 1, channelConnected: false, legal: { impressumUrl: null, terms: null, privacyUrl: null } };
const GID = '66666666-6666-4666-8666-666666666661';
const pub = { id: GID, prize: 'Key', sponsor: null, kernel: { id: 'instant', label: 'Sofortverlosung', display: {}, commands: [] }, status: 'paused', channels: [], keyword: null, legal: null, claimDays: 14, counting: 'registered', winnersCount: 1 };

function fetchOf(portalStatus: number) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith('/api/portal/')) return new Response(portalStatus === 200 ? JSON.stringify({ ...pub, registered: false }) : JSON.stringify({ code: 'giveaway_not_found', message: 'Nein.' }), { status: portalStatus, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify(pub), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
}

describe('öffentliche Giveaway-Seite', () => {
  it('shows the public view to a logged-in viewer when the portal has nothing for them (paused, not involved)', async () => {
    const result = await load({ parent: async () => ({ me }), fetch: fetchOf(404), url: new URL(`https://g.example/g/${GID}`), params: { id: GID } } as never);
    expect(result).toMatchObject({ giveaway: { id: GID, status: 'paused' } });
  });

  it('redirects a logged-in viewer into the portal when the portal detail exists', async () => {
    const thrown = await Promise.resolve(load({ parent: async () => ({ me }), fetch: fetchOf(200), url: new URL(`https://g.example/g/${GID}`), params: { id: GID } } as never)).catch((e: unknown) => e);
    expect(isRedirect(thrown)).toBe(true);
    expect(thrown).toMatchObject({ location: `/portal/giveaways/${GID}` });
  });
});
