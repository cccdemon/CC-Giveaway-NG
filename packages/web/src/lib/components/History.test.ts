import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import type { HistoryEntry } from '../api/types.js';
import { L } from '../texts/labels.js';
import History from './History.svelte';

const BOB = 'bbbbbbbb-0000-4000-8000-000000000002';
const base = (over: Partial<HistoryEntry>): HistoryEntry => ({
  id: 'e1',
  seq: 5,
  type: 'participant_registered',
  at: '2026-10-15T12:00:00.000Z',
  actor: { kind: 'user', pid: BOB, displayName: 'Bob' },
  reason: null,
  reversesEventId: null,
  reverted: false,
  reversal: { kind: 'compensate' },
  payload: { pid: BOB },
  ...over,
});

describe('History', () => {
  it('shows Rückgängig for compensate/void entries, the why for none, strikes through reverted entries', async () => {
    const onrevert = vi.fn();
    const entries = [
      base({ id: 'e3', seq: 7, type: 'boost_started', payload: { factor: 2, until: '2026-10-15T13:00:00.000Z' }, reverted: true }),
      base({ id: 'e2', seq: 6, type: 'giveaway_legal_frozen', payload: {}, reversal: { kind: 'none', why: 'Eingefrorene Rechtstexte sind ein Nachweis und bleiben.' } }),
      base({ id: 'e1', seq: 5 }),
    ];
    render(History, { props: { entries, names: { [BOB]: 'Bob' }, onrevert } });
    const buttons = screen.getAllByRole('button', { name: L.actions.revert });
    expect(buttons).toHaveLength(1);
    expect(screen.getByText(L.notReversible)).toBeInTheDocument();
    expect(screen.getByText(/Boost ×2 gestartet/).closest('.struck')).not.toBeNull();
    expect(screen.getByText(L.reverted)).toBeInTheDocument();
    await fireEvent.click(buttons[0]!);
    expect(onrevert).toHaveBeenCalledWith(entries[2]);
    expect(screen.getByText('Bob hat sich angemeldet.')).toBeInTheDocument();
  });
});
