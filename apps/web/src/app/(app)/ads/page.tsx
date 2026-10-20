import { getAds, type AdsReport } from '@erq/db';
import Link from 'next/link';
import { AdsTrendChart, PlatformBars } from '@/components/ads-charts';
import { BarList } from '@/components/bar-list';
import { DataTable, type Column } from '@/components/data-table';
import { FilterBar } from '@/components/filter-bar';
import { Notice, PageHeader, Panel } from '@/components/page-kit';
import { PlatformBadge } from '@/components/platform-badge';
import { StatusChip } from '@/components/status-chip';
import { TermTip } from '@/components/term-tip';
import { PLATFORM_NAME } from '@/lib/chart-colors';
import type { SearchParams } from '@/lib/filters';
import { formatCents, formatRoas } from '@/lib/format';
import { loadReportContext } from '@/lib/report-context';

const FLAGS = ['all', 'losing', 'watch', 'winning', 'learning'] as const;
type FlagTab = (typeof FLAGS)[number];
const TAB_LABEL: Record<FlagTab, string> = {
  all: 'All',
  losing: 'Losing money',
  watch: 'Watch',
  winning: 'Winning',
  learning: 'Learning',
};

function Stat({ label, value, note }: { label: React.ReactNode; value: string; note: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-[14px] border border-border/70 bg-surface p-4 shadow-[var(--shadow-card)]">
      <div className="text-[13px] text-muted-foreground">{label}</div>
      <div className="text-[26px] font-semibold leading-none tracking-tight tabular">{value}</div>
      <div className="pt-1 text-xs text-muted-foreground">{note}</div>
    </div>
  );
}

