import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import type { PortalTile } from '../api/types.js';
import { L } from '../texts/labels.js';
import { S } from '../texts/sentences.js';
import PortalCard from './PortalCard.svelte';

const base: PortalTile = {
  id: '66666666-6666-4666-8666-666666666661',
  prize: 'Herbst-Giveaway: Spielepaket',
  kernelLabel: 'Zuschauzeit + Follow',
  status: 'open',
  registered: true,
  inPool: true,
  weight: 11,
  chance: 0.0023,
  winnerStatus: null,
  updatedAt: '2026-10-15T11:54:00Z',
};

describe('PortalCard', () => {
  it('shows pool membership sentence, chance percent and the withdraw button when registered', async () => {
    const onwithdraw = vi.fn();
    render(PortalCard, { props: { tile: base, onjoin: vi.fn(), onwithdraw, busy: false, error: null } });
    expect(screen.getByText(S.portal.inPool)).toBeInTheDocument();
    expect(screen.getByText(/0,23/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Herbst-Giveaway/ })).toHaveAttribute('href', `/portal/giveaways/${base.id}`);
    await fireEvent.click(screen.getByRole('button', { name: L.actions.withdraw }));
    expect(onwithdraw).toHaveBeenCalledTimes(1);
  });

  it('offers join when not registered and shows the rejection text inline when register fails with not_open', async () => {
    const onjoin = vi.fn();
    const { rerender } = render(PortalCard, { props: { tile: { ...base, registered: false, inPool: false, weight: 0, chance: null }, onjoin, onwithdraw: vi.fn(), busy: false, error: null } });
    expect(screen.getByText(S.portal.notRegistered)).toBeInTheDocument();
    const join = screen.getByRole('button', { name: L.actions.join });
    // Genau ein Kupfer-Element je Ansicht: in der Liste trägt keine Karte Kupfer.
    expect(join.className).not.toContain('btn-primary');
    await fireEvent.click(join);
    expect(onjoin).toHaveBeenCalledTimes(1);
    await rerender({ tile: { ...base, registered: false, inPool: false, weight: 0, chance: null }, onjoin, onwithdraw: vi.fn(), busy: false, error: 'Das Giveaway nimmt gerade keine Anmeldungen an.' });
    expect(screen.getByRole('alert')).toHaveTextContent('Das Giveaway nimmt gerade keine Anmeldungen an.');
    expect(screen.getByRole('button', { name: L.actions.join })).toBeEnabled();
  });

  it('past giveaways say won or not won without buttons', () => {
    render(PortalCard, { props: { tile: { ...base, status: 'drawn', winnerStatus: 'pending' }, onjoin: vi.fn(), onwithdraw: vi.fn(), busy: false, error: null } });
    expect(screen.getByText(S.portal.won)).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
    render(PortalCard, { props: { tile: { ...base, status: 'completed', winnerStatus: null }, onjoin: vi.fn(), onwithdraw: vi.fn(), busy: false, error: null } });
    expect(screen.getByText(S.portal.notWon)).toBeInTheDocument();
  });
});
