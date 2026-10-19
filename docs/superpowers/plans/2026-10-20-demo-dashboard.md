# Demo Dashboard (Shopify + Amazon, seed data, on Vercel) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A password-protected demo on Vercel where the owner's boss signs in and sees one profit dashboard for a seeded business selling on Shopify and Amazon: home dashboard, products and pricing, ads, inventory, monthly P&L.

**Architecture:** Real screens, fed by an extended demo seed in hosted Supabase Postgres. The Next.js web app reads the database directly on the server through `createTenantDb().withTenant` (the owner chose this over hosting the NestJS API; no API, Redis or worker is deployed for the demo). Query functions live in `packages/db/src/reports/`, aggregate in SQL, and feed the existing pure functions in `packages/metrics` (`buildPnl`, `classifyAd`, `skuPricing`, `stockFlags`). Pages are server components; only charts are client components.

**Tech Stack:** Next.js 15 App Router, Drizzle + `pg`, Supabase Auth (hosted), Vitest with the embedded Postgres harness, Recharts (new dependency, already in the CLAUDE.md stack; used for the trend and channel charts only).

**Spec:** Decisions below (owner chat of 2026-10-20). Product rules come from `CLAUDE.md` sections 2, 4, 7 and 8.

## Decisions (owner's unless marked "my call")

