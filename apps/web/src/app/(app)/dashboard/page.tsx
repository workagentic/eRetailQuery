import { getAttention, getOverview } from '@erq/db';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@erq/ui';
import { AttentionFeed } from '@/components/attention-feed';
import { ChannelSplit } from '@/components/channel-split';
import { FilterBar } from '@/components/filter-bar';
import { KpiStrip } from '@/components/kpi-strip';
import { TrendChart } from '@/components/trend-chart';
import type { SearchParams } from '@/lib/filters';
import { loadReportContext } from '@/lib/report-context';

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const ctx = await loadReportContext(await searchParams);
  const { overview, attention } = await ctx.db.withTenant(ctx.orgId, async (tx) => ({
    overview: await getOverview(tx, { range: ctx.range, previous: ctx.previous, channel: ctx.filters.channel }),
    attention: await getAttention(tx, { range: ctx.range, previous: ctx.previous, asOf: ctx.asOf }),
  }));
  const empty = overview.kpis.orders.value === 0 && overview.kpis.orders.previous === 0;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{ctx.orgName}</h1>
        <p className="text-sm text-muted-foreground">
          Am I making money? Data as of {overview.asOf} ({ctx.range.from} to {ctx.range.to}).
        </p>
      </div>
      <FilterBar path="/dashboard" filters={ctx.filters} />
      {!overview.costComplete && (
        <p role="status" className="rounded-md border border-border bg-muted p-3 text-sm">
          Some products have no cost on record, so profit may look better than it is. Add their costs on the
          Products page.
        </p>
      )}
      {empty ? (
        <Card>
          <CardHeader>
            <CardTitle>No sales in this period</CardTitle>
            <CardDescription>Try a longer date range, or connect a store to see your profit.</CardDescription>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">Nothing to show yet.</CardContent>
        </Card>
      ) : (
        <>
          <KpiStrip kpis={overview.kpis} />
          <AttentionFeed items={attention} />
          <Card>
            <CardHeader>
              <CardTitle>Revenue and money left after ads</CardTitle>
              <CardDescription>Day by day for the selected period.</CardDescription>
            </CardHeader>
            <CardContent>
              <TrendChart data={overview.daily} />
            </CardContent>
          </Card>
          <ChannelSplit channels={overview.byChannel} />
        </>
      )}
    </div>
  );
}
