import Link from 'next/link';
import type { ReactNode } from 'react';
import type { Dir } from '@/lib/sort';

export interface Column<T> {
  key: string;
  label: ReactNode;
  align?: 'right';
  /** Sortable columns render their header as a link. */
  sortable?: boolean;
  cell: (row: T) => ReactNode;
}

/** A server-rendered table. Sorting is a link (?sort=&dir=), so it works without client JavaScript. */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  sort,
  hrefFor,
  caption,
  empty,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  sort?: { key: string; dir: Dir };
  hrefFor?: (key: string, dir: Dir) => string;
  caption: string;
  empty: ReactNode;
}) {
  if (rows.length === 0) return <div className="text-sm text-muted-foreground">{empty}</div>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-border text-left">
            {columns.map((c) => {
              const active = sort?.key === c.key;
              const next: Dir = active && sort?.dir === 'desc' ? 'asc' : 'desc';
              return (
                <th
                  key={c.key}
                  scope="col"
                  aria-sort={active ? (sort?.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                  className={`whitespace-nowrap px-2 py-2 font-medium ${c.align === 'right' ? 'text-right' : ''}`}
                >
                  {c.sortable && hrefFor ? (
                    <Link href={hrefFor(c.key, next)} className="underline-offset-4 hover:underline">
                      {c.label}
                      {active ? (sort?.dir === 'asc' ? ' ▲' : ' ▼') : ''}
                    </Link>
                  ) : (
                    c.label
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)} className="border-b border-border align-top">
              {columns.map((c) => (
                <td
                  key={c.key}
                  className={`px-2 py-2 ${c.align === 'right' ? 'text-right tabular-nums' : ''}`}
                >
                  {c.cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
