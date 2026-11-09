// Inline-Icons als Pfade (24er Raster, Strich 2). Kein Emoji, keine externe Icon-Schrift.

export type IconName = 'check' | 'pause' | 'play' | 'lock' | 'star' | 'warn' | 'bolt' | 'plus' | 'x' | 'circle' | 'dot' | 'undo' | 'live' | 'offline' | 'info' | 'arrow';

export const ICON_PATHS: Record<IconName, string[]> = {
  check: ['M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18', 'M8 12l3 3 5-6'],
  pause: ['M9 5v14M15 5v14'],
  play: ['M7 4l12 8-12 8z'],
  lock: ['M5 11h14v9H5z', 'M8 11V7a4 4 0 018 0v4'],
  star: ['M12 3l2.6 5.6 6 .7-4.5 4.1 1.2 6L12 16.4 6.7 19.4l1.2-6L3.4 9.3l6-.7z'],
  warn: ['M12 3l10 18H2z', 'M12 10v5M12 18v.5'],
  bolt: ['M13 3L5 14h6l-1 7 8-11h-6z'],
  plus: ['M12 5v14M5 12h14'],
  x: ['M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18', 'M9 9l6 6M15 9l-6 6'],
  circle: ['M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18'],
  dot: ['M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8'],
  undo: ['M9 14L4 9l5-5', 'M4 9h10a6 6 0 0 1 0 12h-3'],
  live: ['M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6', 'M5.6 5.6a9 9 0 0 0 0 12.8M18.4 5.6a9 9 0 0 1 0 12.8'],
  offline: ['M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6', 'M4 4l16 16'],
  info: ['M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18', 'M12 11v5M12 8v.5'],
  arrow: ['M5 12h14', 'M13 6l6 6-6 6'],
};
