import { fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import type { ParticipantView } from '../api/types.js';
import { streamerMode } from '../mask.js';
import { L } from '../texts/labels.js';
import Participants from './Participants.svelte';

const rows: ParticipantView[] = [
  { pid: 'aaaa1111-0000-4000-8000-000000000001', displayName: 'sternenfahrer_88', registered: true, inPool: true, seen: true, weight: 11, chance: 0.0023, winnerStatus: null, lines: [{ label: 'Zeit', value: '11 h 42 min' }, { label: 'Coins', value: '11' }] },
  { pid: 'bbbb2222-0000-4000-8000-000000000002', displayName: 'quasar_q', registered: true, inPool: false, seen: true, weight: 0, chance: null, winnerStatus: null, lines: [{ label: 'Zeit', value: '40 min' }, { label: 'Coins', value: '0' }] },
  { pid: 'cccc3333-0000-4000-8000-000000000003', displayName: 'mia_kocht', registered: true, inPool: true, seen: true, weight: 9, chance: 0.0019, winnerStatus: 'reported', lines: [{ label: 'Zeit', value: '9 h 5 min' }, { label: 'Coins', value: '9' }] },
];

describe('Participants', () => {
  afterEach(() => streamerMode.set(false));

  it('filters by name, shows weight with unit, chance as percent and kernel lines as columns', async () => {
    render(Participants, { props: { rows, unit: 'Coins' } });
    expect(screen.getByRole('columnheader', { name: 'Zeit' })).toBeInTheDocument();
    expect(screen.getByText('11 h 42 min')).toBeInTheDocument();
    expect(screen.getByText('11 Coins')).toBeInTheDocument();
    expect(screen.getByText(/0,23/)).toBeInTheDocument();
    expect(screen.getAllByText('–').length).toBeGreaterThan(0);
    expect(screen.getByText(L.participant.inPool, { selector: 'td span span' })).toBeInTheDocument();
    expect(screen.getByText(`${L.participant.winner} · ${L.winner.reported}`)).toBeInTheDocument();
    await fireEvent.input(screen.getByLabelText(L.fields.search), { target: { value: 'mia' } });
    expect(screen.queryByText('sternenfahrer_88')).toBeNull();
    expect(screen.getByText('mia_kocht')).toBeInTheDocument();
  });

  it('masks names in streamer mode', () => {
    streamerMode.set(true);
    render(Participants, { props: { rows, unit: null } });
    expect(screen.queryByText('sternenfahrer_88')).toBeNull();
    expect(screen.getByText('Teilnehmer ·aaaa')).toBeInTheDocument();
  });
});
