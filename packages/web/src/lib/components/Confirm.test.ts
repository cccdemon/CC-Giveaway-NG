import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import { L } from '../texts/labels.js';
import { S } from '../texts/sentences.js';
import Confirm from './Confirm.svelte';

describe('Confirm', () => {
  it('requires a reason when reason is true and never calls window.confirm', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    const onconfirm = vi.fn();
    const oncancel = vi.fn();
    render(Confirm, { props: { title: 'Rückgängig?', text: 'Das Ereignis wird aufgehoben.', reason: true, confirmLabel: L.actions.revert, onconfirm, oncancel } });
    await fireEvent.click(screen.getByRole('button', { name: L.actions.revert }));
    expect(onconfirm).not.toHaveBeenCalled();
    expect(screen.getByText(S.reasonRequired)).toBeInTheDocument();
    await fireEvent.input(screen.getByLabelText(L.fields.reason), { target: { value: 'Zu früh' } });
    await fireEvent.click(screen.getByRole('button', { name: L.actions.revert }));
    expect(onconfirm).toHaveBeenCalledWith('Zu früh');
    await fireEvent.click(screen.getByRole('button', { name: L.actions.abort }));
    expect(oncancel).toHaveBeenCalledTimes(1);
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('without reason confirms directly and focuses the panel', async () => {
    const onconfirm = vi.fn();
    render(Confirm, { props: { title: 'Abbrechen?', text: 'Das Giveaway endet ohne Ziehung.', confirmLabel: L.actions.cancel, onconfirm, oncancel: () => undefined } });
    expect(document.activeElement).toBe(screen.getByRole('dialog'));
    await fireEvent.click(screen.getByRole('button', { name: L.actions.cancel }));
    expect(onconfirm).toHaveBeenCalledWith(undefined);
  });
});
