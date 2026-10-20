import { getAttention, getOverview } from '@erq/db';
import { AttentionFeed } from '@/components/attention-feed';
import { ChannelBars } from '@/components/channel-bars';
import { FilterBar } from '@/components/filter-bar';
import { KpiStrip } from '@/components/kpi-strip';
import { Notice, PageHeader, Panel } from '@/components/page-kit';
import { SalesSplit } from '@/components/sales-split';
import { TrendChart } from '@/components/trend-chart';
import { CHANNEL_NAME } from '@/lib/chart-colors';
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
    attention: await getAttention(tx, {
      range: ctx.range,
      previous: ctx.previous,
      asOf: ctx.asOf,
      channel: ctx.filters.channel,
    }),
  }));
  const empty = overview.kpis.orders.value === 0 && overview.kpis.orders.previous === 0;

  return (
    <>
      <PageHeader
        title={ctx.orgName}
        description={`Am I making money? Data as of ${overview.asOf}, showing ${ctx.range.from} to ${ctx.range.to}.`}
        actions={<FilterBar path="/dashboard" filters={ctx.filters} />}
      />
      {!overview.costComplete && (
        <Notice>
          Some products have no cost on record, so profit may look better than it is. Add their costs on the
          Products page.
        </Notice>
      )}
      {empty ? (
        <Panel title="No sales in this period" description="Try a longer date range, or connect a store to see your profit.">
          <p className="text-sm text-muted-foreground">Nothing to show yet.</p>
        </Panel>
      ) : (
        <>
          <KpiStrip kpis={overview.kpis} daily={overview.daily} />
          <SalesSplit breakdown={overview.breakdown} />
          <div className="grid gap-6 xl:grid-cols-3">
            <Panel
              className="xl:col-span-2"
              title="Revenue and money left after ads"
              description="Day by day for the selected period."
            >
              <TrendChart data={overview.daily} />
            </Panel>
            <Panel
              title="By sales channel"
              description="Ad spend counts against the channel the platform sells on."
            >
              <ChannelBars
                data={overview.byChannel.map((c) => ({
                  name: CHANNEL_NAME[c.channel] ?? c.channel,
                  revenue: c.revenue.cents,
                  profit: c.profit.cents,
                }))}
              />
            </Panel>
          </div>
          <AttentionFeed items={attention} />
        </>
      )}
    </>
  );
}
