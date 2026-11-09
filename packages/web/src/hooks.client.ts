// Fehler im Browser landen beim Betreiber (NEW_DESIGN.md 11.4 „Browser-Fehler“), ohne Personenbezug. Nur echte Ausnahmen, keine erwarteten Fehler.
import { createErrorReporter, makeHandleError } from '#lib/errors.js';

export const handleError = makeHandleError(createErrorReporter((...args) => globalThis.fetch(...args)));
