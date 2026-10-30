// Konsistenter Hash: Kanal → Worker (NEW_DESIGN.md 10.2). Rein.

/** FNV-1a 32 Bit, & 0x7fffffff. */
export function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash & 0x7fffffff;
}

export function shardOf(pid: string, workers: number): number {
  return fnv1a(pid) % workers;
}
