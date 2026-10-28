/** JSON mit sortierten Schlüsseln. JSONB ordnet Schlüssel beim Speichern um, darum vergleicht man so. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_k, x: unknown) =>
    x !== null && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : x,
  );
}
