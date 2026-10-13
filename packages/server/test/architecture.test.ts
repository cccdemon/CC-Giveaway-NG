import { ESLint } from 'eslint';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const eslint = new ESLint({ cwd: root });

async function restricted(file: string, code: string): Promise<boolean> {
  const [result] = await eslint.lintText(code, { filePath: path.join(root, file) });
  return (result?.messages ?? []).some((m) => m.ruleId === 'no-restricted-imports');
}

describe('Modulgrenzen (NEW_DESIGN.md 3.4)', () => {
  it('kernel darf journal nicht importieren', async () => {
    expect(await restricted('src/kernels/demo/index.ts', "import { x } from '../../journal/journal.js';\nexport const y = x;\n")).toBe(true);
  });
  it('kernel darf framework nicht importieren', async () => {
    expect(await restricted('src/kernels/demo/index.ts', "import { x } from '../../framework/command-bus.js';\nexport const y = x;\n")).toBe(true);
  });
  it('kernel darf keinen anderen kernel importieren', async () => {
    expect(await restricted('src/kernels/demo/index.ts', "import { x } from '../other/index.js';\nexport const y = x;\n")).toBe(true);
  });
  it('kernel darf pg und node-Module nicht importieren', async () => {
    expect(await restricted('src/kernels/demo/index.ts', "import pg from 'pg';\nexport const y = pg;\n")).toBe(true);
    expect(await restricted('src/kernels/demo/index.ts', "import fs from 'node:fs';\nexport const y = fs;\n")).toBe(true);
  });
  it('kernel darf kernel-api und eigene Dateien importieren', async () => {
    expect(await restricted('src/kernels/demo/index.ts', "import type { X } from '../../kernel-api/index.js';\nimport { h } from './helper.js';\nexport const y: X | undefined = h;\n")).toBe(false);
  });
  it('kernel darf kein fremdes kernel-api-Segment über Pfad erreichen', async () => {
    expect(await restricted('src/kernels/demo/index.ts', "import { x } from '../x/kernel-api/index.js';\nexport const y = x;\n")).toBe(true);
  });
  it('kernel darf kein Modul namens kernel-api über Pfad erreichen', async () => {
    expect(await restricted('src/kernels/demo/index.ts', "import { x } from '../journal/kernel-api.js';\nexport const y = x;\n")).toBe(true);
  });
  it('kernel darf keine I/O-Unterpfade wie fs/promises importieren', async () => {
    expect(await restricted('src/kernels/demo/index.ts', "import fs from 'fs/promises';\nexport const y = fs;\n")).toBe(true);
  });
  it('kernel-api darf keine I/O-Unterpfade wie fs/promises importieren', async () => {
    expect(await restricted('src/kernel-api/index.ts', "import fs from 'fs/promises';\nexport const y = fs;\n")).toBe(true);
  });
  it('kernel darf keine Unterpfade von pg importieren', async () => {
    expect(await restricted('src/kernels/demo/index.ts', "import x from 'pg/lib/client';\nexport const y = x;\n")).toBe(true);
  });
  it('kernel-api importiert nichts aus src', async () => {
    expect(await restricted('src/kernel-api/index.ts', "import { x } from '../journal/types.js';\nexport const y = x;\n")).toBe(true);
  });
});
