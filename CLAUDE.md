# CLAUDE.md - eRetailQuery

Domain: eretailquery.com
Owner: Abdullah Shekha
Status: Phase 0, 1a, 1b-1, 1b-2, 1b-3a, 1b-3b and 1b-3c (live updates) built and merged into `main` (pushed to GitHub `workagentic/eRetailQuery`), plus the Vercel demo dashboard (Shopify and Amazon seed data, real screens, merged into `main`, deployed from there; runbook in docs/demo.md); see section 16. `main` is the only branch. Next are the CSV import, the manual and CSV cost-entry paths, then 1c Meta/Google and 1d dashboard/P&L/Stripe. Build in the phases defined in section 12. Do not skip ahead.

---

## 1. Product Vision

eRetailQuery is a multi-tenant SaaS web app for US ecommerce and retail business owners. It connects their sales channels (Shopify, WooCommerce, Amazon) and ad platforms (Meta, Google, TikTok) into one place and answers the questions an owner asks every day:

- Am I actually making money, per SKU, per channel, per campaign?
- What should I price this at?
- What is about to run out?
- Which ads should I scale and which should I kill?
- Who are my best customers and how do I keep them?

North star: **reduce the time and expertise an owner needs to run their ecommerce business.** Every screen should answer a question or recommend an action, not just display numbers. Prefer "Pause this ad, it loses $212 per week" over a table of metrics.

Target user: a non-technical owner or small team doing roughly $250K to $20M per year, selling on one or more channels, spending on one or more ad platforms. They are not analysts. Use plain English labels, not jargon, and show a short tooltip for any financial term.

---

## 2. Core Principles

1. **Profit first, revenue second.** Every revenue number should be traceable to a profit number.
2. **Opinionated defaults.** The app should work well with zero configuration. Settings are for overriding, not for getting started.
3. **Plain language.** "Cost of goods" not "COGS" in primary UI (show COGS in tooltip). "Money left after ads" not "contribution margin after marketing" (show the formal term in tooltip).
4. **Explain every flag.** Any warning (low ROAS, low stock, bad margin) must show why it fired and what to do.
5. **Never lose data trust.** Show "last synced" timestamps. Never silently show stale or partial data. If a sync failed, say so on the affected widget.
6. **Money is stored as integer cents** with an ISO currency code. Never use floats for money. Use `Decimal` or integer math only.
7. **Multi-tenant isolation is non-negotiable.** Every tenant-owned table carries `org_id` and is protected by Postgres Row Level Security.

---

## 3. Tech Stack

The owner is an experienced full-stack developer. Use his preferred stack.

| Layer | Choice |
|---|---|
| Frontend | Next.js (App Router), TypeScript, Tailwind CSS, shadcn/ui, Recharts, TanStack Query, TanStack Table |
| Backend API | NestJS (TypeScript), REST with OpenAPI docs, class-validator DTOs |
| Database | PostgreSQL (Supabase for dev, AWS RDS or Supabase for prod), Drizzle or Prisma ORM (pick Drizzle unless a blocker appears) |
| Jobs and sync | BullMQ on Redis for scheduled syncs, webhook processing, report generation |
| Auth | Supabase Auth or Auth.js, email plus Google sign-in, org-based membership and roles |
| File storage | S3 compatible (CSV imports, report PDFs) |
| Hosting | Vercel (web), Supabase (Postgres, auth, storage), Railway for the NestJS API, BullMQ workers and Redis. Vercel serverless cannot run long-lived workers, so the API and workers must live on a persistent host. Move to AWS later only if scale or cost requires it. |
| Billing | Stripe Billing (subscriptions, metered tiers later) |
| Email | Resend or Postmark (transactional), loyalty emails later via provider abstraction |
| Observability | Sentry, structured logging (pino), job dashboard (bull-board) |
| Testing | Vitest or Jest (unit), Playwright (e2e), Testcontainers for integration tests |
| AI layer (phase 4) | Claude API for natural language questions and weekly insight summaries |

Monorepo with pnpm workspaces and Turborepo.

```
eretailquery/
  apps/
    web/            Next.js frontend
    api/            NestJS API
    worker/         BullMQ workers (sync, webhooks, reports)
  packages/
    db/             Schema, migrations, RLS policies, seed data
    shared/         Types, zod schemas, money utils, constants
    connectors/     One folder per integration (see section 6)
    metrics/        Pure functions for ROAS, margin, markup, P&L (heavily unit tested)
    ui/             Shared UI components
  docs/
  CLAUDE.md
```

---

## 4. Domain Glossary (use these exact terms in code)

| Term | Meaning |
|---|---|
| Organization (`org`) | A tenant. One business. Has many members and many connected stores. |
| Store connection | A linked sales channel account (Shopify shop, WooCommerce site, Amazon seller account). |
| Ad connection | A linked ad account (Meta, Google Ads, TikTok Ads, etc). |
| Product | A sellable item definition. |
| SKU / Variant | A specific sellable variation with its own cost, price, and stock. The SKU is the unit of profitability. |
| Landed cost | Everything it costs to get one unit into sellable inventory: product cost, inbound freight, duties, packaging, labeling, prep. This is the "COGS breakdown" the owner asked for. |
| Fulfillment cost | Per order variable costs after the sale: pick and pack, outbound shipping, payment processing fee, marketplace referral fee, FBA fee. |
| COGS | Landed cost of units sold. Accounting term for what the owner described as "cost price". |
| Contribution margin | Revenue minus COGS minus fulfillment cost minus discounts. Before ad spend. |
| Net contribution | Contribution margin minus allocated ad spend. |
| Markup | `(price - cost) / cost`. |
| Margin | `(price - cost) / price`. |
| ROAS | Revenue attributed to an ad or campaign divided by its spend. Platform reported. |
| Blended ROAS (also called MER) | Total store revenue divided by total ad spend across all platforms. Not platform reported. |
| Break-even ROAS | `1 / contribution margin %` before ads. A campaign below this loses money. |
| Target ROAS | Break-even ROAS adjusted for the owner's desired profit. |
| Location | A place that holds inventory: warehouse, retail store, 3PL, Amazon FBA. |

IMPORTANT: Markup and margin are different. A 50% to 100% markup range equals a **33.3% to 50% margin** range. Always label which one is displayed. Default the UI to show both side by side.

---

## 5. Data Model (starting point)

Use snake_case. Every tenant table has `id` (uuid), `org_id`, `created_at`, `updated_at`. Add RLS policy `org_id = current_setting('app.org_id')::uuid` or the Supabase equivalent.

### Identity and tenancy
- `orgs`, `org_members` (role: owner, admin, analyst, viewer), `invites`
- `subscriptions` (Stripe ids, plan, status)

### Connections
- `store_connections` (platform, external_account_id, status, encrypted_credentials, scopes, last_synced_at, last_error)
- `ad_connections` (platform, external_account_id, status, encrypted_credentials, last_synced_at, last_error)
- `sync_runs` (connection_id, type, started_at, finished_at, status, records_processed, error)

