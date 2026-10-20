import { CheckCircle2, TrendingUp } from 'lucide-react';
import type { ReactNode } from 'react';

const POINTS = [
  'See profit per product, per channel and per ad, not just revenue.',
  'Know which ads to pause and which to scale, with the dollars at stake.',
  'Spot what is about to run out before it costs you sales.',
];

/** Split sign-in screen: the promise on the left, the form on the right. */
export function AuthLayout({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <main className="grid min-h-screen lg:grid-cols-[1.05fr_1fr]">
      <section className="relative hidden flex-col justify-between overflow-hidden bg-ink p-12 text-white lg:flex">
        <div className="flex items-center gap-2.5">
          <span className="grid size-9 place-items-center rounded-lg bg-brand">
            <TrendingUp aria-hidden="true" className="size-5" strokeWidth={2.25} />
          </span>
          <span className="text-lg font-semibold tracking-tight">eRetailQuery</span>
        </div>
        <div className="flex max-w-lg flex-col gap-8">
          <h2 className="text-4xl font-semibold leading-[1.15] tracking-tight">
            Know what is actually making you money.
          </h2>
          <ul className="flex flex-col gap-4">
            {POINTS.map((p) => (
              <li key={p} className="flex gap-3 text-[15px] text-ink-muted">
                <CheckCircle2 aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-brand" strokeWidth={1.75} />
                {p}
              </li>
            ))}
          </ul>
          <div className="rounded-2xl border border-ink-line bg-white/5 p-5">
            <p className="text-sm text-ink-muted">Where every $100 of sales goes</p>
            <div className="mt-3 flex h-3 gap-0.5 overflow-hidden rounded-full" aria-hidden="true">
              <span className="bg-[#475569]" style={{ width: '44%' }} />
              <span className="bg-[#64748b]" style={{ width: '9%' }} />
              <span className="bg-[#94a3b8]" style={{ width: '7%' }} />
              <span className="bg-[#3b82f6]" style={{ width: '19%' }} />
              <span className="bg-[#2dd4bf]" style={{ width: '21%' }} />
            </div>
            <p className="mt-3 text-sm">
              <span className="font-semibold text-[#5eead4]">$21.00</span> left after cost of goods, shipping, fees and ads.
            </p>
          </div>
        </div>
        <p className="text-xs text-ink-muted">For Shopify and Amazon sellers.</p>
      </section>
      <section className="flex items-center justify-center bg-canvas px-6 py-12">
        <div className="flex w-full max-w-sm flex-col gap-6">
          <div className="flex flex-col gap-1">
            <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
            <p className="text-sm text-muted-foreground">{subtitle}</p>
          </div>
          <div className="rounded-[14px] border border-border/70 bg-surface p-6 shadow-[var(--shadow-card)]">{children}</div>
        </div>
      </section>
    </main>
  );
}
