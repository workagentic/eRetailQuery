import type { Overview } from '@erq/db';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@erq/ui';
import { formatBps, formatCents } from '@/lib/format';
import { TermTip } from './term-tip';

const LABEL = { shopify_online: 'Shopify', shopify_pos: 'Shopify POS', amazon: 'Amazon' } as const;

/** Shopify vs Amazon: revenue, money left after ads and margin, side by side. */
export function ChannelSplit({ channels }: { channels: Overview['byChannel'] }) {
  const max = Math.max(1, ...channels.map((c) => Math.abs(c.revenue.cents)));
  return (
    <Card>
      <CardHeader>
        <CardTitle>By sales channel</CardTitle>
        <CardDescription>
          Ad spend is counted against the channel the platform sells on (Amazon Ads to Amazon, the rest to Shopify).
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {channels.length === 0 && <p className="text-sm text-muted-foreground">No sales in this period.</p>}
        {channels.map((c) => (
          <div key={c.channel} className="flex flex-col gap-1">
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-medium">{LABEL[c.channel]}</span>
              <span className="text-sm tabular-nums">{formatCents(c.revenue.cents)} revenue</span>
            </div>
            <div className="h-2 rounded bg-muted" aria-hidden="true">
              <div
                className="h-2 rounded bg-primary"
                style={{ width: `${Math.max(2, Math.round((Math.abs(c.revenue.cents) / max) * 100))}%` }}
              />
            </div>
            <div className="text-sm text-muted-foreground tabular-nums">
              <TermTip term="afterAds">Money left after ads</TermTip>: {formatCents(c.profit.cents)} (
              {formatBps(c.marginBps)} of sales)
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
