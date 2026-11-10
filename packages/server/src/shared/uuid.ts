// UUID Version 5 (RFC 4122, SHA-1): dieselbe Alt-ID ergibt immer dieselbe UUID (NEW_DESIGN.md 15.6, Idempotenz).
import { createHash } from 'node:crypto';

const HEX32 = /^[0-9a-f]{32}$/i;

export function uuidV5(namespace: string, name: string): string {
  const nsHex = namespace.replaceAll('-', '');
  if (!HEX32.test(nsHex)) throw new Error(`Kein gültiger UUID-Namensraum: ${namespace}`);
  const h = createHash('sha1').update(Buffer.from(nsHex, 'hex')).update(Buffer.from(name, 'utf8')).digest();
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const hex = h.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