### Catalog and costs
- `products` (title, brand, category, status)
- `skus` (product_id, sku_code, barcode, selling_price_cents, compare_at_price_cents, currency, target_markup_pct, status)
- `sku_channel_listings` (sku_id, store_connection_id, external_product_id, external_variant_id, channel_price_cents)
- `sku_cost_components` (sku_id, component_type, amount_cents, per_unit, effective_from, effective_to)
  - `component_type` enum: `product_cost`, `inbound_freight`, `duties_tariffs`, `packaging`, `labeling_prep`, `other_landed`
  - Costs are time versioned. Historical orders must use the cost effective on the order date.
- `sku_fulfillment_costs` (sku_id or channel level, type enum: `pick_pack`, `outbound_shipping`, `payment_fee_pct`, `payment_fee_fixed`, `marketplace_fee_pct`, `fba_fee`, `returns_allowance_pct`)
- `promotions` (name, type: percent/fixed/bogo/free_shipping, value, starts_at, ends_at, scope sku/collection/channel)
- `promotion_skus`

### Inventory
- `locations` (name, type: warehouse/store/3pl/fba/other, address)
- `inventory_levels` (sku_id, location_id, on_hand, reserved, incoming, reorder_point, safety_stock)
- `inventory_movements` (sku_id, location_id, delta, reason, ref_type, ref_id) - append only ledger
- `purchase_orders`, `purchase_order_lines` (phase 3)

### Orders and customers
- `customers` (org_id, email_hash, email_encrypted, name, first_order_at, last_order_at, total_orders, total_spent_cents, source_platform, marketing_consent)
- `customer_identities` (customer_id, platform, external_id) - to merge the same person across channels
- `orders` (store_connection_id, external_order_id, customer_id, placed_at, status, gross_cents, discount_cents, shipping_charged_cents, tax_cents, refund_cents, net_cents, utm_source, utm_medium, utm_campaign, landing_site)
- `order_lines` (order_id, sku_id, quantity, unit_price_cents, discount_cents, unit_cogs_cents_snapshot)
- `refunds`, `cancellations`
- `support_tickets` (customer_id, source, category, status, opened_at, closed_at) - manual entry in phase 2, helpdesk integrations later

### Advertising
- `ad_campaigns`, `ad_sets`, `ads` (platform, external_id, name, status, objective)
- `ad_insights_daily` (ad_id, date, spend_cents, impressions, clicks, platform_conversions, platform_revenue_cents)
- `ad_flags` (ad_id, flag_type: winning/losing/watch, reason, computed_at)

### Loyalty (phase 3)
- `loyalty_programs`, `loyalty_tiers`, `loyalty_accounts`, `loyalty_transactions`, `loyalty_rewards`

### Reporting
- `report_snapshots` (period_type, period_start, period_end, payload_json, generated_at)
- `alerts` (type, severity, entity_ref, message, resolved_at)

Index every `(org_id, date)` and `(org_id, sku_id)` combination used by dashboards. Use materialized views or summary tables (`sku_daily_metrics`, `channel_daily_metrics`) refreshed by workers for dashboard speed.

---

## 6. Integrations

Build every connector behind a common interface in `packages/connectors`:

```ts
interface StoreConnector {
  connect(oauthParams): Promise<Connection>
  backfill(connection, since: Date): AsyncIterable<NormalizedOrder | NormalizedProduct | NormalizedInventory>
  syncIncremental(connection, cursor): Promise<SyncResult>
  handleWebhook(payload, headers): Promise<void>
  pushPrice?(sku, price): Promise<void>        // phase 4
  pushInventory?(sku, location, qty): Promise<void>  // phase 4
}
interface AdConnector {
  connect(oauthParams): Promise<Connection>
  syncInsights(connection, dateRange, level: 'campaign'|'adset'|'ad'): Promise<SyncResult>
}
```

Connectors normalize into our schema. No platform specific fields leak outside `packages/connectors`.

### 6.1 Sales channels
| Platform | Notes |
|---|---|
| Shopify | OAuth app, Admin GraphQL API, webhooks for orders, products, inventory, app uninstall. Must implement mandatory privacy webhooks (customer data request, customer erasure, shop erasure). Protected customer data access requires approval in Partner dashboard. |
| WooCommerce | REST API with consumer key and secret generated by the merchant, or an app authorization endpoint flow. Webhooks per topic. Handle self hosted sites with unreliable uptime and HTTP rate limits. |
| Amazon | Selling Partner API (SP-API). Requires developer registration and app approval. Buyer PII is heavily restricted, so customer level features on Amazon data are limited (no buyer email). Fees and settlement data come from the Finances and Reports APIs. Design the customer module so Amazon orders create anonymous or limited customer records. |

Later channels: BigCommerce, Etsy, eBay, Walmart Marketplace, TikTok Shop, Square and Shopify POS for physical stores.

### 6.2 Ad platforms
| Platform | Notes |
|---|---|
| Meta Ads | Marketing API, OAuth, requires app review for advanced access. Pull daily insights at ad level. |
| Google Ads | Google Ads API, requires developer token approval. Include Performance Max and Shopping campaign types. |
| TikTok Ads | TikTok Marketing API, requires app approval. |
| Recommended additions | Microsoft (Bing) Ads, Pinterest Ads, Snapchat Ads, Amazon Ads, Reddit Ads, Klaviyo or Mailchimp (email and SMS revenue and cost, for channel comparison) |

IMPORTANT: Approval for Shopify protected data, Amazon SP-API, Meta, Google Ads, and TikTok can take days to weeks. Start these applications in week 1 of phase 1. Verify the current requirements in each platform's official docs before building, since policies change.

### 6.3 Connector rules
- Store credentials encrypted at rest (AES-256-GCM with a KMS managed key). Never log tokens.
- Webhook endpoints verify signatures and are idempotent (dedupe by external id plus event id).
- Initial backfill is chunked and resumable. Show progress to the user.
- Respect rate limits with per-connection token buckets and exponential backoff.
- Ad platform data is re-pulled for the trailing 7 days on every sync because platforms revise numbers.
- Handle currency. Store original currency and convert to the org reporting currency using a daily FX table. Default USD.
- Fallback for any platform: CSV upload with a column mapping UI. This also serves as the first onboarding path for users without API access.

---

## 7. Business Logic (implement in `packages/metrics`, pure functions, fully unit tested)

### 7.1 SKU pricing
Inputs: landed cost components, fulfillment cost assumptions, discounts, selling price.

```
landed_cost       = sum(cost components)
variable_cost     = landed_cost + fulfillment_costs + payment/marketplace fees
markup_pct        = (price - landed_cost) / landed_cost
margin_pct        = (price - landed_cost) / price
contribution_pct  = (price - discount - variable_cost) / (price - discount)
ideal_price_low   = landed_cost * 1.5      // 50% markup
ideal_price_high  = landed_cost * 2.0      // 100% markup
```

Display for each SKU: current price, markup, margin, ideal price range, and a status:
- Below range: "Underpriced. Raise to at least $X."
- In range: "Healthy."
- Above range: "Premium. Check that it is still selling."

