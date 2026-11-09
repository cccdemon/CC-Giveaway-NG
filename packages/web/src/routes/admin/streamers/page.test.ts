import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AdminStreamer, Me } from '#lib/api/types.js';
import { L } from '#lib/texts/labels.js';
import Page from './+page.svelte';

const me: Me = { pid: 'a1', login: 'alice', displayName: 'Alice', soloTeamId: 's', termsVersion: 1, currentTermsVersion: 1, channelConnected: true, legal: { impressumUrl: null, terms: null, privacyUrl: null }, admin: true, banned: null, warnings: [] };
const BOB = 'bbbbbbbb-0000-4000-8000-000000000002';
const CAROL = 'cccccccc-0000-4000-8000-000000000003';
const results: AdminStreamer[] = [
  { pid: BOB, login: 'bob', displayName: 'Bob', channelConnected: true, termsVersion: 1, banned: null, warnings: [{ eventId: 'w1', reason: 'Keyword-Spam', at: '2026-10-15T12:00:00Z' }] },
  { pid: CAROL, login: 'carol', displayName: 'Carol', channelConnected: false, termsVersion: 0, banned: { reason: 'Bot-Verhalten', since: '2026-10-14T12:00:00Z' }, warnings: [] },
];

describe('Verwaltung · Streamer', () => {
  afterEach(() => vi.restoreAllMocks());

  it('shows search results with ban and warnings, asks for a reason before banning and calls POST /api/admin/bans', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ events: [] }), { status: 200, headers: { 'content-type': 'application/json' } }));
    render(Page, { props: { data: { me, q: 'b', streamers: results } } as never });
    expect(screen.getByText('Bob')).toBeInTheDocument();
    expect(screen.getByText('Keyword-Spam')).toBeInTheDocument();
    expect(screen.getByText(/Bot-Verhalten/)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: L.admin.lift })).toHaveLength(1);
    const banButtons = screen.getAllByRole('button', { name: L.admin.ban });
    expect(banButtons).toHaveLength(1);
    await fireEvent.click(banButtons[0]!);
    expect(fetchSpy).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog');
    await fireEvent.input(screen.getByLabelText(L.fields.reason), { target: { value: 'Bot-Verhalten' } });
    const confirm = screen.getAllByRole('button', { name: L.admin.ban }).find((b) => dialog.contains(b))!;
    await fireEvent.click(confirm);
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('/api/admin/bans');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ pid: BOB, reason: 'Bot-Verhalten' });
  });
});