export default async function AdsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const ctx = await loadReportContext(params);
  const ads = await ctx.db.withTenant(ctx.orgId, (tx) => getAds(tx, { range: ctx.range, asOf: ctx.asOf }));
  const tab = (FLAGS.find((f) => f === params.flag) ?? 'all') as FlagTab;
  const campaigns = ads.campaigns.filter((c) => tab === 'all' || c.flag === tab);
  const losing = ads.campaigns.filter((c) => c.flag === 'losing');
  const dailyLoss = losing.reduce((a, c) => a + (c.estimatedDailyLossCents ?? 0), 0);
  const spenders = ads.campaigns.filter((c) => c.spendCents > 0 && c.roas !== null);

  const campaignColumns: Column<AdsReport['campaigns'][number]>[] = [
    {
      key: 'name',
      label: 'Campaign',
      cell: (c) => (
        <div className="flex items-center gap-3">
          <PlatformBadge platform={c.platform} size="sm" />
          <div className="min-w-0">
            <div className="truncate font-medium text-foreground">{c.name}</div>
            <div className="text-xs text-muted-foreground">{PLATFORM_NAME[c.platform] ?? c.platform}</div>
          </div>
        </div>
      ),
    },
    { key: 'spend', label: 'Spend', align: 'right', cell: (c) => formatCents(c.spendCents) },
    { key: 'revenue', label: 'Platform sales', align: 'right', cell: (c) => formatCents(c.platformRevenueCents) },
    { key: 'roas', label: <TermTip term="roas">ROAS</TermTip>, align: 'right', cell: (c) => formatRoas(c.roas) },
    {
      key: 'flag',
      label: 'Verdict',
      cell: (c) => (
        <div className="flex max-w-md flex-col gap-1">
          <StatusChip status={c.flag} />
          <span className="text-xs text-muted-foreground">{c.reason}</span>
          <span className="text-xs font-semibold text-foreground">{c.action}</span>
        </div>
      ),
    },
  ];
  const platformColumns: Column<AdsReport['byPlatform'][number]>[] = [
    {
      key: 'platform',
      label: 'Platform',
      cell: (p) => (
        <div className="flex items-center gap-3">
          <PlatformBadge platform={p.platform} size="sm" />
          <span className="font-medium">{PLATFORM_NAME[p.platform] ?? p.platform}</span>
        </div>
      ),
    },
    { key: 'spend', label: 'Spend', align: 'right', cell: (p) => formatCents(p.spendCents) },
    { key: 'revenue', label: 'Platform sales', align: 'right', cell: (p) => formatCents(p.platformRevenueCents) },
    { key: 'roas', label: <TermTip term="roas">ROAS</TermTip>, align: 'right', cell: (p) => formatRoas(p.roas) },
    {
      key: 'net',
      label: <TermTip term="afterAds">Money left after ads</TermTip>,
      align: 'right',
      cell: (p) => (p.netAfterAdsCents === null ? '—' : formatCents(p.netAfterAdsCents)),
    },
  ];

  return (
    <>
      <PageHeader
        title="Advertising"
        description={`Which ads to scale and which to kill, for ${ctx.range.from} to ${ctx.range.to}.`}
        actions={<FilterBar path="/ads" filters={ctx.filters} showChannel={false} />}
      />
      {!ads.costComplete && (
        <Notice>
          Heads up: cost data incomplete. Some products sold in this period have no cost on record, so every
          break-even point is lower than reality and some ads may look better than they are.
        </Notice>
      )}
      {ads.usedGenericBands && (
        <Notice>
          There is no cost data for some sales, so verdicts use generic ROAS bands. Add costs on the Products page
          for accurate ones.
        </Notice>
      )}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          label={<TermTip term="blendedRoas">Blended ROAS</TermTip>}
          value={formatRoas(ads.totals.blendedRoas)}
          note="All sales over all ad spend: the honest number."
        />
        <Stat
          label={<TermTip term="roas">Platform-reported ROAS</TermTip>}
          value={formatRoas(ads.totals.platformRoas)}
          note="What the platforms claim. They can overlap and over-claim."
        />
        <Stat label="Ad spend" value={formatCents(ads.totals.spendCents)} note="In the selected period." />
        <Stat
          label="Wasted on losing ads"
          value={formatCents(dailyLoss * 7)}
          note={
            losing.length > 0
              ? `A week, across ${losing.length} losing ${losing.length === 1 ? 'campaign' : 'campaigns'}.`
              : 'No campaign is losing money right now.'
          }
        />
      </div>

      <div className="grid gap-6 xl:grid-cols-3">
        <Panel
          className="xl:col-span-2"
          title="Spend against claimed sales"
          description="Daily ad spend, and the sales the platforms say it produced."
        >
          <AdsTrendChart
            data={ads.daily.map((d) => ({ date: d.date, spend: d.spendCents, platformSales: d.platformRevenueCents }))}
          />
        </Panel>
        <Panel title="By platform" description="Spend next to claimed sales.">
          <PlatformBars
            data={ads.byPlatform.map((p) => ({
              name: PLATFORM_NAME[p.platform] ?? p.platform,
              spend: p.spendCents,
              platformSales: p.platformRevenueCents,
            }))}
          />
        </Panel>
      </div>

      <Panel
        title="Return on ad spend by campaign"
        description="The dark tick is break-even: bars that stop short of it lose money."
      >
        <BarList
          empty="No campaigns with spend in this period."
          items={spenders
            .sort((a, b) => (b.roas ?? 0) - (a.roas ?? 0))
            .map((c) => ({
              key: c.id,
              lead: <PlatformBadge platform={c.platform} />,
              label: c.name,
              sublabel: PLATFORM_NAME[c.platform] ?? c.platform,
              value: c.roas ?? 0,
              valueLabel: formatRoas(c.roas),
              color: c.flag === 'losing' ? '#b91c1c' : c.flag === 'winning' ? '#15803d' : '#64748b',
              marker: c.breakEven,
              markerLabel: c.breakEven === null ? undefined : `Break-even ${c.breakEven.toFixed(1)}x`,
            }))}
        />
      </Panel>

      <Panel title="By platform" description="Spend against what each platform says it sold.">
        <DataTable
          caption="Ad platforms compared"
          columns={platformColumns}
          rows={ads.byPlatform}
          rowKey={(p) => p.platform}
          empty="No ad accounts connected yet."
        />
      </Panel>

      <Panel
        title="Campaigns"
        action={
          <div className="inline-flex flex-wrap gap-1 rounded-xl bg-muted p-1" role="tablist" aria-label="Filter campaigns by verdict">
            {FLAGS.map((f) => (
              <Link
                key={f}
                role="tab"
                aria-selected={f === tab}
                href={`/ads?range=${ctx.filters.preset}&flag=${f}`}
                className={`rounded-lg px-3 py-1.5 text-[13px] font-medium transition-colors ${
                  f === tab ? 'bg-surface text-foreground shadow-[0_1px_2px_rgb(15_31_42/0.12)]' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {TAB_LABEL[f]} ({f === 'all' ? ads.campaigns.length : ads.campaigns.filter((c) => c.flag === f).length})
              </Link>
            ))}
          </div>
        }
      >
        <DataTable
          caption="Campaigns with spend, return and a verdict"
          columns={campaignColumns}
          rows={campaigns}
          rowKey={(c) => c.id}
          empty="No campaigns match this filter."
        />
      </Panel>
    </>
  );
}