Make the target markup range configurable per org and per category (default 50% to 100%). Also compute a **floor price** that guarantees a minimum contribution margin after fees and shipping, because a good looking markup can still lose money once shipping and fees are included. Show a warning when the markup looks fine but contribution is negative.

Promotions: show margin at the discounted price, and show the maximum discount that still keeps contribution above the owner's minimum.

### 7.2 Inventory
- Stock by location and total, available = on_hand minus reserved.
- Daily sales velocity using trailing 7, 30, 90 day windows, weighted toward recent.
- `days_of_cover = available / velocity`.
- Flag **low stock** when days_of_cover is less than supplier lead time plus safety buffer (default 14 days if lead time unknown), or available is at or below reorder_point.
- Flag **overstock** when days_of_cover exceeds 180 days.
- Flag **dead stock** when no sales in 90 days.
- Suggested reorder quantity (phase 3): `velocity * (lead_time + cover_target) - available - incoming`.

### 7.3 Advertising
```
roas              = platform_revenue / spend
blended_roas      = total_store_revenue / total_ad_spend        // MER
break_even_roas   = 1 / avg_contribution_margin_pct_before_ads
cpa               = spend / conversions
```

Flag rules (thresholds configurable per org, defaults below):
- **Winning**: ROAS >= 1.5 x break-even, spend over minimum data threshold (default $50 and 1,000 impressions in the window), trending stable or up.
- **Losing**: ROAS < break-even for 7 days with spend over threshold. Estimated daily loss shown.
- **Watch**: between break-even and 1.5 x break-even, or declining more than 20 percent week over week.
- **Learning**: not enough data. Never flag these as losing.
- If an org has no cost data, fall back to generic bands (below 1.5 poor, 1.5 to 3 average, above 3 good) and prompt the user to add costs for accurate flags.

Display both platform reported ROAS and blended ROAS. Add a tooltip explaining that platform numbers can overlap and over claim, and that blended ROAS is the honest overall number. A first party tracking pixel is a phase 4 item. Until then, use UTM data from orders where available as a second opinion.

### 7.4 Customers
- Repeat customer: 2 or more non-cancelled orders.
- Repeat rate, average order value, orders per customer, days between orders.
- Cancellation rate and refund rate per customer and per SKU.
- Complaint count from support tickets.
- Customer lifetime value (observed, then predicted in phase 4).
- RFM segments (Recency, Frequency, Monetary): Champions, Loyal, At Risk, Lost, New.
- Top customers by net spend. Top products by channel. First product bought vs repeat products.
- Flag "high value but at risk" customers (top quartile spend, no order in 1.5x their usual gap).

### 7.5 Loyalty program (phase 3)
Configurable points program:
- Earn rules: points per dollar, bonus actions (account creation, review, referral, birthday).
- Tiers: thresholds by spend or points, with perks.
- Redemption: discount codes pushed to Shopify and WooCommerce via API. Amazon customers cannot be enrolled (no contact data).
- Liability tracking: outstanding points valued in dollars, shown on the P&L as an accrual.
- Start simple: points plus one redemption type (fixed dollar discount code). Do not build a full loyalty platform in v1.

### 7.6 Reports and P&L
Periods: month, quarter, year, custom range, with comparison to the previous period and the same period last year.

P&L structure:
```
Gross sales
- Discounts
- Refunds and returns
= Net sales
- COGS (landed cost of units sold, using cost snapshot at order time)
= Gross profit
- Fulfillment: shipping, pick and pack
- Payment processing fees
- Marketplace fees
= Contribution margin
- Ad spend (by platform)
= Net contribution after marketing
- Other operating expenses (manual entry: rent, salaries, software, etc)
= Estimated operating profit
```

Breakdowns by: sales channel, ad platform, product, category, customer segment.
Best and worst rankings: channels, ad platforms, campaigns, SKUs, with plain English call outs ("Meta lost $1,240 this quarter, TikTok earned $3,980").
Exports: PDF and CSV. Scheduled email delivery (monthly summary to the owner).
Disclaimer: reports are management estimates, not accounting or tax filings. Offer QuickBooks Online and Xero export or sync in phase 3.

---

## 8. Frontend: Screens

1. **Onboarding wizard**: Connect store, connect ads, import SKUs and costs (CSV or auto from store), set targets. Show "Time to first insight" under 10 minutes as the goal. Skippable steps with sensible defaults.
2. **Home dashboard**
   - Today strip: revenue, orders, ad spend, blended ROAS, estimated profit
   - "What needs your attention" feed (top 5 prioritized alerts with one click actions)
   - Inventory snapshot, ads snapshot, channel snapshot
   - Date range selector and channel filter apply globally
3. **Products and pricing**: table with price, cost, markup, margin, ideal range, stock, status chips. Detail drawer with cost breakdown editor, promotion simulator, price history. Bulk edit and CSV import.
4. **Inventory**: by location, low stock list, days of cover, reorder suggestions, stock movements.
5. **Advertising**: channel comparison, campaign and ad tables, winning and losing tabs, spend vs revenue trend, flagged items with reason and suggested action.
6. **Customers**: list with search, segments, profile page (orders, products, refunds, tickets, loyalty), top customers, cohort retention chart.
7. **Loyalty**: program builder, members, liability.
8. **Reports**: pick period, view P&L, drill down, export, schedule.
9. **Alerts and settings**: thresholds, notification channels (email first, Slack later), team members, billing, connections health.

UX rules:
- Mobile responsive. Owners check this on their phone.
- Every table: sortable, filterable, CSV export, saved views.
- Empty states explain the next step and offer a one click action.
- Loading skeletons, never spinners that block the page.
- Accessibility: WCAG AA, keyboard navigable.

---

## 9. Security and Compliance

- Encrypt all third party credentials. Rotate encryption keys via KMS.
- RLS on all tenant tables plus API level org checks. Add an automated test that proves tenant A cannot read tenant B for every table.
- Role based access (owner, admin, analyst, viewer). Cost data may be hidden from viewer role.
- Audit log for connection changes, cost edits, price pushes, and exports.
- PII: store email encrypted plus a hash for lookup. Support customer data export and deletion requests (Shopify mandatory webhooks, CCPA, GDPR for any EU visitors).
- Never put secrets in the repo. Use `.env.example` and a secrets manager.
- Terms of service and privacy policy pages required before launch. Cookie banner on the marketing site.
- Marketing consent flag respected before any loyalty or promotional email.

---

## 10. Engineering Conventions

- TypeScript strict mode everywhere. No `any` without a comment.
- Validate all inputs with zod at API boundaries. Share schemas via `packages/shared`.
- Conventional Commits. Small PRs. One feature per branch.
- Database changes only through migrations. Never edit the schema by hand.
- Business logic lives in `packages/metrics` and service classes, never in controllers or React components.
- Every metric function has unit tests with edge cases (zero revenue, zero spend, missing cost, refunds exceeding sales, timezone boundaries).
- Timezones: store UTC, report in the org's configured timezone. Daily rollups use the org timezone.
- API: REST, plural nouns, cursor pagination, consistent error shape `{ error: { code, message, details } }`.
- Background jobs are idempotent and safe to retry.
- Feature flags for anything unfinished.
- Provide a seed script that generates a realistic demo org (3 channels, 3 ad platforms, 200 SKUs, 12 months of orders) so every screen can be developed and demoed without live APIs. Also use it for the public demo mode.

