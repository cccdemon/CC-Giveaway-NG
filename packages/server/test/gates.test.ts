import { describe, expect, it } from 'vitest';
import { GateCheckError, checkGateConfig, evaluateGates, noGates, type GateConfig, type GateFacts } from '../src/framework/giveaway/gates.js';
import { isRejection } from '../src/shared/rejection.js';
import { AT } from './helpers/db.js';

const CH1 = '11111111-1111-4111-8111-111111111111';
const CH2 = '22222222-2222-4222-8222-222222222222';
const CHANNELS = [CH1, CH2];
const day = (n: number) => new Date(AT.getTime() - n * 86_400_000).toISOString();
const facts = (over: Partial<GateFacts> = {}): GateFacts => ({ follows: {}, accountCreatedAt: null, seenChannels: [], ...over });
const run = (gates: GateConfig[], f: GateFacts) => evaluateGates(gates, CHANNELS, f, AT);

describe('evaluateGates', () => {
  it('no gates means everyone passes', () => {
    expect(run([], facts())).toEqual({ ok: true, reasons: [] });
  });

  it('follow all/min/channel with reasons per missing channel', () => {
    const f = facts({ follows: { [CH1]: day(10), [CH2]: null } });
    expect(run([{ id: 'follow', mode: 'all' }], f)).toEqual({ ok: false, reasons: [`follow:${CH2}`] });
    expect(run([{ id: 'follow', mode: 'min', min: 1 }], f)).toEqual({ ok: true, reasons: [] });
    expect(run([{ id: 'follow', mode: 'min', min: 2 }], f)).toEqual({ ok: false, reasons: ['follow_min'] });
    expect(run([{ id: 'follow', mode: 'channel', channel: CH2 }], f)).toEqual({ ok: false, reasons: [`follow:${CH2}`] });
    expect(run([{ id: 'follow', mode: 'channel', channel: CH1 }], f)).toEqual({ ok: true, reasons: [] });
    // Unbekannter Kanal zählt wie „folgt nicht“.
    expect(run([{ id: 'follow', mode: 'all' }], facts({ follows: { [CH1]: day(1) } }))).toEqual({ ok: false, reasons: [`follow:${CH2}`] });
  });

  it('account_age and follow_age compare days against now', () => {
    const age: GateConfig[] = [{ id: 'account_age', days: 30 }];
    expect(run(age, facts({ accountCreatedAt: day(29) }))).toEqual({ ok: false, reasons: ['account_age'] });
    expect(run(age, facts({ accountCreatedAt: day(30) }))).toEqual({ ok: true, reasons: [] });
    expect(run(age, facts())).toEqual({ ok: false, reasons: ['account_age'] });
    const followAge: GateConfig[] = [{ id: 'follow_age', days: 7 }];
    expect(run(followAge, facts({ follows: { [CH1]: day(6), [CH2]: null } }))).toEqual({ ok: false, reasons: ['follow_age'] });
    expect(run(followAge, facts({ follows: { [CH1]: day(7), [CH2]: null } }))).toEqual({ ok: true, reasons: [] });
    expect(run(followAge, facts())).toEqual({ ok: false, reasons: ['follow_age'] });
  });

  it('follow_age applies the follow rule to old-enough follows only', () => {
    const both: GateConfig[] = [{ id: 'follow', mode: 'all' }, { id: 'follow_age', days: 7 }];
    expect(run(both, facts({ follows: { [CH1]: day(30), [CH2]: day(1) } }))).toEqual({ ok: false, reasons: ['follow_age'] });
    expect(run(both, facts({ follows: { [CH1]: day(30), [CH2]: day(7) } }))).toEqual({ ok: true, reasons: [] });
    expect(run(both, facts({ follows: { [CH1]: day(30), [CH2]: null } }))).toEqual({ ok: false, reasons: [`follow:${CH2}`, 'follow_age'] });
    const min: GateConfig[] = [{ id: 'follow', mode: 'min', min: 1 }, { id: 'follow_age', days: 7 }];
    expect(run(min, facts({ follows: { [CH1]: day(1), [CH2]: day(8) } }))).toEqual({ ok: true, reasons: [] });
    const one: GateConfig[] = [{ id: 'follow', mode: 'channel', channel: CH2 }, { id: 'follow_age', days: 7 }];
    expect(run(one, facts({ follows: { [CH1]: day(30), [CH2]: day(1) } }))).toEqual({ ok: false, reasons: ['follow_age'] });
  });

  it('presence counts seen channels of the giveaway', () => {
    const presence: GateConfig[] = [{ id: 'presence', minChannels: 2 }];
    expect(run(presence, facts({ seenChannels: [CH1] }))).toEqual({ ok: false, reasons: ['presence'] });
    expect(run(presence, facts({ seenChannels: [CH1, CH2, 'other'] }))).toEqual({ ok: true, reasons: [] });
    expect(run(presence, facts({ seenChannels: [CH1, 'x', 'y'] }))).toEqual({ ok: false, reasons: ['presence'] });
  });

  it('reasons list every failed gate in order', () => {
    const all: GateConfig[] = [{ id: 'follow', mode: 'all' }, { id: 'account_age', days: 30 }, { id: 'follow_age', days: 7 }, { id: 'presence', minChannels: 1 }];
    expect(run(all, facts())).toEqual({ ok: false, reasons: [`follow:${CH1}`, `follow:${CH2}`, 'account_age', 'follow_age', 'presence'] });
  });
});