- Demo audience: the owner's boss, signing in with credentials the owner gives. Must show profitability across **Amazon and Shopify in a single dashboard**.
- Hosting: Vercel (web) + hosted Supabase (Postgres, Auth). No Docker, nothing local needed to run the demo.
- Direct database reads from the web app instead of the API (owner's choice). The pages are rebuilt on the API when it is deployed (Phase 1d). My call: keep every query in `packages/db/src/reports/` so that move is mechanical.
- Real screens fed by seed data, not mocks.
- My call: demo mode is a build/runtime flag (`NEXT_PUBLIC_DEMO_MODE=1`) that makes `loadAppContext` read orgs from the database and hides the Team and Connections nav links (those pages need the API).
- My call: Amazon is modeled as sales channel `amazon` with ad platform `amazon_ads`; fees come from per-order stored columns, the same columns a later Amazon settlement sync fills.
- My call: the seed has a planted story so the dashboard has something to say: one losing Meta campaign, one winning Google Shopping campaign, one underpriced bestseller, three SKUs about to run out, one SKU with Amazon fees that make it unprofitable on Amazon only.
- My call: the seed anchors data to the day it runs (last 365 days, ending yesterday), so reseed shortly before any demo.

## Global Constraints

- Money is integer cents plus ISO currency (`USD`), never floats. Percentages are integer basis points (`packages/metrics` convention).
- Plain language in the UI: "Cost of goods" with COGS in a tooltip, "Money left after ads" with the formal term in a tooltip. Show markup and margin side by side and label each.
- Every flag shows why it fired and what to do.
- Every screen shows a "Demo data" banner and the data's "as of" time.
- Every tenant call goes through `withTenant(orgId, fn)`. Apps never import `@erq/db/admin`. New tenant tables call `app_secure_tenant_table`, get a fixture in `packages/db/test/fixtures.ts`, and use composite `(org_id, id)` foreign keys.
- Do not edit `apps/api`, `apps/worker`, `packages/sync` or `packages/connectors`.
- Conventional Commits. Work on branch `demo-dashboard` (create from `main`). One commit per task minimum.
- TypeScript strict, no `any` without a comment. Run `pnpm turbo run build --filter=@erq/db` before running other packages' tests directly.

## Review Focus

- An org with zero orders or zero ad spend renders empty states, not NaN, `Infinity` or a crash (blended ROAS with zero spend is `null`, shown as "No ad spend").
- An order whose refunds exceed sales (negative `net_cents`) and an order line with a null COGS snapshot: P&L still adds up and marks cost as incomplete instead of treating it as zero.
- Date-range edges: an order at 00:00 and 23:59 on the range's first and last day is counted once, in the right bucket; the previous-period comparison does not overlap the current period.
- The channel filter changes every number on the page consistently (dashboard KPIs, trend, products, P&L).
- Serverless connection use: each request must not open a new pool; the pool is a module-level singleton with `max: 1`.
- Tenant isolation: the demo user cannot read another org's rows through any new report query (covered by the existing isolation suite plus one test per new table).
- A signed-in user who belongs to no org is sent to a clear "no demo access" message, not a stack trace.

---

### Task 1: Schema for Amazon, per-order fees and ad data

**Files:**
- Create: `packages/db/migrations/0027_demo_channels_fees_ads.sql` (via `pnpm --filter @erq/db generate`, then add the RLS calls by hand in the same migration), `packages/db/src/schema/ads.ts`
- Modify: `packages/db/src/schema/orders.ts` (channel enum, fee columns), `packages/db/src/schema/index.ts`, `packages/db/test/fixtures.ts`
- Test: `packages/db/test/ads-schema.test.ts`

**Interfaces:**
- Produces: `salesChannel` gains `'amazon'`. `orders` gains `paymentFeeCents`, `marketplaceFeeCents`, `fulfillmentCostCents` (bigint number, `notNull`, default 0, check `>= 0`). New enum `adPlatform = ['meta','google','amazon_ads']`. New tables `adConnections` (platform, externalAccountId, status), `adCampaigns` (adConnectionId, externalId, name, status, objective), `adInsightsDaily` (campaignId, date, spendCents, impressions, clicks, conversions, revenueCents; unique `(orgId, campaignId, date)`; index `(orgId, date)`). All tenant tables with `orgId`, timestamps, composite FKs.

- [ ] **Step 1: Write failing tests** in `ads-schema.test.ts`, following `alerts-schema.test.ts`: `'tenant B cannot read tenant A ad campaigns'`, `'ad_insights_daily rejects a second row for the same campaign and date'`, `'orders accept channel amazon'`, `'orders reject negative fee columns'`.
- [ ] **Step 2: Run** `pnpm --filter @erq/db test -- ads-schema` and confirm the four fail.
- [ ] **Step 3: Implement** the schema files, generate the migration, append `select app_secure_tenant_table('ad_connections')` (and the other two) following the pattern in `0026_alerts_rls_and_sweep.sql`, add fixtures.
- [ ] **Step 4: Run** `pnpm --filter @erq/db test` (full package, includes the isolation suite) and confirm all pass.
- [ ] **Step 5: Commit** `feat(db): add amazon channel, per-order fees and ad tables`.

### Task 2: Demo data generator and extended seed

**Files:**
- Create: `packages/db/src/demo-data.ts`
- Modify: `packages/db/src/seed.ts` (insert generated rows), `packages/db/src/admin.ts` (export `DEMO_STORY`)
- Test: `packages/db/test/demo-data.test.ts`

**Interfaces:**
- Produces: `generateDemoData(input: { orgId: string; skus: SeedSku[]; connections: { shopify: string; amazon: string }; endDate: string; days: number; rand: () => number }): DemoData` where `DemoData = { orders; orderLines; inventoryLevels; locations; adConnections; adCampaigns; adInsights }` as insert-row arrays, and `DEMO_STORY = { losingCampaignName, winningCampaignName, underpricedSkuCode, lowStockSkuCodes, amazonLossSkuCode }` constants the tests and UI copy can reference.
- Consumes: Task 1 tables; existing seed `skuRows`/`costRows`.

- [ ] **Step 1: Write failing tests**: `'is deterministic for the same seed'`; `'every order has net = gross - discount - refund'`; `'every order line snapshot COGS equals the landed cost in effect on the order date'`; `'orders exist on both shopify_online and amazon over 365 days'`; `'the losing Meta campaign has 7-day ROAS below break-even'` (classify with `classifyAd` and a contribution computed from seed costs, expect code `losing`); `'the winning Google campaign classifies as winning'`; `'the underpriced SKU price is below landed * 1.5'`; `'the three low-stock SKUs have days of cover below the buffer'`; `'the amazon-loss SKU has negative contribution on amazon and positive on shopify'`; `'amazon orders carry a marketplace fee near 15% and a fulfillment cost'`.
- [ ] **Step 2: Run** and confirm failures.
- [ ] **Step 3: Implement** `generateDemoData` as a pure function: roughly 15 to 30 orders per day with weekday and seasonal variation, 60/40 Shopify/Amazon, 1 to 3 lines each, refunds on about 4% of orders, Shopify payment fee 2.9% + 30 cents, Amazon referral 15% + per-unit fulfillment fee, locations "Main warehouse" and "Amazon FBA", 8 campaigns across Meta, Google and Amazon Ads with daily insights (planted losing and winning campaigns per `DEMO_STORY`). Extend `seedDemoOrg(ownerUrl, opts?: { endDate?: string })` to insert in batches of 1000 rows inside the existing transaction.
- [ ] **Step 4: Run** `pnpm --filter @erq/db test -- demo-data` and the seed test; confirm pass and that seeding 365 days stays under 60 seconds on embedded Postgres.
- [ ] **Step 5: Commit** `feat(db): generate a Shopify + Amazon demo business with planted stories`.

### Task 3: Overview report query (KPIs, trend, channel split)

**Files:**
- Create: `packages/db/src/reports/types.ts`, `packages/db/src/reports/overview.ts`, `packages/db/src/reports/range.ts`
- Modify: `packages/db/src/index.ts` (export `reports`)
- Test: `packages/db/test/reports-overview.test.ts`

**Interfaces:**
- Produces: `type ReportRange = { from: string; to: string }` (inclusive `YYYY-MM-DD`), `type ChannelFilter = 'all' | 'shopify_online' | 'amazon'`, `resolveRange(preset: '7d'|'30d'|'90d'|'mtd', today: string): { current: ReportRange; previous: ReportRange }`, and `getOverview(tx: Tx, p: { range: ReportRange; previous: ReportRange; channel: ChannelFilter }): Promise<Overview>` where `Overview = { currency; asOf: string; kpis: { revenue; orders; adSpend; blendedRoas: number|null; estimatedProfit; marginBps: number|null } each with a previous-period value; daily: { date; revenue; profit; adSpend }[]; byChannel: { channel; revenue; profit; marginBps }[] }`. Profit comes from `buildPnl`, not ad hoc SQL.
- Bucket dates in the org timezone if `orgs` has a timezone column, else UTC (my call, note in the file header).

- [ ] **Step 1: Write failing tests** against the seeded embedded DB: `'30d revenue equals the sum of non-cancelled, non-test order net'`; `'previous range does not overlap current'`; `'blended ROAS is revenue over total ad spend'`; `'blended ROAS is null when ad spend is zero'` (channel filter amazon with Meta-only fixture); `'filtering to amazon excludes shopify orders from every figure'`; `'an order on the last day at 23:59 is counted once'`; `'an empty org returns zeros and an empty daily series'`; `'refunds greater than sales give negative net without throwing'`.
- [ ] **Step 2: Run** and confirm failures.
- [ ] **Step 3: Implement** with grouped SQL (`sum(...) ... group by date`), cost from `order_lines.unit_cogs_cents_snapshot * quantity` (null snapshot marks `costComplete: false`), fees from the new order columns, then `buildPnl`.
- [ ] **Step 4: Run** the new test file; confirm pass.
- [ ] **Step 5: Commit** `feat(db): overview report with KPIs, trend and channel split`.

### Task 4: Products and pricing report

**Files:**
- Create: `packages/db/src/reports/products.ts`
- Test: `packages/db/test/reports-products.test.ts`

**Interfaces:**
- Produces: `getProducts(tx: Tx, p: { range: ReportRange; channel: ChannelFilter; asOf: string }): Promise<ProductRow[]>`; `ProductRow = { skuId; skuCode; title; category; priceCents; landedCents|null; markupBps|null; marginBps|null; idealLowCents|null; idealHighCents|null; pricingStatus: 'underpriced'|'healthy'|'premium'|'no_cost'; contributionNegative: boolean; unitsSold; revenueCents; profitCents|null; message: string }`. Uses `landedCost` (cost effective on `asOf`) and `skuPricing` (default `PricingConfig`).

- [ ] **Step 1: Write failing tests**: `'the planted underpriced SKU is reported underpriced with a raise-to message'`; `'a SKU with no cost components is no_cost and has null profit'`; `'markup and margin match the CLAUDE.md formulas for a known SKU'` (50% markup = 33.3% margin); `'the amazon-loss SKU shows contributionNegative when channel is amazon and not when shopify_online'`; `'uses the cost effective on asOf when a supplier increase exists'`; `'sorted by profit descending, nulls last'`.
- [ ] **Step 2: Run** and confirm failures.
- [ ] **Step 3: Implement** with one query per concern (SKUs, effective cost components, sales aggregates by SKU) joined in memory, not an N+1.
- [ ] **Step 4: Run** and confirm pass.
- [ ] **Step 5: Commit** `feat(db): products and pricing report`.

### Task 5: Ads report

**Files:**
- Create: `packages/db/src/reports/ads.ts`
- Test: `packages/db/test/reports-ads.test.ts`

**Interfaces:**
- Produces: `getAds(tx: Tx, p: { range: ReportRange; asOf: string }): Promise<AdsReport>`; `AdsReport = { totals: { spendCents; platformRevenueCents; blendedRoas: number|null; platformRoas: number|null }; byPlatform: { platform; spendCents; platformRevenueCents; roas: number|null; netAfterAdsCents }[]; campaigns: { id; name; platform; spendCents; roas: number|null; flag: AdFlagCode; reason: string; action: string; estimatedDailyLossCents: number|null }[]; usedGenericBands: boolean }`. Break-even comes from `breakEvenRoas` on the org's average contribution before ads for the range (null falls back to generic bands and sets `usedGenericBands`).

- [ ] **Step 1: Write failing tests**: `'the planted Meta campaign is losing with a pause action and a positive daily loss'`; `'the planted Google campaign is winning'`; `'a campaign with under $50 spend or 1000 impressions is learning, never losing'`; `'platform ROAS and blended ROAS are both returned and differ'`; `'campaigns sorted losing first, then watch, winning, learning'`; `'zero spend gives null ROAS, not Infinity'`.
- [ ] **Step 2: Run** and confirm failures.
- [ ] **Step 3: Implement** by building `AdDay[]` per campaign (fill missing dates with zero days so `classifyAd`'s consecutive-day rule holds) and calling `classifyAd`; compose `reason` and `action` strings from the returned `AdFlag.facts`.
- [ ] **Step 4: Run** and confirm pass.
- [ ] **Step 5: Commit** `feat(db): ads report with winning and losing flags`.

### Task 6: Inventory report and attention feed

**Files:**
- Create: `packages/db/src/reports/inventory.ts`, `packages/db/src/reports/attention.ts`
- Test: `packages/db/test/reports-inventory.test.ts`, `packages/db/test/reports-attention.test.ts`

**Interfaces:**
- Produces: `getInventory(tx: Tx, p: { asOf: string }): Promise<{ lowStock: StockRow[]; overstock: StockRow[]; dead: StockRow[]; byLocation: { location; units; valueCents }[] }>` with `StockRow = { skuId; skuCode; title; available; velocityPerDay; daysOfCover: number|null; flag; reason; action }` using `salesVelocity`, `daysOfCover`, `stockFlags`. `getAttention(tx: Tx, p: { range; previous; asOf }): Promise<AttentionItem[]>` returning at most 5 items `{ kind: 'losing_ad'|'low_stock'|'underpriced'|'amazon_loss'; severity: 1|2|3; title; why; action; href }` ranked by dollars at stake.

- [ ] **Step 1: Write failing tests**: `'the three planted SKUs are low stock with days of cover under the buffer'`; `'a SKU with no sales in 90 days is dead stock'`; `'stock by location sums to total available'`; `'attention contains the losing Meta campaign, the underpriced SKU and low stock'`; `'attention is capped at 5 and ordered by dollars at stake'`; `'attention is empty for an empty org'`.
- [ ] **Step 2: Run** and confirm failures.
- [ ] **Step 3: Implement** both; `getAttention` composes Tasks 4, 5 and `getInventory` results, it does not re-query.
- [ ] **Step 4: Run** and confirm pass.
- [ ] **Step 5: Commit** `feat(db): inventory report and attention feed`.

### Task 7: Monthly P&L report

**Files:**
- Create: `packages/db/src/reports/pnl.ts`
- Test: `packages/db/test/reports-pnl.test.ts`

**Interfaces:**
- Produces: `getMonthlyPnl(tx: Tx, p: { month: string; channel: ChannelFilter }): Promise<{ month; current: Pnl; previous: Pnl; sameMonthLastYear: Pnl|null; comparison: PnlComparison; byChannel: { channel; pnl: Pnl }[]; byAdPlatform: { platform; spend; platformRevenue }[]; costComplete: boolean; callouts: string[] }` where `month` is `YYYY-MM`. `callouts` are plain-English lines such as "Meta spent $X and earned $Y in platform revenue".

- [ ] **Step 1: Write failing tests**: `'the line items reproduce buildPnl on hand-computed totals for a small fixture month'`; `'byChannel P&Ls sum to the all-channels P&L'`; `'a month containing an order with a null COGS snapshot sets costComplete false'`; `'a month with no data returns an all-zero P&L'`; `'sameMonthLastYear is null when there is no data that year'`.
- [ ] **Step 2: Run** and confirm failures.
- [ ] **Step 3: Implement** reusing the SQL aggregation helpers from Task 3 (extract a shared `aggregateOrders` into `reports/aggregate.ts` if duplication appears).
- [ ] **Step 4: Run** and confirm pass.
- [ ] **Step 5: Commit** `feat(db): monthly P&L report with channel breakdown`.

### Task 8: Web plumbing (database access, demo context, navigation, filters)

**Files:**
- Create: `apps/web/src/lib/db.ts`, `apps/web/src/lib/demo-context.ts`, `apps/web/src/lib/filters.ts`, `apps/web/src/lib/format.ts` (check `packages/shared` for an existing money formatter first and reuse it), `apps/web/src/components/demo-banner.tsx`, `apps/web/src/components/filter-bar.tsx`, `apps/web/src/components/term-tip.tsx`
- Modify: `apps/web/src/lib/app-context.ts` (demo mode branch), `apps/web/src/app/(app)/layout.tsx` (nav: Dashboard, Products, Ads, Inventory, P&L; hide Team and Connections in demo mode), `apps/web/package.json` (add `@erq/db`), `.env.example`
- Test: `apps/web/src/lib/filters.test.ts`, `apps/web/src/lib/format.test.ts`, `apps/web/src/lib/demo-context.test.ts`

**Interfaces:**
- Produces: `getTenantDb(): TenantDb` (module singleton, `createTenantDb(process.env.DATABASE_URL, { max: 1 })`), `loadDemoContext(): Promise<{ userId: string; org: OrgSummary }>` (reads the Supabase user, `createAccountApi(pool).listUserOrgs`, redirects to `/no-access` when empty), `parseFilters(searchParams): { preset: '7d'|'30d'|'90d'|'mtd'; channel: ChannelFilter }` (invalid values fall back to `30d` and `all`), `formatMoney(cents: number, currency: string): string`, `formatBps(bps: number|null): string`, `<TermTip term="COGS">`.

- [ ] **Step 1: Write failing tests**: `'parseFilters falls back to 30d and all on garbage'`; `'formatMoney formats negative cents and zero'`; `'formatBps(null) renders an em dash'`; `'loadDemoContext redirects to /no-access when the user has no org'` (mock the account API).
- [ ] **Step 2: Run** `pnpm --filter @erq/web test` and confirm failures.
- [ ] **Step 3: Implement.** `app-context.ts` keeps its API signature; when `NEXT_PUBLIC_DEMO_MODE === '1'` it returns the demo context instead of calling `apiFetch`. Add `/no-access` page. The filter bar writes `?range=&channel=` to the URL (links, no client state).
- [ ] **Step 4: Run** web tests and `pnpm --filter @erq/web typecheck`; confirm pass.
- [ ] **Step 5: Commit** `feat(web): demo-mode database access, filters and navigation`.

### Task 9: Home dashboard screen

**Files:**
- Modify: `apps/web/src/app/(app)/dashboard/page.tsx`
- Create: `apps/web/src/components/kpi-strip.tsx`, `apps/web/src/components/attention-feed.tsx`, `apps/web/src/components/trend-chart.tsx` (client, Recharts), `apps/web/src/components/channel-split.tsx`, `apps/web/src/app/(app)/dashboard/loading.tsx`
- Modify: `apps/web/package.json` (add `recharts`)
- Test: `apps/web/src/components/kpi-strip.test.tsx`, `apps/web/src/components/attention-feed.test.tsx`

**Interfaces:**
- Consumes: `getOverview`, `getAttention`, `parseFilters`, `resolveRange`, `formatMoney`.

- [ ] **Step 1: Write failing component tests**: `'KpiStrip shows revenue, orders, ad spend, blended ROAS and estimated profit with change versus the previous period'`; `'KpiStrip shows "No ad spend" when blended ROAS is null'`; `'AttentionFeed renders why and the action for each item, and an empty state with a next step'`.
- [ ] **Step 2: Run** and confirm failures.
- [ ] **Step 3: Implement** the page as a server component: KPI strip, "What needs your attention" feed (5 items, each with a link), profit-and-revenue trend, channel split (Shopify vs Amazon profit and margin), filter bar, demo banner, skeleton `loading.tsx`. Mobile first (single column under `md`). Follow `dataviz` skill guidance for chart colors.
- [ ] **Step 3b: Check in a browser** at 390px and 1280px widths (Chrome tools) against the seeded database; confirm no console errors and that numbers match `getOverview` output.
- [ ] **Step 4: Run** web tests, typecheck and `pnpm --filter @erq/web build`; confirm pass.
- [ ] **Step 5: Commit** `feat(web): profit dashboard home screen`.

### Task 10: Products, Ads and Inventory screens

**Files:**
- Create: `apps/web/src/app/(app)/products/page.tsx`, `apps/web/src/app/(app)/ads/page.tsx`, `apps/web/src/app/(app)/inventory/page.tsx`, matching `loading.tsx` files, `apps/web/src/components/status-chip.tsx`, `apps/web/src/components/data-table.tsx` (sortable server-rendered table with a CSV export link route `apps/web/src/app/(app)/products/export/route.ts`)
- Test: `apps/web/src/components/status-chip.test.tsx`, `apps/web/src/app/(app)/products/export/route.test.ts`

**Interfaces:**
- Consumes: `getProducts`, `getAds`, `getInventory`.

- [ ] **Step 1: Write failing tests**: `'StatusChip maps underpriced, healthy, premium, no_cost to distinct labels and text, not colour alone'`; `'the export route returns CSV with a header row and one row per SKU, escaping commas and quotes'`; `'the export route returns 401 without a session'`.
- [ ] **Step 2: Run** and confirm failures.
- [ ] **Step 3: Implement.** Products table columns: price, cost of goods (tooltip COGS), markup and margin side by side, ideal price range, units sold, profit, status chip and message; sortable by clicking headers (search param). Ads page: platform comparison, campaign table ordered losing first with the reason and action text, spend vs revenue note, blended vs platform ROAS with the CLAUDE.md 7.3 tooltip. Inventory page: low stock with days of cover and reason and action, dead and overstock, stock by location.
- [ ] **Step 3b: Check each page in a browser** at 390px and 1280px, keyboard-tab through the table headers.
- [ ] **Step 4: Run** web tests, typecheck, build; confirm pass.
- [ ] **Step 5: Commit** `feat(web): products, ads and inventory screens`.

### Task 11: Monthly P&L screen

**Files:**
- Create: `apps/web/src/app/(app)/reports/page.tsx`, `apps/web/src/components/pnl-table.tsx`, `apps/web/src/app/(app)/reports/loading.tsx`
- Test: `apps/web/src/components/pnl-table.test.tsx`

**Interfaces:**
- Consumes: `getMonthlyPnl`.

- [ ] **Step 1: Write failing tests**: `'PnlTable renders the CLAUDE.md 7.6 line order from gross sales to estimated operating profit'`; `'PnlTable shows a "cost data incomplete" notice when costComplete is false'`; `'PnlTable shows change versus last month and the same month last year, and "no data" when that year is null'`; `'the page renders the management-estimate disclaimer'`.
- [ ] **Step 2: Run** and confirm failures.
- [ ] **Step 3: Implement** a month picker (`?month=YYYY-MM`, default last complete month), the P&L table with tooltips on COGS and contribution margin, channel and ad-platform breakdown, and the plain-English callouts.
- [ ] **Step 3b: Check in a browser** at both widths.
- [ ] **Step 4: Run** web tests, typecheck, build; confirm pass.
- [ ] **Step 5: Commit** `feat(web): monthly P&L screen`.

### Task 12: Hosted Supabase, demo login and Vercel deploy

**Files:**
- Create: `packages/db/src/cli/provision-demo.ts`, `docs/demo.md`
- Modify: `packages/db/package.json` (script `demo:provision`), root `package.json` (`db:demo`), `.env.example`
- Test: `packages/db/test/provision-demo.test.ts` (the pure part: building the org-member row for a given auth user id)

**Interfaces:**
- Produces: `pnpm db:migrate` and `pnpm db:seed` run against hosted Supabase by pointing `DATABASE_OWNER_URL` at the Supabase session-pooler URL (the direct host is IPv6-only). `provision-demo`: uses `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` (never committed, never in Vercel client vars) to create or update an auth user with `email_confirm: true` and the fixed id `DEMO_USER_IDS.owner`, taking `DEMO_LOGIN_EMAIL` and `DEMO_LOGIN_PASSWORD` from the environment.

- [ ] **Step 1: Write a failing test** `'demo membership row maps the auth user id to the demo org as owner'`.
- [ ] **Step 2: Run** and confirm failure.
- [ ] **Step 3: Implement** the CLI and write `docs/demo.md`: create the Supabase project, collect URL, anon key, service role key, pooler connection strings; set `DATABASE_OWNER_URL`; run migrate, seed, provision; create the Vercel project from `main` or `demo-dashboard` with Root Directory `apps/web`, "Include source files outside of the Root Directory" on, install `pnpm install`, build `pnpm turbo run build --filter=@erq/web...`; Vercel env vars `NEXT_PUBLIC_DEMO_MODE=1`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `DATABASE_URL` (the `app_user` pooler URL, transaction mode), and any other variable `apps/web` reads (grep `process.env` in `apps/web`); Supabase Auth settings: site URL set to the Vercel domain, email confirmation on, public sign-ups off.
- [ ] **Step 4: Run** the unit test, then execute the runbook end to end with the owner's Supabase and Vercel accounts: migrate, seed, provision, deploy, sign in as the demo user on the Vercel URL, click through all five screens on desktop and a phone-width window, and confirm a second, non-member account sees `/no-access`.
- [ ] **Step 5: Commit** `feat(demo): provision demo login and deployment runbook`; merge `demo-dashboard` into `main` only after the owner has clicked through the live URL.

---

## Self-review

- **Spec coverage:** Amazon and Shopify in one dashboard (Tasks 1, 2, 3, 9); profitability per channel, SKU, ad and month (Tasks 3, 4, 5, 7); actions not just numbers (Task 6 attention feed, flag reasons in Tasks 4 and 5); Vercel with login (Tasks 8, 12); real screens on seed data (Tasks 2 to 11).
- **Out of scope (non-goals):** real Shopify, Amazon or ad connections; the API; Team and Connections pages in demo mode; billing; customers and loyalty; editing data in the UI; PDF export; per-role cost hiding.
- **Known risks:** nothing here has run on hosted Supabase or Vercel (migrations on Supabase's pooler, `app_user` creation, transaction-mode pooling with `set_config`, Next build of workspace packages on Vercel); Task 12 is where those surface. The seed's 365-day volume (about 8,000 orders) must stay fast; Task 2 has an explicit bound.
