/**
 * Führt `fn` sofort und danach immer `intervalMs` nach dem ENDE des vorigen Laufs aus.
 * Läufe überlappen nie, auch wenn einer länger dauert als das Intervall.
 * Ein abgelehnter Lauf geht an `onError` und stoppt die Schleife nicht.
 * `stop()` plant keinen weiteren Lauf und wartet auf den laufenden.
 */
export function scheduleLoop(
  fn: () => Promise<void>,
  intervalMs: number,
  onError: (e: unknown) => void = (e) => console.error(JSON.stringify({ msg: 'Ein geplanter Lauf ist fehlgeschlagen. Der nächste Lauf folgt wie geplant.', err: e instanceof Error ? e.stack : String(e) })),
): { stop(): Promise<void> } {
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> = Promise.resolve();
  let stopped = false;

  const run = () => {
    timer = undefined;
    let p: Promise<void>;
    try {
      p = fn();
    } catch (e) {
      p = Promise.reject(e);
    }
    running = p
      .catch(onError)
      .finally(() => {
        if (!stopped) timer = setTimeout(run, intervalMs);
      });
  };
  run();

  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await running;
    },
  };
}
