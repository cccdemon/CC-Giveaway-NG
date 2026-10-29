// AES-256-GCM für Kanal-Tokens (NEW_DESIGN.md 10.2). Blob = 12 Byte IV | 16 Byte Tag | Chiffrat.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_HEX_RE = /^[0-9a-f]{64}$/i;

export function encrypt(plain: string, key: Buffer): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

export function decrypt(blob: Buffer, key: Buffer): string {
  if (blob.length < IV_BYTES + TAG_BYTES) throw new Error('Der verschlüsselte Wert ist zu kurz.');
  const iv = blob.subarray(0, IV_BYTES);
  const tag = blob.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const body = blob.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}

/** Liest die Schlüsseldatei: 64 Hex-Zeichen (32 Byte), Leerraum am Rand ist erlaubt. */
export async function loadTokenKey(path: string): Promise<Buffer> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (e) {
    throw new Error(`Die Schlüsseldatei ${path} lässt sich nicht lesen: ${(e as Error).message}. Lege sie an mit: openssl rand -hex 32 > ${path}`);
  }
  const hex = text.trim();
  if (!KEY_HEX_RE.test(hex)) {
    throw new Error(`Die Schlüsseldatei ${path} muss 64 Hex-Zeichen enthalten. Erzeuge sie mit: openssl rand -hex 32`);
  }
  return Buffer.from(hex, 'hex');
}
