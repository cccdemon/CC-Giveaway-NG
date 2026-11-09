import { get } from 'svelte/store';
import { describe, expect, it } from 'vitest';
import { maskName, streamerMode } from './mask.js';

describe('mask', () => {
  it('maskName uses the first four characters of the pid', () => {
    expect(maskName('a1b2c3d4-0000-4000-8000-000000000000')).toBe('Teilnehmer ·a1b2');
  });

  it('streamerMode starts off and remembers a change in localStorage', () => {
    expect(get(streamerMode)).toBe(false);
    streamerMode.set(true);
    expect(localStorage.getItem('ccg.streamerMode')).toBe('1');
    streamerMode.set(false);
    expect(localStorage.getItem('ccg.streamerMode')).toBe('0');
  });
});
