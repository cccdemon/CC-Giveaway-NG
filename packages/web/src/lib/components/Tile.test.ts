import { render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import type { Tile as TileRow } from '../api/types.js';
import { L } from '../texts/labels.js';
import Tile from './Tile.svelte';

const NOW = new Date('2026-10-15T12:00:00Z');

const base: TileRow = {
  id: '66666666-6666-4666-8666-666666666661',
  teamId: 't',
  kernel: 'watchtime',
  kernelLabel: 'Zuschauzeit + Follow',
  status: 'open',
  prize: 'Herbst-Giveaway: Spielepaket',
  registeredCount: 214,
  poolSize: 198,
  poolWeight: 4812,
  claimDays: 14,
  drawnAt: null,
  winnerStatuses: { pending: 0, reported: 0, shipped: 0, done: 0, forfeited: 0 },
  updatedAt: '2026-10-15T11:54:00Z',
  warnings: [{ pid: 'c1', level: 'gelb', text: 'Kanal neu verbinden. Seit über 2 Minuten kommt kein Signal.' }],
};

describe('Tile', () => {
  it('shows kernel label, status word with icon, counts and the first warning', () => {
    const { container } = render(Tile, { props: { tile: base, now: NOW } });
    expect(screen.getByText('Zuschauzeit + Follow')).toBeInTheDocument();
    expect(screen.getByText(L.status.open)).toBeInTheDocument();
    expect(container.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    expect(screen.getByRole('heading', { name: 'Herbst-Giveaway: Spielepaket' })).toBeInTheDocument();
    expect(screen.getByText('214')).toBeInTheDocument();
    expect(screen.getByText('198')).toBeInTheDocument();
    expect(screen.getByText('vor 6 min')).toBeInTheDocument();
    expect(screen.getByText(/Seit über 2 Minuten kommt kein Signal/)).toBeInTheDocument();
    expect(screen.getByRole('link')).toHaveAttribute('href', `/giveaways/${base.id}`);
  });

  it('drawn tile shows claim deadline from drawnAt + claimDays and winner status counts', () => {
    render(Tile, {
      props: {
        tile: { ...base, status: 'drawn', drawnAt: '2026-10-04T12:00:00Z', winnerStatuses: { pending: 1, reported: 0, shipped: 0, done: 1, forfeited: 0 }, warnings: [] },
        now: NOW,
      },
    });
    expect(screen.getByText('Meldefrist läuft: noch 3 Tage.')).toBeInTheDocument();
    expect(screen.getByText('1 offen · 1 erledigt')).toBeInTheDocument();
    expect(screen.getByText(L.status.drawn)).toBeInTheDocument();
  });

  it('an expired claim period says so', () => {
    render(Tile, { props: { tile: { ...base, status: 'drawn', drawnAt: '2026-09-01T12:00:00Z', winnerStatuses: { pending: 1, reported: 0, shipped: 0, done: 0, forfeited: 0 } }, now: NOW } });
    expect(screen.getByText('Meldefrist abgelaufen.')).toBeInTheDocument();
  });
});
