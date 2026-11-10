import { render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import type { Me, PortalDetail } from '#lib/api/types.js';
import { date } from '#lib/format.js';
import { L } from '#lib/texts/labels.js';
import { S } from '#lib/texts/sentences.js';
import Page from './+page.svelte';

const me: Me = { pid: 'b1b1b1b1-0000-4000-8000-000000000002', login: 'bob', displayName: 'Bob', soloTeamId: 'solo-2', termsVersion: 1, currentTermsVersion: 1, channelConnected: false, legal: { impressumUrl: null, terms: null, privacyUrl: null }, admin: false, banned: null, warnings: [] };

function detailOf(over: Partial<PortalDetail> = {}): PortalDetail {
  return {
    id: '66666666-6666-4666-8666-666666666661',
    prize: 'Werwolf-Box',
    sponsor: null,
    kernel: { id: 'watchtime', label: 'Zuschauzeit + Follow', display: { icon: '⏱', unit: 'Coins', beta: true, emptyPool: 'Niemand hat genug Zuschauzeit für einen Coin.', columns: [] }, commands: [] },
    status: 'paused',
    channels: [{ pid: 'a1a1a1a1-0000-4000-8000-000000000001', displayName: 'Alice' }],
    keyword: '!werwolf',
    legal: { impressumUrl: null, terms: { text: 'Fassung 3.' }, privacyUrl: null },
    claimDays: 14,
    counting: 'first_seen',
    winnersCount: 1,
    registered: true,
    view: { registered: true, inPool: true, weight: 5, lines: [{ label: 'Zuschauzeit', value: '10 h' }] },
    chance: 0.5,
    gates: [],
    lastGateResult: null,
    winner: null,
    legalEventId: 'e-9',
    consent: { at: '2026-11-20T18:00:00.000Z', terms: { text: 'Fassung 3.' } },
    ...over,
  };
}

describe('Portal-Detail', () => {
  it('shows the consent date; the agreed terms only when they differ from the current text', () => {
    render(Page, { props: { data: { me, detail: detailOf() } } as never });
    expect(screen.getByText(S.portal.version(date('2026-11-20T18:00:00.000Z')))).toBeInTheDocument();
    expect(screen.queryByText(L.portal.consentedTerms)).not.toBeInTheDocument();
  });

  it('shows the agreed version collapsible when the streamer froze a different text; nothing without consent', () => {
    const { unmount } = render(Page, { props: { data: { me, detail: detailOf({ legal: { impressumUrl: null, terms: { text: 'Neue Fassung.' }, privacyUrl: null } }) } } as never });
    expect(screen.getByText(L.portal.consentedTerms)).toBeInTheDocument();
    expect(screen.getByText('Fassung 3.')).toBeInTheDocument();
    unmount();
    render(Page, { props: { data: { me, detail: detailOf({ consent: null, registered: false }) } } as never });
    expect(screen.queryByText(/zugestimmt/)).not.toBeInTheDocument();
  });
});
