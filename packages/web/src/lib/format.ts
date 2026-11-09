// Zahlen, Zeiten und Dauern auf Deutsch. Rein, ohne Zustand. Die API liefert rohe Werte, die Oberfläche formatiert.

const DE = 'de-DE';
const MONTHS = ['Jan.', 'Feb.', 'März', 'Apr.', 'Mai', 'Juni', 'Juli', 'Aug.', 'Sep.', 'Okt.', 'Nov.', 'Dez.'];

/** Chance als Prozent mit zwei Nachkommastellen („0,23 %“), null oder NaN als „–“. */
export function percent(x: number | null): string {
  if (x === null || !Number.isFinite(x)) return '–';
  return new Intl.NumberFormat(DE, { style: 'percent', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(x);
}

/** Ganze Minuten: „0 min“, „37 min“, „1 h 23 min“, „100 h“. Negatives zählt als 0 (wie formatDuration im Kern-Vertrag). */
export function duration(sec: number): string {
  const minutes = Math.floor(Math.max(0, sec) / 60);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

interface Parts {
  day: number;
  month: number;
  year: number;
  hour: string;
  minute: string;
}

function parts(iso: string, timeZone?: string): Parts {
  const f = new Intl.DateTimeFormat('en-US', { ...(timeZone ? { timeZone } : {}), year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return { day: Number(p.day), month: Number(p.month), year: Number(p.year), hour: p.hour ?? '00', minute: p.minute ?? '00' };
}

/** „4. Okt., 16:02“ */
export function dateTime(iso: string, timeZone?: string): string {
  const p = parts(iso, timeZone);
  return `${p.day}. ${MONTHS[p.month - 1]}, ${p.hour}:${p.minute}`;
}

/** „30. Sep. 2026“ */
export function date(iso: string, timeZone?: string): string {
  const p = parts(iso, timeZone);
  return `${p.day}. ${MONTHS[p.month - 1]} ${p.year}`;
}

/** „gerade eben“, „vor 8 s“, „vor 6 min“, „vor 3 h“, „vor 1 Tag“, „vor 3 Tagen“ */
export function relative(iso: string, now: Date = new Date()): string {
  const sec = Math.floor((now.getTime() - Date.parse(iso)) / 1000);
  if (sec < 5) return 'gerade eben';
  if (sec < 60) return `vor ${sec} s`;
  if (sec < 3600) return `vor ${Math.floor(sec / 60)} min`;
  if (sec < 86_400) return `vor ${Math.floor(sec / 3600)} h`;
  const days = Math.floor(sec / 86_400);
  return days === 1 ? 'vor 1 Tag' : `vor ${days} Tagen`;
}

/** Tausenderpunkte: „4.812“ */
export function number(n: number): string {
  return new Intl.NumberFormat(DE, { maximumFractionDigits: 2 }).format(n);
}

/** Tage bis zu einem Zeitpunkt, aufgerundet, negativ wenn vorbei. */
export function daysUntil(iso: string, now: Date = new Date()): number {
  return Math.ceil((Date.parse(iso) - now.getTime()) / 86_400_000);
}
