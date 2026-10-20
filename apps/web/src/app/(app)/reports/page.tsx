import { getMonthlyPnl } from '@erq/db';
import { Sparkles } from 'lucide-react';
import Link from 'next/link';
import { DataTable } from '@/components/data-table';
import { FilterBar } from '@/components/filter-bar';
import { PageHeader, Panel } from '@/components/page-kit';
import { PnlTable } from '@/components/pnl-table';
import { PnlWaterfall } from '@/components/pnl-waterfall';
import { PlatformBadge } from '@/components/platform-badge';
import { CHANNEL_NAME, PLATFORM_NAME } from '@/lib/chart-colors';
import { parseMonth, type SearchParams } from '@/lib/filters';
import { formatBps, formatCents } from '@/lib/format';
import { monthLabel, recentMonths, shiftMonth } from '@/lib/months';
import { loadReportContext } from '@/lib/report-context';

export default async function ReportsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const ctx = await loadReportContext(params);
  // Default to the last complete month: the month before the newest day of data.
  const latestComplete = shiftMonth(ctx.asOf.slice(0, 7), -1);
  const month = parseMonth(params.month) ?? latestComplete;
  const pnl = await ctx.db.withTenant(ctx.orgId, (tx) =>
    getMonthlyPnl(tx, { month, channel: ctx.filters.channel }),
  );
  const href = (m: string) => `/reports?month=${m}&channel=${ctx.filters.channel}`;
  const c = pnl.current;
  const breakdown = {
    netSalesCents: c.netSales.cents,
    cogsCents: c.cogs.cents,
    fulfillmentCents: c.fulfillment.cents,
    feesCents: c.paymentFees.cents + c.marketplaceFees.cents,
    adSpendCents: c.adSpend.total.cents,
    profitCents: c.netContributionAfterMarketing.cents,
  };

  return (
    <>
      <PageHeader
        title={`Profit and loss: ${monthLabel(month)}`}
        description="From what you sold down to what is left, with the ad platforms that earned it or lost it."
        actions={<FilterBar path="/reports" query={{ month }} filters={ctx.filters} showRange={false} />}
      />
      <nav aria-label="Month" className="flex flex-wrap items-center gap-2 text-[13px]">
        <Link href={href(shiftMonth(month, -1))} className="rounded-lg border border-border bg-surface px-3 py-1.5 font-medium hover:bg-muted">
          Previous month
        </Link>
        {month < latestComplete && (
          <Link href={href(shiftMonth(month, 1))} className="rounded-lg border border-border bg-surface px-3 py-1.5 font-medium hover:bg-muted">
            Next month
          </Link>
        )}
        <span className="px-1 text-muted-foreground">Jump to</span>
        <div className="inline-flex flex-wrap gap-1 rounded-xl bg-muted p-1">
          {recentMonths(latestComplete, 6).map((m) => (
            <Link
              key={m}
              href={href(m)}
              aria-current={m === month ? 'true' : undefined}
              className={`rounded-lg px-2.5 py-1 font-medium transition-colors ${
                m === month ? 'bg-surface text-foreground shadow-[0_1px_2px_rgb(15_31_42/0.12)]' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {m}
            </Link>
          ))}
        </div>
      </nav>

      {pnl.callouts.length > 0 && (
        <section className="flex gap-4 rounded-[14px] border border-brand/25 bg-brand-soft p-5">
          <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-brand text-white">
            <Sparkles aria-hidden="true" className="size-[18px]" strokeWidth={1.9} />
          </span>
          <div className="flex flex-col gap-1">
            <h2 className="text-[15px] font-semibold text-[#115e59]">In plain English</h2>
            <ul className="flex flex-col gap-1 text-sm text-[#134e4a]">
              {pnl.callouts.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        </section>
      )}

      <Panel title="Where the month's sales went" description="Net sales stepping down through each cost to the money left after ads.">
        <PnlWaterfall breakdown={breakdown} />
      </Panel>

      <Panel
        title="Profit and loss"
        description="Compared with the month before and the same month a year ago. Costs use what each unit cost on the day it sold."
      >
        <PnlTable
          current={pnl.current}
          previous={pnl.previous}
          sameMonthLastYear={pnl.sameMonthLastYear}
          comparison={pnl.comparison}
          costComplete={pnl.costComplete}
        />
      </Panel>

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title="By sales channel">
          <DataTable
            caption="Net sales and profit by sales channel"
            columns={[
              { key: 'channel', label: 'Channel', cell: (r: (typeof pnl.byChannel)[number]) => <span className="font-medium">{CHANNEL_NAME[r.channel] ?? r.channel}</span> },
              { key: 'sales', label: 'Net sales', align: 'right', cell: (r) => formatCents(r.pnl.netSales.cents) },
              { key: 'contribution', label: 'After fees', align: 'right', cell: (r) => formatCents(r.pnl.contributionMargin.cents) },
              {
                key: 'after',
                label: 'After ads',
                align: 'right',
                cell: (r) => `${formatCents(r.pnl.netContributionAfterMarketing.cents)} (${formatBps(r.pnl.marginsBps.netContributionAfterMarketing)})`,
              },
            ]}
            rows={pnl.byChannel}
            rowKey={(r) => r.channel}
            empty="No sales this month."
          />
        </Panel>
        <Panel title="By ad platform">
          <DataTable
            caption="Ad spend and platform-reported sales by ad platform"
            columns={[
              {
                key: 'platform',
                label: 'Platform',
                cell: (p: (typeof pnl.byAdPlatform)[number]) => (
                  <div className="flex items-center gap-3">
                    <PlatformBadge platform={p.platform} size="sm" />
                    <span className="font-medium">{PLATFORM_NAME[p.platform] ?? p.platform}</span>
                  </div>
                ),
              },
              { key: 'spend', label: 'Spend', align: 'right', cell: (p) => formatCents(p.spendCents) },
              { key: 'sales', label: 'Platform sales', align: 'right', cell: (p) => formatCents(p.platformRevenueCents) },
            ]}
            rows={pnl.byAdPlatform}
            rowKey={(p) => p.platform}
            empty="No ad spend this month."
          />
        </Panel>
      </div>
    </>
  );
}
