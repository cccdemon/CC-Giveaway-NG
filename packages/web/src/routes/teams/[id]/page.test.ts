import { render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import type { Me, TeamDetail } from '#lib/api/types.js';
import { streamerMode } from '#lib/mask.js';
import Page from './+page.svelte';

const me: Me = { pid: 'a1', login: 'alice', displayName: 'Alice', soloTeamId: 's', termsVersion: 1, currentTermsVersion: 1, channelConnected: true, legal: { impressumUrl: null, terms: null, privacyUrl: null } };
const team: TeamDetail = {
  teamId: 't1',
  name: 'Nordlicht',
  active: true,
  members: [
    { pid: 'a1', displayName: 'Alice' },
    { pid: 'b2', displayName: 'Bob' },
  ],
  invites: [],
  banned: ['abcd1234-0000-4000-8000-000000000000'],
};

describe('Team-Seite', () => {
  it('shows member names also in streamer mode and banned persons only as masked participants', () => {
    streamerMode.set(true);
    render(Page, { props: { data: { me, team } } as never });
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('Bob')).toBeInTheDocument();
    expect(screen.getByText('Teilnehmer ·abcd')).toBeInTheDocument();
    expect(screen.queryByText('abcd1234-0000-4000-8000-000000000000')).toBeNull();
    streamerMode.set(false);
  });
});
