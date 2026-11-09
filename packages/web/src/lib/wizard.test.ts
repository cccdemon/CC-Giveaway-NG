import { describe, expect, it } from 'vitest';
import type { KernelInfo, LegalTexts } from './api/types.js';
import { emptyDraft, stepOfRejection, toSettings, validateStep, withKernel } from './wizard.js';

const watchtime: KernelInfo = {
  id: 'watchtime',
  label: 'Zuschauzeit + Follow',
  version: 1,
  display: { icon: '⏱', unit: 'Coins', beta: true, emptyPool: 'Niemand hat einen Coin.', columns: [] },
  configSchema: {
    coinBaseSec: { kind: 'int', label: 'Coin-Basis', help: 'Sekunden je Coin.', default: 7200, min: 60, max: 360_000, unit: 'sec' },
    bonus: { kind: 'bool', label: 'Bonus', help: 'Ein Bonus.', default: false },
    note: { kind: 'text', label: 'Notiz', help: 'Frei.', default: '', maxLength: 50 },
  },
  supportedGates: ['follow', 'account_age', 'follow_age', 'presence'],
  usesServices: ['watchtime', 'chatBonus', 'boost', 'registration'],
  drawMode: 'weighted',
  commands: [],
};
const CH_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const CH_B = 'bbbbbbbb-0000-4000-8000-000000000002';
const CH_X = 'cccccccc-0000-4000-8000-000000000003';
const FULL_LEGAL: LegalTexts = { impressumUrl: 'https://x/i', terms: { text: 'Regeln.' }, privacyUrl: 'https://x/p' };

