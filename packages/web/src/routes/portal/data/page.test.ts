import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Me } from '#lib/api/types.js';
import { L } from '#lib/texts/labels.js';
import Page from './+page.svelte';

const me: Me = { pid: 'a1', login: 'alice', displayName: 'Alice', soloTeamId: 's', termsVersion: 1, currentTermsVersion: 1, channelConnected: false, legal: { impressumUrl: null, terms: null, privacyUrl: null } };

describe('Meine Daten', () => {
  afterEach(() => vi.restoreAllMocks());

  it('deleting asks for inline confirmation and calls DELETE /api/me only after confirm', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
    const confirmSpy = vi.spyOn(window, 'confirm');
    render(Page, { props: { data: { me } } as never });
    expect(screen.getByRole('link', { name: L.actions.download })).toHaveAttribute('href', '/api/me/data');
    await fireEvent.click(screen.getByRole('button', { name: L.actions.deleteAll }));
    expect(fetchSpy).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeInTheDocument();
    const confirmButton = screen.getAllByRole('button', { name: L.actions.deleteAll }).find((b) => dialog.contains(b))!;
    await fireEvent.click(confirmButton);
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('/api/me');
    expect(init?.method).toBe('DELETE');
    expect(confirmSpy).not.toHaveBeenCalled();
  });
});
