import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import { S } from '../texts/sentences.js';
import { L } from '../texts/labels.js';
import ActionBar from './ActionBar.svelte';

describe('ActionBar', () => {
  it('renders the rejection message inline after a failed command and keeps buttons enabled', async () => {
    const onaction = vi.fn();
    const confirmSpy = vi.spyOn(window, 'confirm');
    render(ActionBar, {
      props: {
        view: { primary: 'pause', others: ['close', 'draw', 'kernel:open_window', 'cancel'], hints: { draw: S.hints.drawAfterClose } },
        kernelLabels: { open_window: 'Anmeldefenster öffnen' },
        busy: null,
        error: 'Der Topf hat sich geändert. Ziehe erneut.',
        onaction,
      },
    });
    expect(screen.getByRole('alert')).toHaveTextContent('Der Topf hat sich geändert. Ziehe erneut.');
    const pause = screen.getByRole('button', { name: L.actions.pause });
    expect(pause).toBeEnabled();
    expect(pause.className).toContain('btn-primary');
    expect(screen.getByRole('button', { name: L.actions.draw })).toBeDisabled();
    expect(screen.getByText(S.hints.drawAfterClose)).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Anmeldefenster öffnen' }));
    expect(onaction).toHaveBeenCalledWith('kernel:open_window');
    await fireEvent.click(pause);
    expect(onaction).toHaveBeenCalledWith('pause');
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('cancel asks for confirmation inline, never via window.confirm', async () => {
    const onaction = vi.fn();
    const confirmSpy = vi.spyOn(window, 'confirm');
    render(ActionBar, { props: { view: { primary: 'open', others: ['settings', 'cancel'], hints: {} }, kernelLabels: {}, busy: null, error: null, onaction } });
    await fireEvent.click(screen.getByRole('button', { name: L.actions.cancel }));
    expect(onaction).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent(S.confirm.cancel);
    await fireEvent.click(screen.getAllByRole('button', { name: L.actions.cancel })[1]!);
    expect(onaction).toHaveBeenCalledWith('cancel');
    expect(confirmSpy).not.toHaveBeenCalled();
  });
});
