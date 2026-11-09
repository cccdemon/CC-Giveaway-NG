import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import type { LegalTexts } from '../api/types.js';
import { L } from '../texts/labels.js';
import LegalForm from './LegalForm.svelte';

const EMPTY: LegalTexts = { impressumUrl: null, terms: null, privacyUrl: null };

describe('LegalForm', () => {
  it('switches terms between text and url and submits a LegalTexts object with nulls for empty fields', async () => {
    const onsubmit = vi.fn();
    render(LegalForm, { props: { value: EMPTY, onsubmit } });
    await fireEvent.input(screen.getByLabelText(L.fields.impressumUrl), { target: { value: 'https://x.example/impressum' } });
    await fireEvent.click(screen.getByLabelText(L.fields.termsUrl));
    await fireEvent.input(screen.getByLabelText(L.fields.terms), { target: { value: 'https://x.example/teilnahme' } });
    await fireEvent.click(screen.getByRole('button', { name: L.actions.save }));
    expect(onsubmit).toHaveBeenLastCalledWith({ impressumUrl: 'https://x.example/impressum', terms: { url: 'https://x.example/teilnahme' }, privacyUrl: null });
    await fireEvent.click(screen.getByLabelText(L.fields.termsText));
    await fireEvent.input(screen.getByLabelText(L.fields.terms), { target: { value: 'Teilnahme ab 18.' } });
    await fireEvent.input(screen.getByLabelText(L.fields.privacyUrl), { target: { value: 'https://x.example/datenschutz' } });
    await fireEvent.click(screen.getByRole('button', { name: L.actions.save }));
    expect(onsubmit).toHaveBeenLastCalledWith({ impressumUrl: 'https://x.example/impressum', terms: { text: 'Teilnahme ab 18.' }, privacyUrl: 'https://x.example/datenschutz' });
  });

  it('renders the save button without copper when primary is false (wizard step 5)', () => {
    render(LegalForm, { props: { value: EMPTY, onsubmit: vi.fn(), primary: false } });
    expect(screen.getByRole('button', { name: L.actions.save }).className).not.toContain('btn-primary');
    render(LegalForm, { props: { value: EMPTY, onsubmit: vi.fn() } });
    expect(screen.getAllByRole('button', { name: L.actions.save })[1]!.className).toContain('btn-primary');
  });

  it('starts from existing values and shows the checklist of required contents', () => {
    render(LegalForm, { props: { value: { impressumUrl: 'https://x.example/i', terms: { text: 'Regeln.' }, privacyUrl: null }, onsubmit: vi.fn() } });
    expect(screen.getByLabelText(L.fields.impressumUrl)).toHaveValue('https://x.example/i');
    expect(screen.getByLabelText(L.fields.terms)).toHaveValue('Regeln.');
    expect(screen.getByLabelText(L.fields.termsText)).toBeChecked();
    expect(screen.getByRole('list', { name: L.legal.checklist })).toBeInTheDocument();
  });
});
