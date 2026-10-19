import type { AttentionItem } from '@erq/db';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@erq/ui';
import Link from 'next/link';
import { formatCents } from '@/lib/format';

const SEVERITY = { 3: 'High', 2: 'Medium', 1: 'Low' } as const;

/** "What needs your attention": the top items, each with why it fired and what to do. */
export function AttentionFeed({ items }: { items: AttentionItem[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>What needs your attention</CardTitle>
        <CardDescription>The biggest money questions right now, with what to do about each.</CardDescription>
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing needs your attention right now. A good next step is to{' '}
            <Link href="/products" className="underline">
              review your prices
            </Link>
            .
          </p>
        ) : (
          <ol className="flex flex-col divide-y divide-border">
            {items.map((item) => (
              <li key={`${item.kind}:${item.title}`} className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="rounded border border-border px-1.5 text-xs font-medium">
                    {SEVERITY[item.severity]}
                  </span>
                  <span className="font-medium">{item.title}</span>
                  {item.stakeCents > 0 && (
                    <span className="text-xs text-muted-foreground">
                      About {formatCents(item.stakeCents)} at stake
                    </span>
                  )}
                </div>
                <p className="text-sm text-muted-foreground">{item.why}</p>
                <p className="text-sm">
                  <span className="font-medium">What to do: </span>
                  {item.action}{' '}
                  <Link href={item.href} className="underline">
                    Take a look
                  </Link>
                </p>
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}
