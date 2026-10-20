import type { AttentionItem } from '@erq/db';
import { AlertTriangle, ArrowRight, Megaphone, PackageMinus, Tag, Unplug, type LucideIcon } from 'lucide-react';
import Link from 'next/link';
import { formatCents } from '@/lib/format';
import { Panel } from './page-kit';

const SEVERITY = { 3: 'High', 2: 'Medium', 1: 'Low' } as const;
const TONE = {
  3: 'bg-loss-soft text-loss',
  2: 'bg-warn-soft text-warn',
  1: 'bg-muted text-muted-foreground',
} as const;
const ICON: Record<AttentionItem['kind'], LucideIcon> = {
  losing_ad: Megaphone,
  underpriced: Tag,
  amazon_loss: AlertTriangle,
  low_stock: PackageMinus,
};

/** "What needs your attention": the top items, each with why it fired and what to do. */
export function AttentionFeed({ items }: { items: AttentionItem[] }) {
  return (
    <Panel
      title="What needs your attention"
      description="The biggest money questions right now, with what to do about each."
    >
      {items.length === 0 ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Unplug aria-hidden="true" className="size-4" />
          Nothing needs your attention right now. A good next step is to{' '}
          <Link href="/products" className="font-medium text-primary underline underline-offset-4">
            review your prices
          </Link>
          .
        </p>
      ) : (
        <ol className="flex flex-col divide-y divide-border/70">
          {items.map((item) => {
            const Icon = ICON[item.kind];
            return (
              <li key={`${item.kind}:${item.title}`} className="flex gap-4 py-4 first:pt-0 last:pb-0">
                <span className={`mt-0.5 grid size-9 shrink-0 place-items-center rounded-xl ${TONE[item.severity]}`}>
                  <Icon aria-hidden="true" className="size-[18px]" strokeWidth={1.9} />
                </span>
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${TONE[item.severity]}`}>
                      {SEVERITY[item.severity]}
                    </span>
                    <span className="text-sm font-semibold text-foreground">{item.title}</span>
                    {item.stakeCents > 0 && (
                      <span className="text-xs text-muted-foreground">About {formatCents(item.stakeCents)} at stake</span>
                    )}
                  </div>
                  <p className="text-[13px] leading-relaxed text-muted-foreground">{item.why}</p>
                  <p className="text-[13px] text-foreground">
                    <span className="font-semibold">What to do: </span>
                    {item.action}{' '}
                    <Link
                      href={item.href}
                      className="inline-flex items-center gap-0.5 font-medium text-primary underline-offset-4 hover:underline"
                    >
                      Take a look
                      <ArrowRight aria-hidden="true" className="size-3.5" />
                    </Link>
                  </p>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </Panel>
  );
}
