import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { decrypt, encrypt, loadTokenKey } from '../src/identity/crypto.js';

async function keyFile(content: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'key-'));
  const file = path.join(dir, 'token.key');
  await writeFile(file, content);
  return file;
}

describe('encrypt/decrypt', () => {
  it('round-trips and never repeats the IV', () => {
    const key = randomBytes(32);
    const a = encrypt('tok', key);
    const b = encrypt('tok', key);
    expect(decrypt(a, key)).toBe('tok');
    expect(decrypt(b, key)).toBe('tok');
    expect(a.equals(b)).toBe(false);
    expect(a.length).toBe(12 + 16 + 3);
  });

  it('decrypt with the wrong key throws', () => {
    const blob = encrypt('tok', randomBytes(32));
    expect(() => decrypt(blob, randomBytes(32))).toThrow();
  });

  it('decrypt of a tampered blob throws', () => {
    const key = randomBytes(32);
    const blob = encrypt('geheim', key);
    blob[blob.length - 1] = (blob[blob.length - 1] ?? 0) ^ 0xff;
    expect(() => decrypt(blob, key)).toThrow();
  });
});

describe('loadTokenKey', () => {
  it('reads 64 hex chars (with trailing newline) as 32 bytes', async () => {
    const hex = randomBytes(32).toString('hex');
    const key = await loadTokenKey(await keyFile(`${hex}\n`));
    expect(key.toString('hex')).toBe(hex);
  });

  it('rejects anything else with a German hint naming the file', async () => {
    const file = await keyFile('zu-kurz');
    await expect(loadTokenKey(file)).rejects.toThrow(/64 Hex-Zeichen.*openssl rand -hex 32/);
    await expect(loadTokenKey(file)).rejects.toThrow(file);
  });

  it('names a missing file', async () => {
    await expect(loadTokenKey(path.join(tmpdir(), 'gibt-es-nicht.key'))).rejects.toThrow(/gibt-es-nicht\.key/);
  });
});
