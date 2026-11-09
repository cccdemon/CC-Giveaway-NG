import { render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import type { ChannelStatus, Me, TeamList } from '#lib/api/types.js';
import { L } from '#lib/texts/labels.js';
import Page from './+page.svelte';

const me: Me = { pid: 'a1', login: 'alice', displayName: 'Alice', soloTeamId: 's', termsVersion: 1, currentTermsVersion: 1, channelConnected: true, legal: { impressumUrl: null, terms: null, privacyUrl: null }, admin: false, banned: null, warnings: [] };
const channel: ChannelStatus = { pid: 'a1', connected: true, tokenStatus: 'ok', live: false, liveSince: null, viewers: null, chatters: null, coverage: null, lastSignalAt: null, problem: null, warning: null };
const teams: TeamList = { solo: { teamId: 's' }, teams: [] };

describe('Übersicht: Hinweise der Plattform', () => {
  it('shows the ban reason in a red stripe and disables the start button; shows each warning with its reason', () => {
    render(Page, {
      props: {
        data: {
          me: { ...me, banned: { reason: 'Bot-Verhalten', since: '2026-10-14T12:00:00Z' }, warnings: [{ eventId: 'w1', reason: 'Keyword-Spam', at: '2026-10-13T12:00:00Z' }] },
          tiles: [],
          channel,
          teams,
        },
      } as never,
    });
    const alerts = screen.getAllByRole('alert');
    expect(alerts.some((a) => a.textContent?.includes('Bot-Verhalten') && a.className.includes('panel-error'))).toBe(true);
    expect(alerts.some((a) => a.textContent?.includes('Keyword-Spam') && a.className.includes('panel-warn'))).toBe(true);
    expect(screen.queryByRole('link', { name: L.actions.start })).toBeNull();
    expect(screen.getByText(L.actions.start).closest('.btn')).toHaveAttribute('aria-disabled', 'true');
  });

  it('without ban or warnings shows the start link and no stripes', () => {
    render(Page, { props: { data: { me, tiles: [], channel, teams } } as never });
    expect(screen.getByRole('link', { name: L.actions.start })).toHaveAttribute('href', '/giveaways/new');
    expect(screen.queryAllByRole('alert').filter((a) => a.className.includes('panel-error'))).toHaveLength(0);
  });
});
