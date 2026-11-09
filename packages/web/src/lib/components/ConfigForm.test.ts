import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import type { ConfigField } from '../api/types.js';
import ConfigForm from './ConfigForm.svelte';

const schema: Record<string, ConfigField> = {
  coinBaseSec: { kind: 'int', label: 'Coin-Basis', help: 'So viel Zuschauzeit ergibt einen Coin.', default: 7200, min: 60, max: 360_000, unit: 'sec' },
  ticketPriceCoins: { kind: 'int', label: 'Preis je Ticket', help: 'Coins je Ticket.', default: 1, min: 1, max: 1000, unit: 'coins' },
  bonus: { kind: 'bool', label: 'Bonus', help: 'Ein Bonus.', default: false },
  note: { kind: 'text', label: 'Notiz', help: 'Frei.', default: '', maxLength: 50 },
};

describe('ConfigForm', () => {
  it('renders int fields with label, help and range (seconds as minutes), a bool switch and a text field from the schema', async () => {
    const onchange = vi.fn();
    render(ConfigForm, { props: { schema, value: { coinBaseSec: 7200, ticketPriceCoins: 2, bonus: false, note: '' }, onchange, errors: { ticketPriceCoins: 'Zu klein.' } } });
    const minutes = screen.getByLabelText('Coin-Basis') as HTMLInputElement;
    expect(minutes).toHaveValue(120);
    expect(minutes).toHaveAttribute('min', '1');
    expect(minutes).toHaveAttribute('max', '6000');
    expect(screen.getByText(/So viel Zuschauzeit ergibt einen Coin./)).toBeInTheDocument();
    expect(screen.getByLabelText('Preis je Ticket')).toHaveValue(2);
    expect(screen.getByText('Zu klein.')).toBeInTheDocument();
    expect(screen.getByLabelText('Bonus')).not.toBeChecked();
    expect(screen.getByLabelText('Notiz')).toHaveAttribute('maxlength', '50');
    await fireEvent.input(minutes, { target: { value: '90' } });
    expect(onchange).toHaveBeenLastCalledWith({ coinBaseSec: 5400, ticketPriceCoins: 2, bonus: false, note: '' });
    await fireEvent.click(screen.getByLabelText('Bonus'));
    expect(onchange).toHaveBeenLastCalledWith(expect.objectContaining({ bonus: true }));
  });
});
