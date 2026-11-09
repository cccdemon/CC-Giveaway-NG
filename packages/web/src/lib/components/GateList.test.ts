import { render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import { L } from '../texts/labels.js';
import GateList from './GateList.svelte';

const channels = [
  { pid: 'aaaaaaaa-0000-4000-8000-000000000001', displayName: 'kanal_nord' },
  { pid: 'bbbbbbbb-0000-4000-8000-000000000002', displayName: 'kanal_sued' },
];

describe('GateList', () => {
  it('describes gates in German and maps reasons like follow:<pid> to channel names', () => {
    render(GateList, {
      props: {
        gates: [{ id: 'follow', mode: 'all' }, { id: 'account_age', days: 30 }, { id: 'presence', minChannels: 2 }],
        channels,
        result: { ok: false, reasons: [`follow:${channels[1]!.pid}`, 'account_age'] },
      },
    });
    expect(screen.getByText('Follow bei allen 2 Kanälen')).toBeInTheDocument();
    expect(screen.getByText('Twitch-Konto mindestens 30 Tage alt')).toBeInTheDocument();
    expect(screen.getByText('Zuschauzeit in mindestens 2 Kanälen')).toBeInTheDocument();
    expect(screen.getByText('Follow bei kanal_sued fehlt')).toBeInTheDocument();
    expect(screen.getByText(L.gates.reasonAccountAge)).toBeInTheDocument();
    expect(screen.getByText(L.gates.ok)).toBeInTheDocument();
  });

  it('without a result shows the gates as unchecked, without gates says so', () => {
    const { unmount } = render(GateList, { props: { gates: [{ id: 'follow_age', days: 7 }], channels, result: null } });
    expect(screen.getByText('Follow mindestens 7 Tage alt')).toBeInTheDocument();
    expect(screen.getByText(L.gates.unchecked)).toBeInTheDocument();
    unmount();
    render(GateList, { props: { gates: [], channels, result: null } });
    expect(screen.getByText(L.gates.none)).toBeInTheDocument();
  });
});
