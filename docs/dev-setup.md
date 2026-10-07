# Developer setup

## Prerequisites

- Node 22 or newer (`.nvmrc` pins 22; Node 24 is what Phase 0 was developed on).
- pnpm via corepack (`corepack enable`). The exact version is pinned in `packageManager`.
- Docker Desktop (Postgres and Redis via compose, Testcontainers, Supabase CLI stack).
- Supabase CLI (only needed for auth and the e2e run).

## First run

```bash
cp .env.example .env
# put the output of this into ENCRYPTION_KEY
openssl rand -base64 32
docker compose up -d      # Postgres 16 on 54329, Redis on 6379
pnpm install
pnpm db:migrate
pnpm db:seed
pnpm dev
```

A single repo-root `.env` is the only env file. `apps/api` and `apps/worker` load it with dotenv (path resolved to the repo root); `apps/web` loads it in `next.config.ts` through `@next/env`.

## Root scripts

| Script           | What it does                                                        |
| ---------------- | ------------------------------------------------------------------- |
| `pnpm dev`       | Run web, api and worker                                             |
| `pnpm db:migrate`| Apply Drizzle migrations (as `erq_owner`, via `DATABASE_OWNER_URL`) |
| `pnpm db:seed`   | Load the demo org                                                   |
| `pnpm test`      | Unit and integration tests                                          |
| `pnpm test:e2e`  | Playwright e2e                                                      |
| `pnpm lint`      | eslint and prettier check                                           |
| `pnpm typecheck` | Type check every package                                            |

## Running tests

Database tests use Testcontainers when Docker is reachable, otherwise they fall back automatically to `embedded-postgres`. Force a mode with `ERQ_TEST_DB=docker|embedded|auto` (default `auto`).

Other packages load `@erq/db/testing` from `dist`, so run `pnpm turbo run build --filter=@erq/db` before running another package's tests directly (turbo runs it for you through `dependsOn`).

Embedded Postgres cleanup: in embedded mode the helper stops the server and removes its `erq-pg-*` temp directory on stop, process exit and SIGINT/SIGTERM. On Windows it records the postmaster's exact creation time after start and only kills a pid whose current creation time equals it, killing the postmaster first and its children after, so no orphan `postgres.exe` survives. The POSIX paths are unverified until CI. After a crashed run, check `Get-Process postgres` and delete leftover `erq-pg-*` folders.

Not yet verified: the Redis/BullMQ system-worker test and the Playwright e2e both need Docker, and neither has been run in the original dev environment (no Docker or Supabase there). Treat the first CI run as their first real execution.

Low disk: each package's tests start their own Postgres, so run them serially with `pnpm turbo run test --concurrency=1`. Parallel runs can hit ENOSPC on small disks. Leftover `erq-pg-*` folders in the OS temp directory can be deleted.

## Running the e2e (needs Docker)

1. `docker compose up -d`
2. `supabase start` (API on 54321, DB 54322, Studio 54323, Inbucket 54324). After editing `supabase/config.toml`, run `supabase stop && supabase start`.
3. Wire `.env` (see checklist below), then `pnpm db:migrate`, so the API has its schema before it starts.
4. `pnpm --filter @erq/web exec playwright install chromium`
5. `pnpm build` (Playwright starts the api and web dev servers without turbo, so workspace packages' `dist/` must already exist)
6. `pnpm test:e2e`

### Env wiring checklist

Web:

- `NEXT_PUBLIC_SUPABASE_URL` = `API_URL` from `supabase status` (normally `http://127.0.0.1:54321`).
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` = `ANON_KEY` from `supabase status`.
- `API_URL=http://localhost:4000`.

API:

- `DATABASE_URL` = the compose Postgres `app_user` URL on port **54329**. Not Supabase's 54322: the app tables and the `app_user` role live in the compose database.
- `SUPABASE_JWT_ISSUER` = `http://127.0.0.1:54321/auth/v1`.
- Set exactly one of `SUPABASE_JWKS_URL` or `SUPABASE_JWT_SECRET`. Check `http://127.0.0.1:54321/auth/v1/.well-known/jwks.json`: if it returns keys use the JWKS URL, otherwise use `JWT_SECRET` from `supabase status`. Clear the one you do not use.
- `WEB_PUBLIC_URL=http://localhost:3000` (CORS origin and invite links).

Ports: Supabase uses 54321 to 54324; compose uses 54329 (Postgres) and 6379 (Redis); API 4000; web 3000.

## Demo data

`pnpm db:seed` is deterministic and re-runnable (it deletes and recreates the demo org).

- Org id (`DEMO_ORG_ID`): `00000000-0000-4000-8000-000000000001` (name "Demo Outfitters", slug `demo`)
- Owner user: `00000000-0000-4000-8000-0000000000a1`
- Analyst user: `00000000-0000-4000-8000-0000000000a2`
- Viewer user: `00000000-0000-4000-8000-0000000000a3`

These user ids are not Supabase auth users; they exist as `org_members.user_id` values for development and tests.

## Production checklist

- Supabase email confirmation MUST be enabled. Invite acceptance trusts the JWT `email` claim, so an unconfirmed address would let someone claim an invite sent to another person (see [tenancy](architecture/tenancy.md), SECURITY DEFINER functions).
- Keep anonymous sign-ins off. The API also rejects tokens with `is_anonymous: true`.
- If this database lives in a Supabase project, keep migration `0006_security_hardening.sql` and do not grant `anon` or `authenticated` anything in `public` (or disable the Data API for `public`). Supabase grants them privileges by default, and the migration revokes them.
