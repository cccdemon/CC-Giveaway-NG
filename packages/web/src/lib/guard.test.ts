import { isRedirect } from '@sveltejs/kit';
import { describe, expect, it } from 'vitest';
import type { Me } from './api/types.js';
import { requireSession, requireStreamer } from './guard.js';

const me: Me = { pid: 'p', login: 'alice', displayName: 'Alice', soloTeamId: 't', termsVersion: 1, currentTermsVersion: 1, channelConnected: true, legal: { impressumUrl: null, terms: null, privacyUrl: null } };
const url = new URL('https://g.example/giveaways?status=open');

const thrown = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return null;
};

describe('guard', () => {
  it('requireStreamer redirects without session to /?return and without accepted terms to /terms?return', () => {
    const noSession = thrown(() => requireStreamer(null, url));
    expect(isRedirect(noSession)).toBe(true);
    expect(noSession).toMatchObject({ status: 303, location: '/?return=%2Fgiveaways%3Fstatus%3Dopen' });
    const oldTerms = thrown(() => requireStreamer({ ...me, termsVersion: 0 }, url));
    expect(oldTerms).toMatchObject({ status: 303, location: '/terms?return=%2Fgiveaways%3Fstatus%3Dopen' });
    expect(requireStreamer(me, url)).toBe(me);
  });

  it('requireSession only asks for a session', () => {
    expect(requireSession({ ...me, termsVersion: 0 }, url)).toMatchObject({ pid: 'p' });
    expect(isRedirect(thrown(() => requireSession(null, url)))).toBe(true);
  });
});
