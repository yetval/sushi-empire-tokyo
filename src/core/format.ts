const UNITS = ['', 'K', 'M', 'B', 'T', 'Qa', 'Qi', 'Sx', 'Sp', 'Oc', 'No', 'Dc'];

/** 1234 → "1,234"; 1.5e6 → "1.5M"; 2.58e7 → "25.8M"; 1.2e9 → "1.2B". */
export function short(n: number, digits = 1): string {
  if (Number.isNaN(n)) return '—';
  if (!Number.isFinite(n)) return '∞';
  const neg = n < 0; n = Math.abs(n);
  if (n < 10_000) return (neg ? '-' : '') + Math.floor(n).toLocaleString('en-US');
  let i = 0;
  while (n >= 999.5 && i < UNITS.length - 1) { n /= 1000; i++; }
  const s = n >= 100 ? n.toFixed(0) : n.toFixed(digits).replace(/\.0+$/, '');
  return (neg ? '-' : '') + s + UNITS[i];
}

export const yen = (n: number) => (n < 0 ? '-¥' : '¥') + short(Math.abs(n));
export const exact = (n: number) => Math.floor(n).toLocaleString('en-US');
export const yenExact = (n: number) => (n < 0 ? '-¥' : '¥') + exact(Math.abs(n));

export function clockStr(minute: number): string {
  const h = Math.floor(minute / 60) % 24, m = Math.floor(minute % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function duration(sec: number): string {
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  return h ? `${h}h ${m}m` : m ? `${m}m ${sec % 60}s` : `${sec}s`;
}
