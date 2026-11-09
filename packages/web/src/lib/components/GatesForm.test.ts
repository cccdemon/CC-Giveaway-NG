import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import { L } from '../texts/labels.js';
import GatesForm from './GatesForm.svelte';

const channels = [
  { pid: 'aaaaaaaa-0000-4000-8000-000000000001', displayName: 'kanal_nord' },
  { pid: 'bbbbbbbb-0000-4000-8000-000000000002', displayName: 'kanal_sued' },
];

describe('GatesForm', () => {
  it('shows only supported gates and emits a follow gate with mode channel when a channel is chosen', async () => {
    const onchange = vi.fn();
    render(GatesForm, { props: { supported: ['follow', 'account_age'], channels, value: [], onchange, error: null } });
    expect(screen.getByText(L.gates.follow)).toBeInTheDocument();
    expect(screen.getByText(L.gates.accountAgeTitle)).toBeInTheDocument();
    expect(screen.queryByText(L.gates.presenceTitle)).toBeNull();
    expect(screen.queryByText(L.gates.followAgeTitle)).toBeNull();
    await fireEvent.click(screen.getByLabelText(`${L.gates.follow} ${L.gates.required}`));
    expect(onchange).toHaveBeenLastCalledWith([{ id: 'follow', mode: 'all' }]);
    await fireEvent.click(screen.getByLabelText(L.gates.followChannelOption));
    await fireEvent.change(screen.getByLabelText(L.fields.channel), { target: { value: channels[1]!.pid } });
    expect(onchange).toHaveBeenLastCalledWith([{ id: 'follow', mode: 'channel', channel: channels[1]!.pid }]);
    await fireEvent.click(screen.getByLabelText(L.gates.accountAgeTitle));
    expect(onchange).toHaveBeenLastCalledWith([
      { id: 'follow', mode: 'channel', channel: channels[1]!.pid },
      { id: 'account_age', days: 30 },
    ]);
  });

  it('starts from existing gates and shows the error', () => {
    render(GatesForm, {
      props: { supported: ['follow', 'account_age', 'follow_age', 'presence'], channels, value: [{ id: 'follow', mode: 'min', min: 2 }, { id: 'presence', minChannels: 2 }], onchange: vi.fn(), error: 'Zu viele Kanäle.' },
    });
    expect(screen.getByLabelText(`${L.gates.follow} ${L.gates.required}`)).toBeChecked();
    expect(screen.getByLabelText(L.gates.followMinOption)).toBeChecked();
    expect(screen.getByLabelText(L.gates.presenceTitle)).toBeChecked();
    expect(screen.getByRole('alert')).toHaveTextContent('Zu viele Kanäle.');
  });
});
