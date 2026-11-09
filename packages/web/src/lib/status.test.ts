import { describe, expect, it } from 'vitest';
import type { KernelInfo } from './api/types.js';
import { actionsOf, activityOf } from './status.js';
import { S } from './texts/sentences.js';

const kernel = (over: Partial<Pick<KernelInfo, 'usesServices' | 'commands'>> = {}): Pick<KernelInfo, 'usesServices' | 'commands'> => ({
  usesServices: ['registration'],
  commands: [],
  ...over,
});

describe('status', () => {
  it('actionsOf yields exactly one primary action per status and complete only when all winners are done or forfeited', () => {
    expect(actionsOf({ status: 'draft', boost: null, kernel: kernel(), winners: [] })).toMatchObject({ primary: 'open', others: ['settings', 'cancel'] });
    expect(actionsOf({ status: 'open', boost: null, kernel: kernel(), winners: [] }).primary).toBe('pause');
    expect(actionsOf({ status: 'paused', boost: null, kernel: kernel(), winners: [] }).primary).toBe('resume');
    const closed = actionsOf({ status: 'closed', boost: null, kernel: kernel(), winners: [] });
    expect(closed).toMatchObject({ primary: 'draw', others: ['reopen', 'cancel'] });
    const pending = actionsOf({ status: 'drawn', boost: null, kernel: kernel(), winners: [{ status: 'done' }, { status: 'reported' }] });
    expect(pending.primary).toBeNull();
    expect(pending.hints.complete).toBe(S.hints.completeAfterWinners);
    expect(pending.others).toEqual(['cancel']);
    expect(actionsOf({ status: 'drawn', boost: null, kernel: kernel(), winners: [{ status: 'done' }, { status: 'forfeited' }] }).primary).toBe('complete');
    expect(actionsOf({ status: 'completed', boost: null, kernel: kernel(), winners: [] })).toEqual({ primary: null, others: [], hints: {} });
    expect(actionsOf({ status: 'cancelled', boost: null, kernel: kernel(), winners: [] })).toEqual({ primary: null, others: [], hints: {} });
  });

  it('open and paused offer draw only as a hint, boost/correct only with the services, kernel streamer commands only when open', () => {
    const k = kernel({ usesServices: ['watchtime', 'chatBonus', 'boost', 'registration'], commands: [{ type: 'open_window', label: 'Anmeldefenster öffnen', issuer: 'streamer' }, { type: 'close_window', label: 'x', issuer: 'scheduler' }] });
    const open = actionsOf({ status: 'open', boost: null, kernel: k, winners: [] });
    expect(open.others).toEqual(['close', 'draw', 'boost', 'correct', 'settings', 'kernel:open_window', 'cancel']);
    expect(open.hints.draw).toBe(S.hints.drawAfterClose);
    const boosted = actionsOf({ status: 'paused', boost: { factor: 2, until: '2026-10-15T13:00:00Z', eventId: 'e' }, kernel: k, winners: [] });
    expect(boosted.others).toEqual(['close', 'draw', 'stopBoost', 'correct', 'settings', 'cancel']);
    const plain = actionsOf({ status: 'open', boost: null, kernel: kernel(), winners: [] });
    expect(plain.others).toEqual(['close', 'draw', 'settings', 'cancel']);
  });

  it('activityOf names the drawing activity while busy', () => {
    expect(activityOf('open', null)).toBe(S.activity.open);
    expect(activityOf('closed', 'draw')).toBe(S.activity.drawing);
    expect(activityOf('drawn', 'redraw')).toBe(S.activity.drawing);
    expect(activityOf('paused', null)).toBe(S.activity.paused);
  });
});
