import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import { KINDS } from '../announcements.test.js';
import AnnouncementsForm from './AnnouncementsForm.svelte';

describe('AnnouncementsForm', () => {
  it('shows a field per kind of the kernel with the default as placeholder, emits texts, muted and links; reset clears an entry', async () => {
    const onchange = vi.fn();
    render(AnnouncementsForm, { props: { kinds: KINDS, kernelId: 'instant', value: { muted: false, links: true, texts: { winner: 'Juhu {gewinner}' } }, onchange, errors: { winner: 'Zu kurz.' } } });
    const opened = screen.getByLabelText('Geöffnet') as HTMLTextAreaElement;
    expect(opened).toHaveAttribute('placeholder', KINDS[0]!.default);
    expect(opened.value).toBe('');
    expect(screen.getByLabelText('Anmeldefenster offen')).toBeInTheDocument();
    expect(screen.queryByLabelText('tickets_bought')).not.toBeInTheDocument();
    expect(screen.getByText('Zu kurz.')).toBeInTheDocument();
    expect(screen.getAllByText(/\{preis\} \{keyword\}/).length).toBeGreaterThan(0);
    await fireEvent.input(opened, { target: { value: 'Los {preis}' } });
    expect(onchange).toHaveBeenLastCalledWith({ muted: false, links: true, texts: { winner: 'Juhu {gewinner}', opened: 'Los {preis}' } });
    await fireEvent.click(screen.getByLabelText('Ansagen stumm'));
    expect(onchange).toHaveBeenLastCalledWith(expect.objectContaining({ muted: true }));
    await fireEvent.click(screen.getByLabelText('Link anhängen'));
    expect(onchange).toHaveBeenLastCalledWith(expect.objectContaining({ links: false }));
    // Nur die Gewinneransage hat einen eigenen Text, darum genau ein Zurücksetzen.
    const reset = screen.getAllByRole('button', { name: 'Zurücksetzen' });
    expect(reset).toHaveLength(1);
    await fireEvent.click(reset[0]!);
    expect(onchange).toHaveBeenLastCalledWith({ muted: false, links: true, texts: {} });
  });

  it('muted disables every template except the winner one', () => {
    render(AnnouncementsForm, { props: { kinds: KINDS, kernelId: 'instant', value: { muted: true, links: true, texts: {} }, onchange: vi.fn() } });
    expect(screen.getByLabelText('Geöffnet')).toBeDisabled();
    expect(screen.getByLabelText('Gewinner')).not.toBeDisabled();
  });
});
