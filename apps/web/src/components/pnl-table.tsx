import type { Pnl, PnlComparison } from '@erq/metrics';
import { Fragment, type ReactNode } from 'react';
import { formatCents, formatChange } from '@/lib/format';
import { TermTip } from './term-tip';

type Line = {
  key: string;
  label: ReactNode;
  /** "-" for a cost taken off, "=" for a subtotal. */
  mark: '' | '-' | '=';
  value: (p: Pnl) => number;
  strong?: boolean;
};

const LINES: Line[] = [
  { key: 'grossSales', label: 'Gross sales', mark: '', value: (p) => p.grossSales.cents },
  { key: 'discounts', label: 'Discounts', mark: '-', value: (p) => p.discounts.cents },
  { key: 'refunds', label: 'Refunds and returns', mark: '-', value: (p) => p.refunds.cents },
  { key: 'netSales', label: 'Net sales', mark: '=', value: (p) => p.netSales.cents, strong: true },
  {
    key: 'cogs',
    label: <TermTip term="cogs">Cost of goods</TermTip>,
    mark: '-',
    value: (p) => p.cogs.cents,
  },
  { key: 'grossProfit', label: 'Gross profit', mark: '=', value: (p) => p.grossProfit.cents, strong: true },
  {
    key: 'fulfillment',
    label: 'Fulfillment: shipping, pick and pack',
    mark: '-',
    value: (p) => p.fulfillment.cents,
  },
  { key: 'paymentFees', label: 'Payment processing fees', mark: '-', value: (p) => p.paymentFees.cents },
  { key: 'marketplaceFees', label: 'Marketplace fees', mark: '-', value: (p) => p.marketplaceFees.cents },
  {
    key: 'contributionMargin',
    label: <TermTip term="contribution">Contribution margin</TermTip>,
    mark: '=',
    value: (p) => p.contributionMargin.cents,
    strong: true,
  },
  { key: 'adSpend', label: 'Ad spend', mark: '-', value: (p) => p.adSpend.total.cents },
  {
    key: 'netContributionAfterMarketing',
    label: <TermTip term="afterAds">Net contribution after marketing</TermTip>,
    mark: '=',
    value: (p) => p.netContributionAfterMarketing.cents,
    strong: true,
  },
  { key: 'otherOpex', label: 'Other operating expenses', mark: '-', value: (p) => p.otherOpex.cents },
  {
    key: 'estimatedOperatingProfit',
    label: 'Estimated operating profit',
    mark: '=',
    value: (p) => p.estimatedOperatingProfit.cents,
    strong: true,
  },
];

const PLATFORM = { meta: 'Meta', google: 'Google', tiktok: 'TikTok', amazon_ads: 'Amazon Ads' } as Record<string, string>;
const ARROW = { up: '▲', down: '▼', flat: '' } as const;

/** The monthly P&L, from gross sales down to estimated operating profit, with comparisons. */
export function PnlTable({
  current,
  previous,
  sameMonthLastYear,
  comparison,
  costComplete,
}: {
  current: Pnl;
  previous: Pnl;
  sameMonthLastYear: Pnl | null;
  comparison: PnlComparison;
  costComplete: boolean;
}) {
  void comparison; // change is computed from the same Pnl values so the table stays self-consistent
  return (
    <div className="flex flex-col gap-3">
      {!costComplete && (
        <p role="status" className="rounded-md border border-border bg-muted p-3 text-sm">
          Heads up: cost data incomplete. Some products sold this month have no cost on record, so cost of goods
          and every profit line below are better than reality.
        </p>
      )}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">Profit and loss for the month, compared with last month and last year</caption>
          <thead>
            <tr className="border-b border-border text-left">
              <th scope="col" className="px-2 py-2 font-medium">
                Line
              </th>
              <th scope="col" className="px-2 py-2 text-right font-medium">
                This month
              </th>
              <th scope="col" className="px-2 py-2 text-right font-medium">
                Last month
              </th>
              <th scope="col" className="px-2 py-2 text-right font-medium">
                Change
              </th>
              <th scope="col" className="px-2 py-2 text-right font-medium">
                Same month last year
              </th>
            </tr>
          </thead>
          <tbody>
            {LINES.map((line) => {
              const cur = line.value(current);
              const prev = line.value(previous);
              const change = formatChange(cur, prev);
              return (
                <Fragment key={line.key}>
                  <tr
                    className={`border-b border-border ${line.strong ? 'bg-muted font-semibold' : ''}`}
                  >
                    <th scope="row" className="px-2 py-2 text-left font-normal">
                      <span className="inline-block w-4 text-muted-foreground" aria-hidden="true">
                        {line.mark}
                      </span>
                      {line.label}
                    </th>
                    <td className="px-2 py-2 text-right tabular-nums">{formatCents(cur)}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{formatCents(prev)}</td>
                    <td className="px-2 py-2 text-right tabular-nums">
                      <span aria-hidden="true">{ARROW[change.direction]} </span>
                      {change.text}
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums">
                      {sameMonthLastYear === null ? (
                        <span className="text-muted-foreground">No data</span>
                      ) : (
                        formatCents(line.value(sameMonthLastYear))
                      )}
                    </td>
                  </tr>
                  {line.key === 'adSpend' &&
                    Object.entries(current.adSpend.byPlatform).map(([platform, spend]) => (
                      <tr key={`ad-${platform}`} className="border-b border-border text-muted-foreground">
                        <th scope="row" className="py-1 pl-8 pr-2 text-left font-normal">
                          {PLATFORM[platform] ?? platform}
                        </th>
                        <td className="px-2 py-1 text-right tabular-nums">{formatCents(spend.cents)}</td>
                        <td className="px-2 py-1 text-right tabular-nums">
                          {formatCents(previous.adSpend.byPlatform[platform]?.cents ?? 0)}
                        </td>
                        <td />
                        <td />
                      </tr>
                    ))}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">
        Reports are management estimates, not accounting or tax filings.
      </p>
    </div>
  );
}
