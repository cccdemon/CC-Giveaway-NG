import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import type { GiveawayDetail, HistoryPage, Me } from '#lib/api/types.js';
import { L } from '#lib/texts/labels.js';
import Page from './+page.svelte';
import { load } from './+page.js';

const me: Me = { pid: 'a1a1a1a1-0000-4000-8000-000000000001', login: 'alice', displayName: 'Alice', soloTeamId: 'solo-1', termsVersion: 1, currentTermsVersion: 1, channelConnected: true, legal: { impressumUrl: null, terms: null, privacyUrl: null } };

function detailOf(): GiveawayDetail {
  return {
    id: '66666666-6666-4666-8666-666666666661',
    teamId: 'solo-1',
    kernel: {
      id: 'instant',
      label: 'Sofortverlosung',
      version: 1,
      display: { icon: '⚡', unit: null, beta: true, emptyPool: 'Niemand ist angemeldet.', columns: [] },
      configSchema: { windowSec: { kind: 'int', label: 'Fensterlänge', help: 'So lange ist das Fenster offen.', default: 120, min: 10, max: 3600, unit: 'sec' } },
      supportedGates: ['follow', 'account_age'],
      usesServices: ['registration'],
      drawMode: 'equal',
      commands: [{ type: 'open_window', label: 'Anmeldefenster öffnen', issuer: 'streamer' }],
    },
    status: 'draft',
    settings: {
      config: { windowSec: 120 },
      prize: 'Key',
      sponsor: null,
      channels: [me.pid],
      winnersCount: 1,
      claimDays: 14,
      gates: [],
      legal: null,
      contact: null,
      counting: 'registered',
      purgeDays: 7,
      keyword: null,
      chatBonus: { enabled: true, sec: 2, minWords: 4, cooldownSec: 10 },
    },
    legal: null,
    legalEventId: null,
    boost: null,
    pool: { size: 0, weight: 0 },
    registeredCount: 0,
    winners: [],
    draws: [],
    channels: [{ pid: me.pid, displayName: 'Alice', connected: true, tokenStatus: 'ok', live: false, liveSince: null, viewers: null, chatters: null, coverage: null, lastSignalAt: null, problem: null, warning: null }],
    drawnAt: null,
    draw: null,
    closedAt: null,
    purgedAt: null,
  };
}
const history: HistoryPage = { entries: [], nextBeforeSeq: null, names: {} };

describe('Giveaway-Detail', () => {
  it('keeps unsaved settings edits when live push replaces the detail data', async () => {
    const data = { me, detail: detailOf(), participants: [], history };
    const { rerender } = render(Page, { props: { data } as never });
    await fireEvent.click(screen.getByRole('button', { name: L.actions.settings }));
    const prize = screen.getByLabelText(L.fields.prize, { exact: true }) as HTMLInputElement;
    await fireEvent.input(prize, { target: { value: 'Neuer Gewinn' } });
    expect(prize.value).toBe('Neuer Gewinn');
    // Ein Ereignis des Stroms: load liefert neue Objekte mit denselben Werten.
    await rerender({ data: { me, detail: detailOf(), participants: [], history } } as never);
    expect((screen.getByLabelText(L.fields.prize, { exact: true }) as HTMLInputElement).value).toBe('Neuer Gewinn');
  });

  it('load fetches detail, participants and history only; team members come later, when the settings open', async () => {
    const calls: string[] = [];
    const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      const body = url.endsWith('/participants') ? [] : url.includes('/history') ? history : detailOf();
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const result = await load({
      parent: async () => ({ me }),
      fetch: fetchStub as unknown as typeof fetch,
      url: new URL('https://g.example/giveaways/66666666-6666-4666-8666-666666666661'),
      params: { id: '66666666-6666-4666-8666-666666666661' },
      depends: vi.fn(),
    } as never);
    expect(calls.filter((u) => u.includes('/api/teams/'))).toEqual([]);
    expect(calls).toHaveLength(3);
    expect(result).not.toHaveProperty('channelOptions');
  });
});