describe('wizard', () => {
  it('withKernel fills config defaults from configSchema and keeps other fields', () => {
    const d = withKernel({ ...emptyDraft(), prize: 'Key' }, watchtime);
    expect(d.kernelId).toBe('watchtime');
    expect(d.config).toEqual({ coinBaseSec: 7200, bonus: false, note: '' });
    expect(d.prize).toBe('Key');
    expect(d.gates).toEqual([]);
  });

  it('validateStep 2 checks prize, counts, config ranges, keyword and contact', () => {
    const d = withKernel(emptyDraft(), watchtime);
    expect(validateStep(2, d, watchtime, [])).toMatchObject({ prize: expect.any(String) });
    const ok = { ...d, prize: 'Key', keyword: '!key', contact: 'Discord: a' };
    expect(validateStep(2, ok, watchtime, [])).toEqual({});
    expect(validateStep(2, { ...ok, winnersCount: 0 }, watchtime, [])).toHaveProperty('winnersCount');
    expect(validateStep(2, { ...ok, claimDays: 400 }, watchtime, [])).toHaveProperty('claimDays');
    expect(validateStep(2, { ...ok, config: { ...ok.config, coinBaseSec: 10 } }, watchtime, [])).toHaveProperty('config.coinBaseSec');
    expect(validateStep(2, { ...ok, keyword: 'a' }, watchtime, [])).toHaveProperty('keyword');
    expect(validateStep(2, { ...ok, keyword: 'zwei wörter' }, watchtime, [])).toHaveProperty('keyword');
    expect(validateStep(2, { ...ok, contact: 'x'.repeat(201) }, watchtime, [])).toHaveProperty('contact');
    expect(validateStep(2, { ...ok, config: { ...ok.config, note: 'x'.repeat(51) } }, watchtime, [])).toHaveProperty('config.note');
    // Grenzen des Servers (services.ts): sec 1–60, minWords 1–20, cooldownSec 1–600
    expect(validateStep(2, { ...ok, chatBonus: { ...ok.chatBonus, minWords: 21 } }, watchtime, [])).toHaveProperty('chatBonus.minWords');
    expect(validateStep(2, { ...ok, chatBonus: { ...ok.chatBonus, cooldownSec: 0 } }, watchtime, [])).toHaveProperty('chatBonus.cooldownSec');
    expect(validateStep(2, { ...ok, chatBonus: { ...ok.chatBonus, cooldownSec: 601 } }, watchtime, [])).toHaveProperty('chatBonus.cooldownSec');
    expect(validateStep(2, { ...ok, chatBonus: { ...ok.chatBonus, sec: 61 } }, watchtime, [])).toHaveProperty('chatBonus.sec');
    expect(validateStep(2, { ...ok, chatBonus: { enabled: false, sec: 99, minWords: 99, cooldownSec: 0 } }, watchtime, [])).toEqual({});
  });

  it('validateStep 3 needs at least one channel inside the team', () => {
    const d = withKernel({ ...emptyDraft(), prize: 'Key' }, watchtime);
    expect(validateStep(3, d, watchtime, [CH_A, CH_B])).toHaveProperty('channels');
    expect(validateStep(3, { ...d, channels: [CH_X] }, watchtime, [CH_A, CH_B])).toHaveProperty('channels');
    expect(validateStep(3, { ...d, channels: [CH_A] }, watchtime, [CH_A, CH_B])).toEqual({});
  });

  it('validateStep 4 rejects follow channel outside the giveaway, min above channel count and presence above channel count', () => {
    const d = { ...withKernel({ ...emptyDraft(), prize: 'Key' }, watchtime), channels: [CH_A, CH_B] };
    expect(validateStep(4, { ...d, gates: [{ id: 'follow', mode: 'channel', channel: CH_X }] }, watchtime, d.channels)).toHaveProperty('gates');
    expect(validateStep(4, { ...d, gates: [{ id: 'follow', mode: 'min', min: 3 }] }, watchtime, d.channels)).toHaveProperty('gates');
    expect(validateStep(4, { ...d, gates: [{ id: 'presence', minChannels: 3 }] }, watchtime, d.channels)).toHaveProperty('gates');
    expect(validateStep(4, { ...d, gates: [{ id: 'account_age', days: 0 }] }, watchtime, d.channels)).toHaveProperty('gates');
    expect(validateStep(4, { ...d, gates: [{ id: 'follow', mode: 'all' }, { id: 'account_age', days: 30 }, { id: 'presence', minChannels: 2 }] }, watchtime, d.channels)).toEqual({});
    const instant: KernelInfo = { ...watchtime, id: 'instant', supportedGates: ['follow', 'account_age'] };
    expect(validateStep(4, { ...d, gates: [{ id: 'presence', minChannels: 1 }] }, instant, d.channels)).toHaveProperty('gates');
  });

  it('validateStep 5 accepts profile legal only when all three texts exist, own texts need all three', () => {
    const d = withKernel({ ...emptyDraft(), prize: 'Key' }, watchtime);
    expect(validateStep(5, d, watchtime, [], FULL_LEGAL)).toEqual({});
    expect(validateStep(5, d, watchtime, [], { ...FULL_LEGAL, privacyUrl: null })).toHaveProperty('legal');
    expect(validateStep(5, { ...d, legal: { ...FULL_LEGAL, impressumUrl: null } }, watchtime, [], FULL_LEGAL)).toHaveProperty('legal');
    expect(validateStep(5, { ...d, legal: FULL_LEGAL }, watchtime, [], { impressumUrl: null, terms: null, privacyUrl: null })).toEqual({});
  });

  it('toSettings turns empty strings into null, profile legal into null and keeps config and gates', () => {
    const d = { ...withKernel({ ...emptyDraft(), prize: ' Key ' }, watchtime), channels: [CH_A], sponsor: '', keyword: '', contact: ' Discord ' };
    expect(toSettings(d)).toEqual({
      prize: 'Key',
      sponsor: null,
      channels: [CH_A],
      winnersCount: 1,
      claimDays: 14,
      gates: [],
      legal: null,
      contact: 'Discord',
      counting: 'registered',
      purgeDays: 7,
      keyword: null,
      chatBonus: { enabled: true, sec: 2, minWords: 4, cooldownSec: 10 },
      config: { coinBaseSec: 7200, bonus: false, note: '' },
    });
    expect(toSettings({ ...d, legal: FULL_LEGAL }).legal).toEqual(FULL_LEGAL);
  });

  it('stepOfRejection maps keyword_reserved→2, invalid_gate→4, legal_required→5, others→6', () => {
    expect(stepOfRejection('keyword_reserved')).toBe(2);
    expect(stepOfRejection('invalid_config')).toBe(2);
    expect(stepOfRejection('channel_not_in_team')).toBe(3);
    expect(stepOfRejection('invalid_gate')).toBe(4);
    expect(stepOfRejection('legal_required')).toBe(5);
    expect(stepOfRejection('invalid_url')).toBe(5);
    expect(stepOfRejection('team_inactive')).toBe(6);
  });
});
