import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KernelInfo, Me, TeamList } from '#lib/api/types.js';
import { L } from '#lib/texts/labels.js';
import Page from './+page.svelte';

const me: Me = {
  pid: 'a1a1a1a1-0000-4000-8000-000000000001',
  login: 'alice',
  displayName: 'Alice',
  soloTeamId: 'solo-1',
  termsVersion: 1,
  currentTermsVersion: 1,
  channelConnected: true,
  legal: { impressumUrl: 'https://x/i', terms: { text: 'Regeln.' }, privacyUrl: 'https://x/p' },
  admin: false,
  banned: null,
  warnings: [],
};
const instant: KernelInfo = {
  id: 'instant',
  label: 'Sofortverlosung',
  version: 1,
  display: { icon: '⚡', unit: null, beta: true, emptyPool: 'Niemand ist angemeldet.', columns: [] },
  configSchema: { windowSec: { kind: 'int', label: 'Fensterlänge', help: 'So lange ist das Fenster offen.', default: 120, min: 10, max: 3600, unit: 'sec' } },
  supportedGates: ['follow', 'account_age'],
  usesServices: ['registration'],
  drawMode: 'equal',
  commands: [],
};
const teams: TeamList = { solo: { teamId: 'solo-1' }, teams: [] };
const GID = '66666666-6666-4666-8666-666666666661';

describe('Start-Assistent', () => {
  afterEach(() => vi.restoreAllMocks());

  it('keeps the rejection of „Prüfen und öffnen“ visible with a link to the saved draft', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === '/api/giveaways' && init?.method === 'POST') return new Response(JSON.stringify({ giveawayId: GID, events: [] }), { status: 201, headers: { 'content-type': 'application/json' } });
      if (url === `/api/giveaways/${GID}/open`) return new Response(JSON.stringify({ code: 'legal_required', message: 'Hinterlege zuerst: Impressum.' }), { status: 400, headers: { 'content-type': 'application/json' } });
      return new Response(null, { status: 500 });
    });
    render(Page, { props: { data: { me, kernels: [instant], teams, members: { 'solo-1': [{ pid: me.pid, displayName: 'Alice' }] } } } as never });
    await fireEvent.click(screen.getByRole('radio', { name: /Sofortverlosung/ }));
    const next = () => fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${L.actions.next}`) }));
    await next();
    await fireEvent.input(screen.getByLabelText(L.fields.prize, { exact: true }), { target: { value: 'E2E-Preis' } });
    await next();
    await next();
    await next();
    await next();
    await fireEvent.click(screen.getByRole('button', { name: L.actions.openNow }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Hinterlege zuerst: Impressum.'));
    expect(screen.getByRole('link', { name: L.actions.toDetail })).toHaveAttribute('href', `/giveaways/${GID}`);
    expect(screen.getByRole('button', { name: L.actions.openNow })).toBeDisabled();
  });
});