### Commands (create these scripts)
```
pnpm dev            # run web, api, worker
pnpm db:migrate     # apply migrations
pnpm db:seed        # load demo data
pnpm test           # unit tests
pnpm test:e2e       # Playwright
pnpm lint           # eslint + prettier check
pnpm typecheck
```

### Definition of done
A feature is done when: typed, validated, tested (unit plus at least one integration or e2e path), RLS verified, loading and error and empty states handled, mobile checked, and documented in `docs/`.

---

## 11. Pricing Model (for Stripe setup later)

Suggested starting point, to be validated with early users:
- Free: 1 store, 1 ad account, 50 SKUs, 30 day history, limited dashboard
- Growth: about $49 to $99 per month, 3 stores, 3 ad accounts, unlimited SKUs, full history, reports, alerts
- Pro: about $149 to $299 per month, unlimited connections, loyalty, AI insights, team seats, scheduled reports
Price tiers by order volume rather than revenue where possible, since revenue based pricing is a common complaint about competitors. Offer a 14 day trial on paid plans.

---

## 12. Build Phases

### Phase 0 (week 1): Foundations
Repo, monorepo, CI, auth, orgs and roles, base schema with RLS, design system, seed script. Submit developer app applications to Shopify, Amazon, Meta, Google Ads, TikTok.

### Phase 1 (weeks 2 to 6): The profit core (MVP)
- Shopify connector (products, orders, inventory) plus CSV import fallback
- SKU module with cost breakdown, markup and margin, ideal price range
- Three cost entry paths: auto import from Shopify cost per item, CSV upload with column mapping, and manual entry in the app. Imported costs pre-fill the product cost component only; the owner completes freight, packaging and other components.
- Shopify POS sales ingested through the same orders sync, tagged with a channel of `shopify_pos` so online and in-store results are reported separately
- Inventory locations: Shopify locations sync automatically, plus manual stock counts for locations Shopify does not track
- Meta Ads insights sync (first ad connector, build and ship before any other ad platform), then Google Ads insights sync
- Home dashboard with blended ROAS, ROAS by channel, winning and losing ad flags, low stock list
- Monthly P&L report
- Stripe billing
Goal: a Shopify merchant connects and sees real profit in under 10 minutes.

### Phase 2 (weeks 7 to 12): Breadth and customers
- WooCommerce and TikTok Ads connectors
- Multi location inventory and movements
- Customer module: profiles, repeat behavior, cancellations, refunds, RFM, top customers, manual complaints log
- Quarterly and annual reports, comparisons, PDF and CSV export
- Alerts via email
- Promotion simulator

### Phase 3 (weeks 13 to 20): Amazon and retention
- Amazon SP-API connector, fees and settlement based profit
- Loyalty program v1
- Purchase orders and reorder suggestions
- QuickBooks Online and Xero sync
- Klaviyo or Mailchimp integration
- Pinterest, Microsoft, Snapchat Ads

### Phase 4: Intelligence and automation
- AI assistant ("Ask eRetailQuery"): natural language questions answered from the tenant's own data using Claude API with tool calls to read only functions. Weekly plain English summary email.
- First party tracking pixel and server side events for better attribution
- Demand forecasting
- Push price and inventory changes back to channels with approval workflow
- Supplier management, landed cost calculator, tariff impact simulator
- Slack and WhatsApp alerts, mobile app or PWA
- Agency and multi store accounts

---

## 13. Out of Scope for v1

Do not build: a storefront or checkout, a full ERP or accounting ledger, a helpdesk (only light ticket logging), shipping label purchase, SMS or email campaign sending, multi-language UI, non-US tax compliance. Revisit after launch.

---

## 14. Open Questions for the Owner (ask before building the affected area)

1. RESOLVED: the product is named eRetailQuery everywhere in the UI.
2. RESOLVED: first target segment is Shopify DTC brands (see Decisions Log).
3. RESOLVED: all three cost entry paths ship in Phase 1 (see Decisions Log).
4. RESOLVED: v1 includes both Shopify POS sales and manual-count inventory locations (see Decisions Log).
5. RESOLVED: QuickBooks Online is the first accounting sync target in Phase 3. Xero comes later.
6. RESOLVED: Vercel plus Supabase for production (see section 3 and Decisions Log). Budget and region still to be confirmed before launch.
7. RESOLVED: yes, a limited free plan at launch (see section 11).

When any of these block a decision, ask the owner rather than guessing.

---

## 15. Instructions for Claude Code

- Start with Phase 0. Propose the exact folder structure and migration plan, wait for approval, then build.
- Work in small vertical slices that run end to end (DB, API, UI, test).
- Before adding a dependency, state why and prefer what is already in the stack.
- Never hardcode API keys. Never commit secrets.
- On the Windows dev machine, background commands have no real console. Never start a bare interactive `python` (or any REPL) in the background: it loops on `OSError: WinError 6/123` and wrote a 5 GB output file. Run `python script.py` or `python -c "..."` instead, and check the size of background task output files if disk space drops.
- When a platform API behavior is uncertain, check the official documentation rather than assuming, and note the doc link in a code comment.
- Keep this file updated as decisions are made. Add a "Decisions Log" section at the bottom with date and rationale.
- If a requirement here conflicts with security or data accuracy, raise it instead of silently picking one.

---

## 16. Current State (Phase 0, Phase 1b-3c and the demo dashboard built)

Specs and plans live in `docs/superpowers/specs/` and `docs/superpowers/plans/`. Each later phase gets its own spec and plan. Read `docs/dev-setup.md` and `docs/architecture/tenancy.md` before changing the database, auth or CI.

**Roadmap status** (five top-level phases, section 12): Phase 0 done. Phase 1 in progress: 1a metrics done; 1b done through 1b-1 (sync foundations), 1b-2 (Shopify connection), 1b-3a (hardening) and 1b-3b (Shopify connector), merged into `main`, and 1b-3c (live updates), also merged into `main` (everything is pushed to GitHub, `main` is the default branch; push with the `workagentic` gh account, not `abdullahshekha`); still to do in 1b are only the CSV import with column mapping and the manual and CSV cost entry paths (only the Shopify cost import exists); then 1c Meta and Google ads sync and 1d dashboard, monthly P&L and Stripe billing. Phases 2, 3 and 4 are not started and each gets its own spec and plan.

