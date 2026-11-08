import type { AnyKernel } from '../kernel-api/index.js';
import { JournalError } from '../journal/types.js';
import { instantKernel } from '../kernels/instant/index.js';
import { watchtimeKernel } from '../kernels/watchtime/index.js';

export const FRAMEWORK_REDUCER_VERSION = 5; // 2: DrawRecord.excluded, 3: registered[pid].eventId, 4: legal, legalEventId, 5: Dienste (seen, boost, …)

/** FNV-1a 32 Bit über `${frameworkVersion}` + je Kern `${id}@${version}` (nach id sortiert), & 0x7fffffff (F4). Rein. */
export function versionStamp(frameworkVersion: number, kernels: readonly { id: string; version: number }[]): number {
  const parts = [...kernels]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((k) => `${k.id}@${k.version}`);
  const text = [`${frameworkVersion}`, ...parts].join('|');
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash & 0x7fffffff;
}

/** Ein Chat-Wort eines Kern-Befehls: ein Wort ohne Leerzeichen, wie das Keyword der Anmeldung. */
export const CHAT_WORD_RE = /^\S{2,32}$/;

export class KernelRegistry {
  private readonly kernels = new Map<string, AnyKernel>();

  register(k: AnyKernel): void {
    if (this.kernels.has(k.id)) throw new Error(`Kern ${k.id} ist schon registriert.`);
    for (const e of k.events) {
      if (!e.type.startsWith(`${k.id}_`)) {
        throw new Error(`Ereignistyp ${e.type} braucht das Präfix ${k.id}_ des Kerns.`);
      }
    }
    const seen = new Set<string>();
    const words = new Set<string>();
    for (const c of k.commands) {
      if (c.type.includes(':')) {
        throw new Error(`Der Befehlstyp ${c.type} darf keinen Doppelpunkt enthalten. Der ist für Rahmen-Zeitgeber reserviert.`);
      }
      if (seen.has(c.type)) throw new Error(`Befehl ${c.type} steht im Kern ${k.id} doppelt.`);
      seen.add(c.type);
      if (c.chat) {
        if (c.issuer !== 'participant') throw new Error(`Der Chat-Befehl ${c.type} braucht issuer 'participant'.`);
        if (!CHAT_WORD_RE.test(c.chat.word)) throw new Error(`Das Chat-Wort ${c.chat.word} ist ein Wort mit 2 bis 32 Zeichen ohne Leerzeichen.`);
        const word = c.chat.word.toLowerCase();
        if (words.has(word)) throw new Error(`Das Chat-Wort ${c.chat.word} steht im Kern ${k.id} doppelt.`);
        words.add(word);
      }
    }
    this.kernels.set(k.id, k);
  }

  get(id: string): AnyKernel {
    const k = this.kernels.get(id);
    if (!k) throw new JournalError('unknown_kernel', `Unbekannter Kern: ${id}. Prüfe die Registry.`);
    return k;
  }

  has(id: string): boolean {
    return this.kernels.has(id);
  }

  list(): AnyKernel[] {
    return [...this.kernels.values()];
  }

  versionStamp(): number {
    return versionStamp(FRAMEWORK_REDUCER_VERSION, this.list());
  }
}

export function defaultKernels(): KernelRegistry {
  const r = new KernelRegistry();
  r.register(instantKernel);
  r.register(watchtimeKernel);
  return r;
}
