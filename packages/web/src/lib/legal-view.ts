// Rechtstexte in einer Form für die Anzeige: eingefroren (mit Hash) oder aus dem Profil.
import type { FrozenLegal, LegalTexts } from './api/types.js';

export interface LegalView {
  impressumUrl: string | null;
  termsText: string | null;
  termsUrl: string | null;
  privacyUrl: string | null;
}

export function legalView(legal: FrozenLegal | LegalTexts | null): LegalView {
  const empty: LegalView = { impressumUrl: null, termsText: null, termsUrl: null, privacyUrl: null };
  if (!legal) return empty;
  if ('impressumUrl' in legal) {
    const terms = legal.terms;
    return {
      impressumUrl: legal.impressumUrl,
      termsText: terms && 'text' in terms ? terms.text : null,
      termsUrl: terms && 'url' in terms ? terms.url : null,
      privacyUrl: legal.privacyUrl,
    };
  }
  const terms = legal.terms;
  return {
    impressumUrl: legal.impressum?.url ?? null,
    termsText: terms && 'text' in terms ? terms.text : null,
    termsUrl: terms && 'url' in terms ? terms.url : null,
    privacyUrl: legal.privacy?.url ?? null,
  };
}