**Built:** pnpm/Turborepo monorepo (`apps/api`, `apps/web`, `apps/worker`; `packages/shared`, `db`, `ui`, `metrics` (pricing, ad flags, inventory flags, monthly P&L: see docs/metrics.md), `connectors` (page-based `fetchPage` contract, typed errors, credential helpers, registry, fake connector and contract suite), `sync` (page-job engine and idempotent sinks: see docs/sync.md)). Postgres schema with RLS for identity, audit log, connections, products, SKUs, time-versioned cost components, and (Phase 1b-1) locations, inventory levels and movements, channel listings, orders, order lines, refunds and sync cursors. Supabase Auth with a NestJS API (`/me`, `/orgs`, members, invites), a BullMQ worker with a tenant-scoped job wrapper, a Next.js shell (sign in, onboarding, org switcher, team, invites), an idempotent demo seed, and a CI workflow. Phase 1b-2 adds the Shopify connection (see docs/shopify-connection.md): OAuth install with an encrypted token, a webhook receiver with dedupe, uninstall and privacy-webhook handling in the worker (`shop/redact` purges the connection), a Connections page, the `oauth_states` and `webhook_events` tables, and `packages/connectors/src/shopify`. Phase 1b-3a hardened it. Phase 1b-3b adds the Shopify connector (docs/shopify-connection.md sections 9 and 10, docs/sync.md): paginated GraphQL `fetchPage` for locations, products with unit costs, inventory and orders (POS as the channel `shopify_pos`, test orders flagged) with small page sizes that stay under Shopify's 1000-point query cost cap, exact decimal-string money conversion, the first backfill started automatically after connect, `POST /orgs/:orgId/connections/:id/sync` (Sync now, owner or admin) with a sync summary on the connections list, the engine recording `last_synced_at` and recovering errored connections, and sync progress on the Connections page. Customers, UTM and landing site are not imported (protected customer data). Phase 1b-3c adds live updates (docs/sync.md "Live updates"): expiring offline tokens refreshed under a connection row lock, a one-minute scheduler polling on a tiered cadence, product and stock webhook nudges, an order-line link-up pass, per-resource sync status, and retry plus alerts for failed webhook events (new migrations 0022 to 0026, the `alerts` table).

**Rules that are easy to break:**
- Every tenant database call goes through `withTenant(orgId, fn)`. Every new tenant table needs a migration that calls `app_secure_tenant_table`, a fixture in `packages/db/test/fixtures.ts`, and composite `(org_id, id)` foreign keys to tenant parents. The isolation suite fails otherwise.
- `app_user` (API and worker) must never be superuser or BYPASSRLS, and cannot insert or delete `orgs`. The migration role must be superuser or BYPASSRLS because the SECURITY DEFINER account functions rely on it.
- New SECURITY DEFINER functions must set `search_path = pg_catalog, public, pg_temp`, revoke EXECUTE from PUBLIC, and be granted only to `app_user`.
- Invite acceptance trusts the JWT `email` claim, so Supabase email confirmation must be enabled in production. Local e2e config disables it.
- Apps must never import `@erq/db/admin` (ESLint enforces this).
- Sync sinks must be idempotent and respect `external_updated_at` (an older update never overwrites newer data). A sync cursor never advances without its data: both commit in the same transaction. Connectors never touch the database.
- Connection credentials are encrypted with AAD `connection:<id>` and never travel in job data. `app_list_stalled_sync_cursors` is the only intentional cross-tenant read; never expose it through an API route.
- Webhook endpoints verify the HMAC over the raw body and are idempotent. The only public Shopify route is the webhook receiver (`POST /webhooks/shopify`); it never trusts the body for org or user, and webhook bodies are never persisted (payload is always `{}`).
- The OAuth callback is authenticated (`POST /connections/shopify/callback`, reached through the web route): it requires the signed-in user to be the one who started the install and a current owner or admin of the state's org, and the org never comes from the session.
- `app_purge_shop` is worker-only. The SECURITY DEFINER functions `app_consume_oauth_state`, `app_find_store_connection`, `app_list_stale_webhook_events`, `app_purge_store_connection` and `app_purge_shop` are never exposed through generic authenticated routes. Stored error text goes through `sanitizeMessage`. Disconnecting is a status change, never a row delete (only `shop/redact` purges).
- The Shopify connector never touches the database and never queries protected customer fields (customer, UTM, landing site). Money from Shopify is converted with exact string math only (`parseMoneyToMinorUnits`), never floats. Any GraphQL `errors` entry fails the page. Page sizes in `packages/connectors/src/shopify/cursor.ts` are tied to the 1000-point cost cap: do not raise them without checking the real costs.
- The API (`BullMqSyncQueue`) and the worker agree on the queue name `sync`, the job name `page` and its options (5 attempts, exponential backoff from 5 s). Change both sides together.
- The engine sets `last_synced_at` and recovers `error` to `active` only at a real chain end and never for a `resumed` job; `failRun` never touches disconnected or demo connections.
- Post-login redirects go through `safeNextPath`. Do not build redirect targets from user input any other way.
- New API controllers must apply `AuthGuard`, `OrgGuard`, `RolesGuard` in that order on every route, except the Shopify OAuth callback (`AuthGuard` only; the org comes from the consumed state) and the public webhook receiver; guards are not global yet.
- Shopify access tokens are short-lived and expiring: refresh only through `createTokenService` (connection row lock `FOR NO KEY UPDATE`, rotated pair written in the same transaction); the connector never sees the refresh token; never log it or put it in a job, DTO, audit row or error text. Lock order is the `store_connections` row first, then the `webhook_events` row.
- `store_connections.last_synced_at` is the OLDEST of the four resource times and only exists when all four completed. The scheduler (`app_list_due_sync_resources`, `app_list_idle_refresh_connections`) and `app_list_stale_webhook_events` are worker-only SECURITY DEFINER reads, never exposed through a route.
- A webhook nudge never carries or keeps data (payload `{}`), is gated in the database (not by a queue job id) and never starts a first import. Order, refund and customer webhook topics stay unsubscribed until Shopify's protected customer data approval exists. A reconnect retires the connection's pending `app/uninstalled` events.

**Demo dashboard (built 2026-10-20, docs/demo.md and `docs/superpowers/plans/2026-10-20-demo-dashboard.md`):** a Vercel-hosted demo for the owner's boss: one dashboard for a seeded business selling on Shopify and Amazon. With `NEXT_PUBLIC_DEMO_MODE=1` the Next.js app reads hosted Supabase Postgres directly (no API, Redis or worker deployed), signing in as the one provisioned demo owner. Screens: Dashboard (KPI cards with trend lines, "where every $100 of sales goes", revenue and money-left trend, Shopify vs Amazon, "what needs your attention"), Products and pricing (with CSV export), Ads (winning and losing verdicts, break-even ROAS chart), Inventory and Profit and loss (waterfall). All queries live in `packages/db/src/reports/*` and feed `packages/metrics`. Schema additions (migration 0027): `amazon` sales channel, per-order fee columns, `amazon_ads` platform, `ad_campaigns`, `ad_insights_daily`. The seed (`packages/db/src/demo-data.ts`, `seed.ts`) generates 365 days ending the day it runs with a planted story, so reseed before a demo. Design: dark sidebar shell, Plus Jakarta Sans, tokens in `packages/ui/src/theme.css`, charts with Recharts, product and ad pictures are Pexels stock photos hotlinked by id with an icon fallback (`apps/web/src/lib/product-art.ts`, `ad-art.ts`).

