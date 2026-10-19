# Demo on Vercel and hosted Supabase

A password-protected demo of the profit dashboard for a seeded business selling on Shopify and Amazon. No Docker, no API host, no Redis and no worker: the Next.js app reads the hosted Supabase Postgres directly (`NEXT_PUBLIC_DEMO_MODE=1`). The screens are the real screens; only the data is simulated. When the NestJS API is deployed (Phase 1d) the pages move onto it; every query lives in `packages/db/src/reports/` to keep that move mechanical.

What the boss sees: Dashboard (revenue, orders, ad spend, blended ROAS, money left after ads, "what needs your attention", trend, Shopify vs Amazon), Products, Ads, Inventory and Profit and loss.

## What the seed plants

| Story | Where it shows |
|---|---|
| Meta - Prospecting Broad loses money, several hundred dollars a week | Dashboard feed, Ads |
| Google - Shopping Bestsellers wins | Ads |
| Amazon - Sponsored Brands loses money | Dashboard feed, Ads |
| Merino Base Layer (DEMO-1-1) is a bestseller priced below the healthy range | Dashboard feed, Products |
| Three products about to run out (DEMO-2-1, DEMO-3-1, DEMO-4-1) | Dashboard feed, Inventory |
| About ten products lose money on every Amazon sale (fees take more than the markup) | Dashboard feed, Products with the Amazon filter |

The data covers the 365 days ending yesterday (UTC) on the day you seed. **Reseed shortly before a demo** so "last 30 days" is current.

## One-time setup

You need a Supabase account and a Vercel account. Nothing here needs Docker.

### 1. Supabase project

1. Create a project (any region near your users). Save the database password.
2. Under Authentication, Providers, Email: keep "Confirm email" on, and turn "Allow new users to sign up" **off**. Only the provisioned demo user can then sign in.
3. Under Project Settings, API: copy the Project URL, the `anon` key and the `service_role` key. The `service_role` key is a secret: it stays on your machine and is never added to Vercel.
4. Under Project Settings, Database, Connection string, copy two URLs. Replace the placeholder password:
   - **Session pooler** (port 5432, user `postgres.<project-ref>`): used from your machine for migrations and the seed. Do not use the direct host: it is IPv6-only and fails on many networks.
   - **Transaction pooler** (port 6543): used by the Vercel app. The user will be `app_user.<project-ref>` (the pooler needs `<role>.<project-ref>`).

### 2. Load the database (from your machine)

Put these in the repo-root `.env` (never commit it):

```
DATABASE_OWNER_URL=<session pooler URL, user postgres.<project-ref>>
APP_USER_PASSWORD=<a new strong password for the app_user database role>
SUPABASE_URL=<Project URL>
SUPABASE_SERVICE_ROLE_KEY=<service_role key>
DEMO_LOGIN_EMAIL=<the email you will give your boss>
DEMO_LOGIN_PASSWORD=<at least 12 characters>
```

Then:

```
pnpm install
pnpm db:migrate      # creates tables, row level security and the app_user role
pnpm db:seed         # creates the demo business (deletes and recreates only the demo org)
pnpm db:demo         # creates the demo login in Supabase Auth
```

`pnpm db:demo` creates the auth user with the seeded demo owner's id, so no extra membership step is needed. Running it again updates the email and password.

### 3. Vercel project

1. Import the GitHub repo `workagentic/eRetailQuery` and choose the `main` branch as the production branch (or `demo-dashboard` until it is merged).
2. Settings, General, Root Directory: `apps/web`. Turn on **Include source files outside of the Root Directory**.
3. Framework preset: Next.js. Node.js version: 22 or newer.
4. Install Command: `pnpm install --frozen-lockfile`. Build Command: `cd ../.. && pnpm turbo run build --filter=@erq/web...`. Output Directory stays the default.
5. Environment Variables (Production and Preview):

| Name | Value |
|---|---|
| `NEXT_PUBLIC_DEMO_MODE` | `1` |
| `NEXT_PUBLIC_SUPABASE_URL` | Project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | the `anon` key |
| `DATABASE_URL` | transaction pooler URL for `app_user.<project-ref>` with `APP_USER_PASSWORD`, for example `postgresql://app_user.<ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres` |

   Do not add `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_OWNER_URL` or any other secret. The app never needs them.
6. Deploy. Then in Supabase, Authentication, URL Configuration: set the Site URL to the Vercel production URL and add it to the redirect URLs.

## Before every demo

1. `pnpm db:seed` (refreshes the 365 days to end yesterday). It is safe to repeat.
2. Open the Vercel URL in a private window, sign in as the demo user, and click through Dashboard, Products, Ads, Inventory and Profit and loss on a laptop and on a phone-width window.
3. Check that the Dashboard feed lists the planted stories above and that the "Demo data" banner shows.

## Checks to run once on the live site

- A second account that exists in Supabase but belongs to no business sees the "No demo access" page.
- `/products/export` downloads a CSV when signed in and returns 401 when not.
- Pages answer in a few seconds (the pool is one connection per instance by design).

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| "Tenant or user not found" from the pooler | The username must be `app_user.<project-ref>` on the pooler. |
| Sign-in works but you land on "No demo access" | The auth user's id is not the seeded demo owner. Run `pnpm db:demo` again. |
| Pages show no data | The seed has not run against this database, or `DATABASE_URL` points at a different project. |
| `getaddrinfo ENOTFOUND` or timeouts when migrating | You used the direct (IPv6) host; use the session pooler URL. |
| Build fails on `@erq/db` | The Build Command must run through Turborepo so the workspace packages build first. |

## Security notes

- Row level security is on for every table and the app connects as `app_user`, which cannot bypass it. The Data API is not used; migration `0006` removes the default `anon` and `authenticated` grants.
- Cost data, margins and order data are visible to anyone who can sign in. Give the login only to people who should see it, and change or delete the demo user afterwards.
- The demo uses simulated data only. Do not connect real stores to this database.