describe('checkGateConfig', () => {
  it('normalizes a valid gate and rejects unknown ids, bad ranges and foreign channels', () => {
    expect(checkGateConfig({ id: 'follow', mode: 'all', min: 3, channel: CH1 }, CHANNELS)).toEqual({ id: 'follow', mode: 'all' });
    expect(checkGateConfig({ id: 'follow', mode: 'min', min: 2 }, CHANNELS)).toEqual({ id: 'follow', mode: 'min', min: 2 });
    expect(checkGateConfig({ id: 'follow', mode: 'channel', channel: CH2 }, CHANNELS)).toEqual({ id: 'follow', mode: 'channel', channel: CH2 });
    expect(checkGateConfig({ id: 'presence', minChannels: 2 }, CHANNELS)).toEqual({ id: 'presence', minChannels: 2 });
    for (const bad of [
      { id: 'vip' },
      { id: 'follow', mode: 'sometimes' },
      { id: 'follow', mode: 'min' },
      { id: 'follow', mode: 'min', min: 3 },
      { id: 'follow', mode: 'channel' },
      { id: 'follow', mode: 'channel', channel: '33333333-3333-4333-8333-333333333333' },
      { id: 'account_age', days: 3651 },
      { id: 'follow_age', days: 0 },
      { id: 'presence', minChannels: 3 },
      null,
    ]) {
      const r = checkGateConfig(bad, CHANNELS);
      expect(isRejection(r) && r.code, JSON.stringify(bad)).toBe('invalid_gate');
    }
  });
});

describe('noGates', () => {
  it('passes everyone without gates and refuses to judge configured gates', async () => {
    const base = { channels: CHANNELS, pids: ['a', 'b'], seen: {}, now: AT };
    expect(await noGates.check({ query: async () => ({ rows: [] }) } as never, { ...base, gates: [] })).toEqual([{ pid: 'a', ok: true, reasons: [] }, { pid: 'b', ok: true, reasons: [] }]);
    await expect(noGates.check({ query: async () => ({ rows: [] }) } as never, { ...base, gates: [{ id: 'follow', mode: 'all' }] })).rejects.toEqual(
      new GateCheckError('no_checker', 'Bedingungen lassen sich in diesem Prozess nicht prüfen. Ziehe in der App.'),
    );
  });
});
