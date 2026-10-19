import type { SearchParams } from './filters';

export type Dir = 'asc' | 'desc';

/** Sorts a copy of rows; unknown (null) values always go last, in either direction. */
export function sortRows<T>(rows: T[], get: (row: T) => number | string | null, dir: Dir): T[] {
  const sign = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = get(a);
    const y = get(b);
    if (x === null && y === null) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    if (typeof x === 'number' && typeof y === 'number') return sign * (x - y);
    return sign * String(x).localeCompare(String(y));
  });
}

const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

/** Reads ?sort= and ?dir= against an allow-list; anything else falls back to the default, descending. */
export function parseSort(
  params: SearchParams,
  keys: readonly string[],
  fallback: string,
): { key: string; dir: Dir } {
  const key = first(params.sort);
  const dir = first(params.dir);
  return {
    key: keys.includes(key ?? '') ? (key as string) : fallback,
    dir: dir === 'asc' ? 'asc' : 'desc',
  };
}
