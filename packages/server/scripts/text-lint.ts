// Deutscher Text-Linter (NEW_DESIGN.md 11.6, 12.2): prüft alle UI- und Fehlertexte in src/**/*.ts. Exit 1 bei Treffern.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkText, extractUiTexts } from '../src/shared/text-rules.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const srcDir = join(root, 'src');

const files = readdirSync(srcDir, { recursive: true, withFileTypes: true })
  .filter((d) => d.isFile() && d.name.endsWith('.ts'))
  .map((d) => join(d.parentPath, d.name))
  .sort();

let problems = 0;
let checked = 0;
for (const file of files) {
  const source = readFileSync(file, 'utf8');
  for (const { text, line } of extractUiTexts(source)) {
    // Ein einzelnes Wort ohne Leerzeichen ist ein Code (z. B. zod-Meldung 'url'), kein Text für Menschen.
    if (!/\s/.test(text.trim())) continue;
    checked += 1;
    const reasons = checkText(text);
    if (reasons.length === 0) continue;
    problems += 1;
    console.log(`${relative(root, file).replaceAll('\\', '/')}:${line}: ${reasons.join(', ')} – ${text}`);
  }
}

console.log(`${checked} Texte geprüft, ${problems} Verstöße.`);
process.exitCode = problems > 0 ? 1 : 0;
