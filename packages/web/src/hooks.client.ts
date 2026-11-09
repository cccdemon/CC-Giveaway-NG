// Fehler im Browser landen beim Betreiber (NEW_DESIGN.md 11.4 „Browser-Fehler“), ohne Personenbezug.
import type { HandleClientError } from '@sveltejs/kit/hooks';
import { createErrorReporter } from '#lib/errors.js';
import { S } from '#lib/texts/sentences.js';

const report = createErrorReporter((...args) => globalThis.fetch(...args));

export const handleError: HandleClientError = ({ error, event }) => {
  void report(error, event.url.href);
  return { message: S.serverError };
};