**Rules for the demo code that are easy to break:**
- The report pages (`/products`, `/ads`, `/inventory`, `/reports`, the dashboard data) read the database directly through `getTenantDb()` and call `notFound()` unless demo mode is on; outside demo mode the web app has no `DATABASE_URL` and must not gain one. They move onto the API in Phase 1d.
- `DATABASE_URL` for the web app is the `app_user` role through Supabase's transaction-mode pooler (user `app_user.<project-ref>`, port 6543); the pool is a global singleton with `max: 1`. The service role key and `DATABASE_OWNER_URL` stay on the developer's machine, never on Vercel.
- Chart colours are hex values, and design tokens use `@theme static`. Tailwind v4 drops theme variables that no class mentions, which made the first charts invisible; never put a `var(--color-*)` in an SVG prop unless the variable is emitted.
- Every report query must keep working when costs are missing (null cost snapshot), a cost component is per batch or non-USD, an org has no orders or no ad spend, and the channel filter is set; `getAttention` follows the channel filter.
- Money in charts is cents; chart data shaping is pure and tested in `apps/web/src/lib/chart-data.ts`.

**Commands:** `pnpm dev`, `pnpm db:migrate`, `pnpm db:seed`, `pnpm test`, `pnpm test:e2e`, `pnpm lint`, `pnpm typecheck`. On small disks run `pnpm turbo run test --concurrency=1`. Tests use Testcontainers when Docker is available, otherwise an embedded Postgres (`ERQ_TEST_DB=docker|embedded|auto`).

