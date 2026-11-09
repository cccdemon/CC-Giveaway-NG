import { render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import type { ChannelStatus as Status } from '../api/types.js';
import { L } from '../texts/labels.js';
import ChannelStatus from './ChannelStatus.svelte';

const NOW = new Date('2026-10-15T12:00:00Z');

const live: Status = {
  pid: 'c1',
  connected: true,
  tokenStatus: 'ok',
  live: true,
  liveSince: '2026-10-15T10:00:00Z',
  viewers: 184,
  chatters: 120,
  coverage: 120 / 184,
  lastSignalAt: '2026-10-15T11:59:48Z',
  problem: null,
  warning: { level: 'gelb', text: 'Kanal neu verbinden. Seit über 2 Minuten kommt kein Signal.' },
};

describe('ChannelStatus', () => {
  it('shows live word, relative last signal, viewers, coverage percent and the warning text', () => {
    render(ChannelStatus, { props: { v: live, name: 'kanal_nord', now: NOW } });
    expect(screen.getByText('kanal_nord')).toBeInTheDocument();
    expect(screen.getByText(L.channel.live)).toBeInTheDocument();
    expect(screen.getByText('vor 12 s')).toBeInTheDocument();
    expect(screen.getByText('184')).toBeInTheDocument();
    expect(screen.getByText(/65,22/)).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Seit über 2 Minuten kommt kein Signal.');
  });

  it('token invalid renders red with the word, offline channels say offline, unconnected say so', () => {
    const { container, unmount } = render(ChannelStatus, { props: { v: { ...live, tokenStatus: 'invalid', warning: { level: 'rot', text: 'Kanal neu verbinden. Das Twitch-Token ist abgelaufen oder ein Recht fehlt.' } }, now: NOW } });
    expect(screen.getByText(L.channel.tokenInvalid).closest('.tone-err')).not.toBeNull();
    expect(container.querySelector('.panel-error')).not.toBeNull();
    unmount();
    render(ChannelStatus, { props: { v: { ...live, live: false, viewers: null, chatters: null, coverage: null, warning: null }, now: NOW } });
    expect(screen.getByText(L.channel.offline)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    render(ChannelStatus, { props: { v: { ...live, connected: false, tokenStatus: 'none', live: false, warning: null }, now: NOW } });
    expect(screen.getByText(L.channel.notConnected)).toBeInTheDocument();
  });
});
