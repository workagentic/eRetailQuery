import { getAds, type AdsReport } from '@erq/db';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@erq/ui';
import Link from 'next/link';
import { DataTable, type Column } from '@/components/data-table';
import { FilterBar } from '@/components/filter-bar';
import { StatusChip } from '@/components/status-chip';
import { TermTip } from '@/components/term-tip';
import { formatCents, formatRoas } from '@/lib/format';
import type { SearchParams } from '@/lib/filters';
import { loadReportContext } from '@/lib/report-context';

const PLATFORM = { meta: 'Meta', google: 'Google', tiktok: 'TikTok', amazon_ads: 'Amazon Ads' } as Record<string, string>;
const FLAGS = ['all', 'losing', 'watch', 'winning', 'learning'] as const;
type FlagTab = (typeof FLAGS)[number];
const TAB_LABEL: Record<FlagTab, string> = {
  all: 'All',
  losing: 'Losing money',
  watch: 'Watch',
  winning: 'Winning',
  learning: 'Learning',
};

export default async function AdsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const ctx = await loadReportContext(params);
  const ads = await ctx.db.withTenant(ctx.orgId, (tx) => getAds(tx, { range: ctx.range, asOf: ctx.asOf }));
  const tab = (FLAGS.find((f) => f === params.flag) ?? 'all') as FlagTab;
  const campaigns = ads.campaigns.filter((c) => tab === 'all' || c.flag === tab);
  const losing = ads.campaigns.filter((c) => c.flag === 'losing');
  const dailyLoss = losing.reduce((a, c) => a + (c.estimatedDailyLossCents ?? 0), 0);

  const campaignColumns: Column<AdsReport['campaigns'][number]>[] = [
    {
      key: 'name',
      label: 'Campaign',
      cell: (c) => (
        <div>
          <div className="font-medium">{c.name}</div>
          <div className="text-xs text-muted-foreground">{PLATFORM[c.platform] ?? c.platform}</div>
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
          <span className="text-xs font-medium">{c.action}</span>
        </div>
      ),
    },
  ];
  const platformColumns: Column<AdsReport['byPlatform'][number]>[] = [
    { key: 'platform', label: 'Platform', cell: (p) => PLATFORM[p.platform] ?? p.platform },
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
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">Advertising</h1>
        <p className="text-sm text-muted-foreground">
          Which ads to scale and which to kill, for {ctx.range.from} to {ctx.range.to}.
        </p>
      </div>
      <FilterBar path="/ads" filters={ctx.filters} showChannel={false} />
      {!ads.costComplete && (
        <p role="status" className="rounded-md border border-border bg-muted p-3 text-sm">
          Heads up: cost data incomplete. Some products sold in this period have no cost on record, so every
          break-even point is lower than reality and some ads may look better than they are.
        </p>
      )}
      {ads.usedGenericBands && (
        <p role="status" className="rounded-md border border-border bg-muted p-3 text-sm">
          There is no cost data for some sales, so verdicts use generic ROAS bands. Add costs on the Products page
          for accurate ones.
        </p>
      )}
      <div className="grid gap-3 sm:grid-cols-3">
        <Card>
          <CardContent className="flex flex-col gap-1 p-4">
            <div className="text-sm text-muted-foreground">
              <TermTip term="blendedRoas">Blended ROAS</TermTip>
            </div>
            <div className="text-2xl font-semibold">{formatRoas(ads.totals.blendedRoas)}</div>
            <div className="text-xs text-muted-foreground">All sales over all ad spend: the honest number.</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex flex-col gap-1 p-4">
            <div className="text-sm text-muted-foreground">
              <TermTip term="roas">Platform-reported ROAS</TermTip>
            </div>
            <div className="text-2xl font-semibold">{formatRoas(ads.totals.platformRoas)}</div>
            <div className="text-xs text-muted-foreground">
              What the ad platforms claim. They can overlap and over-claim.
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex flex-col gap-1 p-4">
            <div className="text-sm text-muted-foreground">Ad spend</div>
            <div className="text-2xl font-semibold">{formatCents(ads.totals.spendCents)}</div>
            <div className="text-xs text-muted-foreground">
              {losing.length > 0
                ? `${losing.length} losing ${losing.length === 1 ? 'campaign wastes' : 'campaigns waste'} about ${formatCents(dailyLoss * 7)} a week.`
                : 'No campaign is losing money right now.'}
            </div>
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>By platform</CardTitle>
          <CardDescription>Spend against what each platform says it sold.</CardDescription>
        </CardHeader>
        <CardContent>
          <DataTable
            caption="Ad platforms compared"
            columns={platformColumns}
            rows={ads.byPlatform}
            rowKey={(p) => p.platform}
            empty="No ad accounts connected yet."
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Campaigns</CardTitle>
          <div className="flex flex-wrap gap-2 pt-1" role="tablist" aria-label="Filter campaigns by verdict">
            {FLAGS.map((f) => (
              <Link
                key={f}
                role="tab"
                aria-selected={f === tab}
                href={`/ads?range=${ctx.filters.preset}&flag=${f}`}
                className={`rounded-md border px-3 py-1 text-sm ${f === tab ? 'border-foreground bg-foreground text-background' : 'border-border'}`}
              >
                {TAB_LABEL[f]} (
                {f === 'all' ? ads.campaigns.length : ads.campaigns.filter((c) => c.flag === f).length})
              </Link>
            ))}
          </div>
        </CardHeader>
        <CardContent>
          <DataTable
            caption="Campaigns with spend, return and a verdict"
            columns={campaignColumns}
            rows={campaigns}
            rowKey={(c) => c.id}
            empty="No campaigns match this filter."
          />
        </CardContent>
      </Card>
    </div>
  );
}