**Not yet verified by running:** the Redis rate limiter, the BullMQ sync queue and the sync worker (no Redis or Docker in dev), the BullMQ system-worker test, the Playwright e2e, live Supabase login and middleware flows, the seed CLI, and the CI workflow. The first CI run with Docker is their first execution. Also unverified (1b-2): everything against real Shopify, the BullMQ webhook queue, worker and sweep, and the Playwright connect test. Also unverified (1b-3b): everything against a real Shopify shop (GraphQL field names and shapes, query cost numbers and page sizes, the rate-limit policy, the API version), the Redis sync queue producer in the API, and the Sync now button in a browser (checklist: docs/shopify-connection.md section 10). Also unverified (demo dashboard): everything in a real browser (the redesign, charts and stock photos have not been looked at on a phone or desktop by the developer; Vercel's deployment protection blocked automated checks), the live Supabase sign-in flow for the demo user, the no-access page for a second account and the CSV export without a session. Also unverified (1b-3c): everything against real Shopify (expiring token exchange, refresh and rotation, product and stock subscriptions, polling query cost), the BullMQ `sync-tick` scheduler, nudge and sweep through real BullMQ, and the Connections page (per-resource status, alerts) in a browser.

**Known open items (details in docs/shopify-connection.md section 8):**
- The OAuth redirect signature is accepted in both the encoded and the decoded signed form; verify on the first real install and drop one.
- Failed webhook events: the sweep retries failed privacy events without limit (migration 0021) and failed `app/uninstalled`, `products/update` and `inventory_levels/update` events 5 times, then raises an alert (1b-3c). Not covered: nothing alerts on a privacy event that keeps failing, a final retry that never executes leaves no alert, and failed events of other topics are never retried.
- The API and worker share `app_user`, which can execute `app_purge_store_connection` and `app_purge_shop`; consider a separate worker role.
- The webhook subscription GraphQL details are unverified against real Shopify.
- After 1b-3c (details in docs/sync.md "Known gaps after 1b-3c"): the `then` chain is not persisted, nudges inside the debounce window are dropped until the next poll, orders have a 15-minute latency until protected customer data approval exists, overlapping ticks and a whole-table `sync_cursors` scan per tick, a link-up line whose SKU has no cost keeps a NULL snapshot until `repriceOrderLines`, migration 0018 (`app_purge_shop`) still uses `FOR UPDATE` on `store_connections`. Tax-inclusive shops double count tax (documented limitation).
- Edge: a 401 from the API for a user whose web session still looks valid bounces to the dashboard and loses the OAuth callback (the user restarts the connection).
- Embedded Postgres test cleanup: the orphan `io_worker` leak was caused by `taskkill /T` killing children while the postmaster lived (crash recovery respawned them); fixed by killing the postmaster alone first, then its children by parent pid. Verified on Windows (three full `@erq/db` runs and three single-file runs with zero leftover processes); the helper now also guards pid kills by the postmaster's exact creation time. POSIX paths remain unverified until CI. Other packages load `@erq/db/testing` from `dist`: run `pnpm turbo run build --filter=@erq/db` before running their tests directly.

**Known deferred items:** global deny-by-default guard, `money(-0)` handling and extra money tests (Phase 1a), Swagger gating in production, worker shutdown robustness, UX polish on the web pages, and the seed slug `demo` colliding with a real org named "Demo".

---

## Decisions Log

- 2026-10-05: First target segment is Shopify DTC brands. WooCommerce and Amazon follow in later phases.
- 2026-10-05: Meta Ads is the first ad connector, delivered in Phase 1 alongside Shopify.
- 2026-10-05: All three cost entry paths (Shopify import, CSV, manual) ship in Phase 1.
- 2026-10-05: v1 includes Shopify POS sales and manual-count inventory locations. Third-party POS systems are out of scope.
- 2026-10-05: A limited free plan exists at launch. Exact limits follow section 11 until revised.
- 2026-10-05: Product name in the UI is eRetailQuery everywhere.
- 2026-10-05: QuickBooks Online is the first accounting integration (Phase 3).
- 2026-10-05: Production hosting is Vercel plus Supabase, with the API and workers on a persistent host (Railway) because they cannot run on Vercel serverless.
- 2026-10-05: Phase 0 is specced and planned separately (`docs/superpowers/specs/2026-10-05-phase0-foundations-design.md`). Phase 1 is split into 1a metrics, 1b Shopify + CSV, 1c Meta/Google, 1d dashboard/P&L/Stripe, each with its own spec.
- 2026-10-05: Auth is Supabase Auth (email + Google). The API verifies Supabase JWTs with `jose`; verify key type against current Supabase docs before launch.
- 2026-10-05: Tenant isolation uses a transaction-local `app.org_id` set by `withTenant`, a non-superuser `app_user` role, and RLS with FORCE. Pre-org operations use three SECURITY DEFINER functions; the migration role must be superuser or BYPASSRLS.
- 2026-10-05: Child tables reference parents with composite `(org_id, id)` foreign keys so a row can never point at another tenant's parent.
- 2026-10-05: Internal packages build to CJS with tsup; the API uses NestJS with the SWC builder; zod is pinned to v3 so zod-to-json-schema can generate OpenAPI bodies.
- 2026-10-05: NestJS is pinned to ^11 because Nest 12 is ESM-only and breaks the CJS setup. `@swc/core` is pinned to exactly 1.15.47 because 1.16.x fails to load its native addon on the Windows dev machine. Revisit and unpin when resolved or verified on CI.
- 2026-10-05: Test database is Testcontainers when Docker is available, with an `embedded-postgres` fallback otherwise (the dev machine had no Docker). Override with `ERQ_TEST_DB=docker|embedded|auto`.
- 2026-10-05: Tailwind v4 theme utilities are used instead of arbitrary `[--var]` classes, and tool config files use `.mts` under TS6 and Vitest 5, to keep ESM config loading working.
- 2026-10-05: TypeScript is pinned to 6.x until typescript-eslint supports 7. `ignoreDeprecations: "6.0"` is set in `tsconfig.base.json`; remove it on TS7.
- 2026-10-05: Known unverified at merge: the BullMQ system-worker test and the Playwright e2e were never run, because the dev environment had no Docker or Supabase. The first CI run is their first real execution.
- 2026-10-06: Migration 0006 hardens the database: SECURITY DEFINER functions pin `search_path = pg_catalog, public, pg_temp` (pg_temp last), `anon` and `authenticated` (Supabase) lose all privileges in `public`, helper functions lose PUBLIC execute, and `app_user` can no longer INSERT or DELETE `orgs`. pnpm 11 `allowBuilds` must list every `@embedded-postgres/*` platform package explicitly (strictDepBuilds), otherwise installs fail on Linux and macOS.
- 2026-10-06: Metrics conventions (Phase 1a): percentages are integer basis points, ROAS is a plain number, "losing" means the trailing-7-day total ROAS is below break-even, default minimum contribution is 15%, default stock buffer is 7 days, and velocity weights are 50/30/20 over 7, 30 and 90 days. See docs/metrics.md.
- 2026-10-06: Sync is a chain of small page jobs. The cursor is committed in the same transaction as the page data, and the next job is enqueued after commit (docs/sync.md).
- 2026-10-06: Orders carry only an opaque customer external id in Phase 1; the customers table comes in Phase 2.
- 2026-10-06: One currency per org in Phase 1. Orders in another currency are stored with their currency but no FX conversion exists yet.
- 2026-10-06: Shopify cost import never overwrites existing costs. It writes a `product_cost` component only when the SKU has none.
- 2026-10-06: Order dates used for cost snapshots are taken in the org timezone.
- 2026-10-06: Stalled sync runs are found through the SECURITY DEFINER function `app_list_stalled_sync_cursors`, because the resumer has no org context.
- 2026-10-07: The Shopify connection is built against fakes until a Partner app exists; nothing has run against real Shopify.
- 2026-10-07: Webhooks are verified, stored, deduplicated and acknowledged fast, then processed by the worker.
- 2026-10-07: Data-topic webhook events (orders, refunds, products, inventory) are stored with status `deferred` for 1b-3.
- 2026-10-07: Final review: 1b-2 subscribes shops to `app/uninstalled` only. Data-topic subscriptions (orders, refunds, products, inventory) move to 1b-3 together with their consumption and Shopify's protected customer data approval, because their payloads carry customer data and an unapproved subscription would fail on real shops. A data-topic event that arrives anyway is deferred with its payload emptied to `{}`.
- 2026-10-07: `shop/redact` purges the connection's data through the SECURITY DEFINER function `app_purge_store_connection`; the org's catalog and costs are kept.
- 2026-10-07: A shop can be actively connected to only one org (check-then-act in the callback, no unique index yet).
- 2026-10-07: Only the read-only scopes 1b-3 needs are requested (`read_products`, `read_inventory`, `read_locations`, `read_orders`); protected customer data is not requested.
- 2026-10-08: The Shopify OAuth callback moved behind the web session: Shopify redirects to `${WEB_PUBLIC_URL}/connections/shopify/callback`, which forwards the raw query to the authenticated `POST /connections/shopify/callback`. The caller must be the user who started the install and a current owner or admin of the state's org. The public callback route is removed.
- 2026-10-08: `shop/redact` purges every disconnected or errored connection of the shop across all orgs (`app_purge_shop`, worker only), never an active one.
- 2026-10-08: Webhook bodies are never stored (payload is always `{}`); rows stored earlier were scrubbed by migration 0019.
- 2026-10-08: One active org per shop is a database invariant (unique index `store_connections_active_shop_uq`), replacing the check-then-act lookup; a race ends as `shop_in_use`.
- 2026-10-08: Phase 1b-3 is split into 1b-3a hardening, 1b-3b Shopify connector, 1b-3c live updates.
- 2026-10-09: Shopify data is fetched with paginated GraphQL queries through the existing page-job engine (no bulk operations yet); page sizes are small because Shopify rejects queries over 1000 points of requested cost.
- 2026-10-09: Customers and marketing fields (customer id, UTM, landing site) are left out until Shopify's protected customer data approval; they stay null.
- 2026-10-09: The first backfill starts automatically after connect, and owners and admins also get Sync now.
- 2026-10-09: `read_all_orders` is requested. The orders backfill reaches back 12 months when it was granted and 60 days otherwise, and the Connections page says so.
- 2026-10-09: The sync engine now records `last_synced_at` and recovers errored connections at the end of a chain, and `failRun` no longer touches disconnected or demo connections.
- 2026-10-09: A Shopify GraphQL `THROTTLED` response is waited out in place and the same query is retried (at most 5 times and 60 s of waiting per query) before the page is handed back to the queue, because re-running a page with many follow-up queries from its first query against an empty bucket could livelock.
- 2026-10-09: Shopify inventory always takes a full pass, incrementals included, until 1b-3c: the inventory item's `updated_at` does not move on quantity-only changes, so the filter left stock stale after Sync now. Inventory has no history window and the sink is idempotent.
- 2026-10-09: Failed privacy webhook events (`customers/data_request`, `customers/redact`, `shop/redact`) are retried by the sweep (migration 0021 extends `app_list_stale_webhook_events`) instead of staying terminal, because 1b-3b stores order data and an unerased `shop/redact` is a compliance risk. Chosen over re-labelling failed events as `received` so that `failed` stays truthful and a retry waits 10 minutes after the last attempt instead of racing BullMQ's own retries.
- 2026-10-08: Phase 1b-3b is merged locally into `phase0-foundations` (fast-forward, HEAD b3f0d4a). Phase 1b-3c, the CSV import and the manual and CSV cost paths are the remaining Phase 1b work before 1c and 1d.
- 2026-10-08: Phase 1b-3c (live updates) is specced (`docs/superpowers/specs/2026-10-08-phase1b3c-live-updates-design.md`) and planned (12 tasks, `docs/superpowers/plans/2026-10-08-phase1b3c-live-updates.md`), and runs on branch `phase1b3c-live-updates`. Decisions: scheduled polling plus webhook nudges; one one-minute ticker with a SECURITY DEFINER due query (migrations 0022 to 0026); tiered cadence (locations, products and orders every 15 minutes, inventory hourly, a daily full products pass); nudges only for non-customer topics (`products/update`, `inventory_levels/update`, plus `app/uninstalled`); expiring offline Shopify tokens (1 h access, 90 d refresh, rotated on every refresh) refreshed under a connection row lock; order-line link-up pass; per-resource sync status; alerts for failed webhooks.
- 2026-10-08: 1b-3c Task 1 is done (commit 072c321): the install requests expiring tokens and stores the access and refresh tokens with both expiry times (migration 0022). Do not deploy the branch before Task 3 (the token service), because the refresh token still reaches `fetchPage` until then. Work is paused until the owner frees disk space.
- 2026-10-10: Phase 1b-3c (live updates) is built on branch `phase1b3c-live-updates` (commits 072c321 to 21ed7fc, including docs and the final review fix wave); not merged or pushed. Task 3 (the token service) landed, so the earlier "do not deploy before Task 3" caveat no longer applies. Nothing ran against real Shopify, Redis or BullMQ.
- 2026-10-10: Scheduled polling plus webhook nudges: polling is the safety net, a webhook only starts a sync earlier.
- 2026-10-10: Tiered cadence: locations, products and orders every 15 minutes, inventory a full pass hourly, a products full pass daily.
- 2026-10-10: Only non-customer webhook topics (products/update, inventory_levels/update) are subscribed; orders stay polling-only until the protected customer data approval exists.
- 2026-10-10: Access tokens are expiring offline tokens, refreshed under a connection row lock (FOR NO KEY UPDATE, so child-table FOR KEY SHARE locks do not block it); the refresh token rotates on every refresh.
- 2026-10-10: store_connections.last_synced_at is the oldest resource time; per-resource times live on sync_cursors.
- 2026-10-10: The scheduler is one ticker plus a SECURITY DEFINER due query, not per-connection schedules or a next_due_at column.
- 2026-10-10: Webhook nudges are debounced in the database, not with queue job ids, because enqueueSync commits the run before it enqueues. The inventory nudge debounce is 10 minutes because its sync is a full pass.
- 2026-10-10: Failed non-privacy webhook events (app/uninstalled, products/update, inventory_levels/update) are retried 5 times by the sweep and then raise an alert (new alerts table); a reconnect retires pending uninstall events so a stale retry cannot disconnect a reinstalled shop.
- 2026-10-10: 1b-3c final review fix wave (e605802, 1923557, 21ed7fc): the link-up timezone and sibling-connection tests now fail on the regressions they guard; a failed credentials write during token refresh throws a generic `TransientError` with no cause so ciphertext never reaches stored error text; the Connections page marks a resource out of date at 1 h (locations, products, orders) or 4 h (inventory), about 4x the polling cadence, and these web thresholds are mirrored by hand from the cadence (no drift test yet).
- 2026-10-10: 1b-3c deferred, none blocking merge (details in docs/sync.md "Known gaps after 1b-3c"): the sweep retry counter can double count under overlapping sweeps; medium alerts never auto-clear and stack (group and auto-resolve in 1d); a single GraphQL 401 stops polling for that shop until Sync now or a reconnect (add to the first-install checklist); a huge `expires_in` can throw outside the try; a11y polish on the Connections list.
- 2026-10-17: The Windows dev machine has Node 24 and pnpm 11 but no Docker and no repo-root `.env`, so `pnpm dev` cannot run yet (needs `docker compose up -d`, `.env` from `.env.example` with a generated `ENCRYPTION_KEY`, and `supabase start` for sign-in; see docs/dev-setup.md). Only the test suites run here, through embedded Postgres. Next step for running the app locally is installing Docker Desktop.
- 2026-10-19: The repo is pushed to GitHub `workagentic/eRetailQuery`. Push protection rejected Shopify-token-shaped test fixtures, so history was rewritten once (fake `shpat_` fixture replaced by `shpat_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE`, 167 commits) before the first push. Pushes need the `workagentic` gh account active. `main` was created from `phase0-foundations` (which contains 1b-3c, fast-forward) and is the default branch.
- 2026-10-20: Demo dashboard (plan `docs/superpowers/plans/2026-10-20-demo-dashboard.md`, branch `demo-dashboard`): the owner needs a Vercel-hosted demo for the boss showing Shopify and Amazon profitability on one dashboard, with real screens fed by seed data and no Docker. Owner chose direct database reads from the web app (no API host) over hosting the API on Railway. Demo mode is `NEXT_PUBLIC_DEMO_MODE=1`: `loadAppContext` reads orgs from the database, Team and Connections are hidden. Reports live in `packages/db/src/reports/*` (so the move onto the API in Phase 1d is mechanical). Schema: `amazon` sales channel, per-order fee columns (`payment_fee_cents`, `marketplace_fee_cents`, `fulfillment_cost_cents`), `amazon_ads` ad platform, `ad_campaigns`, `ad_insights_daily` (migration 0027). The seed now plants a story (losing Meta campaign, winning Google campaign, underpriced bestseller, three SKUs about to run out, products that lose money on Amazon) and anchors 365 days to the day it runs, so reseed before a demo. Runbook: docs/demo.md.
- 2026-10-20: Demo report conventions: revenue is net sales; blended ROAS is net sales over ad spend; ad spend is attributed to a channel by platform (Amazon Ads to Amazon, the rest to Shopify); ad flags use the contribution margin of the channel the platform sells on; fulfillment cost is shown on the P&L shipping line; per-SKU profit ignores refunds; the attention feed groups low stock and Amazon losses into one item each and ranks by dollars at stake. Not yet verified: everything on hosted Supabase and Vercel (pooler username format, transaction-mode pooling with `set_config`, the Vercel monorepo build) and a browser check of the screens; docs/demo.md lists the checks.
- 2026-10-20: The demo is live on Vercel from `main`, with hosted Supabase (Data API off, automatic RLS on), migrations 0001 to 0027 applied, the demo org seeded and the demo owner created through the Supabase Auth Admin API (`pnpm db:demo`). Vercel's default Deployment Protection puts a Vercel login in front of the site; the owner must turn Vercel Authentication off for Production so the boss only sees the demo sign-in.
- 2026-10-20: Whole-branch review of the demo found five Important issues, all fixed test-first: report pages are 404 outside demo mode, the filter bar keeps the selected month, ads on a channel that loses money before ads are flagged losing (not judged by generic bands), per-batch or non-USD cost components no longer throw, and the attention feed follows the channel filter. Deferred minors: the ad break-even window follows the date preset while flags use a fixed 14 days; channel=all product fees are a blended assumption; the low-stock stake is lost revenue while other stakes are profit; per-SKU profit ignores refunds; costComplete covers only the current P&L period; the channel split drops ad spend on a channel with no orders; the empty state ignores ad spend; reorder points are ignored; the shared demo login is an owner who can change its password (re-run `pnpm db:demo` after demos).
- 2026-10-20: Redesign after the owner called the first screens basic: a dark sidebar app shell, a hero showing where every $100 of sales goes, charts on every screen (trend, channel, ads, waterfall, bar lists and segment bars), category artwork, then Pexels stock photos for products and ad campaigns (hotlinked, no attribution required, icon fallback). Chart colours (teal, blue, amber, violet) were checked with the dataviz palette validator; a series keeps its colour everywhere (Meta blue, Amazon amber). Light theme only.
- 2026-10-20: Git housekeeping: all feature branches and the two pre-rewrite backup branches were deleted; `main` is the only branch, locally and on GitHub. Push with the `workagentic` gh account (it must be the active one).
