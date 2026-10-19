import { describe, expect, it } from 'vitest';
import { parseSort, sortRows } from './sort';

type R = { name: string; n: number | null };
const rows: R[] = [
  { name: 'b', n: 2 },
  { name: 'a', n: null },
  { name: 'c', n: 10 },
];

describe('sortRows', () => {
  it('sorts numbers descending and puts unknown values last', () => {
    expect(sortRows(rows, (r) => r.n, 'desc').map((r) => r.name)).toEqual(['c', 'b', 'a']);
  });
  it('sorts ascending with unknown values still last', () => {
    expect(sortRows(rows, (r) => r.n, 'asc').map((r) => r.name)).toEqual(['b', 'c', 'a']);
  });
  it('sorts text', () => {
    expect(sortRows(rows, (r) => r.name, 'asc').map((r) => r.name)).toEqual(['a', 'b', 'c']);
  });
  it('does not mutate its input', () => {
    const copy = [...rows];
    sortRows(rows, (r) => r.n, 'desc');
    expect(rows).toEqual(copy);
  });
});

describe('parseSort', () => {
  it('accepts a known key and direction, otherwise falls back', () => {
    expect(parseSort({ sort: 'price', dir: 'asc' }, ['profit', 'price'], 'profit')).toEqual({ key: 'price', dir: 'asc' });
    expect(parseSort({ sort: 'evil', dir: 'sideways' }, ['profit', 'price'], 'profit')).toEqual({ key: 'profit', dir: 'desc' });
  });
});
