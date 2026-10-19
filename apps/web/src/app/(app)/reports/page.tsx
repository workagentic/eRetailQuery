import { getMonthlyPnl } from '@erq/db';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@erq/ui';
import Link from 'next/link';
import { DataTable } from '@/components/data-table';
import { FilterBar } from '@/components/filter-bar';
import { PnlTable } from '@/components/pnl-table';
import { formatBps, formatCents } from '@/lib/format';
import { parseMonth, type SearchParams } from '@/lib/filters';
import { monthLabel, recentMonths, shiftMonth } from '@/lib/months';
import { loadReportContext } from '@/lib/report-context';

const CHANNEL = { shopify_online: 'Shopify', shopify_pos: 'Shopify POS', amazon: 'Amazon' } as const;
const PLATFORM = { meta: 'Meta', google: 'Google', tiktok: 'TikTok', amazon_ads: 'Amazon Ads' } as Record<string, string>;

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

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">Profit and loss: {monthLabel(month)}</h1>
        <p className="text-sm text-muted-foreground">
          From what you sold down to what is left, with the ad platforms that earned it or lost it.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <FilterBar path="/reports" query={{ month }} filters={ctx.filters} showRange={false} />
        <nav aria-label="Month" className="flex flex-wrap items-center gap-2 text-sm">
          <Link href={href(shiftMonth(month, -1))} className="rounded-md border border-border px-3 py-1">
            Previous month
          </Link>
          {month < latestComplete && (
            <Link href={href(shiftMonth(month, 1))} className="rounded-md border border-border px-3 py-1">
              Next month
            </Link>
          )}
          <span className="text-muted-foreground">Jump to:</span>
          {recentMonths(latestComplete, 6).map((m) => (
            <Link
              key={m}
              href={href(m)}
              aria-current={m === month ? 'true' : undefined}
              className={`rounded-md border px-2 py-1 ${m === month ? 'border-foreground bg-foreground text-background' : 'border-border'}`}
            >
              {m}
            </Link>
          ))}
        </nav>
      </div>

      {pnl.callouts.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>In plain English</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="list-disc pl-5 text-sm">
              {pnl.callouts.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Profit and loss</CardTitle>
          <CardDescription>
            Compared with the month before and the same month a year ago. Costs use what each unit cost on the day
            it sold.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <PnlTable
            current={pnl.current}
            previous={pnl.previous}
            sameMonthLastYear={pnl.sameMonthLastYear}
            comparison={pnl.comparison}
            costComplete={pnl.costComplete}
          />
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>By sales channel</CardTitle>
          </CardHeader>
          <CardContent>
            <DataTable
              caption="Net sales and profit by sales channel"
              columns={[
                { key: 'channel', label: 'Channel', cell: (c: (typeof pnl.byChannel)[number]) => CHANNEL[c.channel] },
                { key: 'sales', label: 'Net sales', align: 'right', cell: (c) => formatCents(c.pnl.netSales.cents) },
                {
                  key: 'contribution',
                  label: 'After fees',
                  align: 'right',
                  cell: (c) => formatCents(c.pnl.contributionMargin.cents),
                },
                {
                  key: 'after',
                  label: 'After ads',
                  align: 'right',
                  cell: (c) =>
                    `${formatCents(c.pnl.netContributionAfterMarketing.cents)} (${formatBps(c.pnl.marginsBps.netContributionAfterMarketing)})`,
                },
              ]}
              rows={pnl.byChannel}
              rowKey={(c) => c.channel}
              empty="No sales this month."
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>By ad platform</CardTitle>
          </CardHeader>
          <CardContent>
            <DataTable
              caption="Ad spend and platform-reported sales by ad platform"
              columns={[
                { key: 'platform', label: 'Platform', cell: (p: (typeof pnl.byAdPlatform)[number]) => PLATFORM[p.platform] ?? p.platform },
                { key: 'spend', label: 'Spend', align: 'right', cell: (p) => formatCents(p.spendCents) },
                { key: 'sales', label: 'Platform sales', align: 'right', cell: (p) => formatCents(p.platformRevenueCents) },
              ]}
              rows={pnl.byAdPlatform}
              rowKey={(p) => p.platform}
              empty="No ad spend this month."
            />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
