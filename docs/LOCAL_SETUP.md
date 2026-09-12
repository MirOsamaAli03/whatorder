# Local setup

## Prerequisites

- **Node.js 20.11+** (developed against Node 24)
- **npm 10+** (ships with Node)
- **PostgreSQL 16** and **Redis 7** — see options below

## Why npm and not pnpm

The monorepo uses npm workspaces. pnpm was the first choice, but it links
workspace packages with real symlinks, which Windows refuses to create without
Developer Mode or an elevated shell. npm links them as directory junctions,
which need no elevation, so npm works on every machine without a system change.

If you prefer pnpm, enable **Settings > System > For developers > Developer
Mode** on Windows first.

## Install

```bash
npm install
```

## Database and Redis

You need PostgreSQL 16 and Redis 7 on `127.0.0.1:5432` and `127.0.0.1:6379`.

### Option A — Docker (Linux, macOS, or Windows with Docker Desktop)

```bash
docker compose -f infrastructure/docker/docker-compose.yml up -d
```

The compose file also runs `infrastructure/docker/init/01-app-role.sql`, which
creates the least-privilege application role.

### Option B — WSL2 (Windows without Docker)

See `docs/WSL_SETUP.md`. Services run inside the Ubuntu distribution and are
reachable from Windows on `127.0.0.1` through WSL2's localhost forwarding.

## Configure

```bash
cp .env.example .env
```

Then generate real secrets:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

## Two database roles, on purpose

`.env` holds two connection strings and they are not interchangeable:

| Variable | Role | Used by | RLS |
|---|---|---|---|
| `DATABASE_URL` | `restaurant_app` | the running API | **enforced** |
| `DATABASE_URL_ADMIN` | `restaurant_owner` | migrations, seed | bypassed (owner) |

Row-Level Security only protects anything if the runtime connection cannot
bypass it. Table owners and superusers are exempt from RLS policies, so the API
connects as a separate non-owner role without `BYPASSRLS`. The API refuses to
start if `DATABASE_URL` points at a role that can bypass RLS — that check is in
`assertLeastPrivilegeConnection`, and it exists because a misconfiguration here
would silently disable tenant isolation with no error anywhere.

## Migrate and seed

```bash
npm run db:deploy   # apply migrations
npm run db:seed     # demo tenants: a multi-branch chain and a home kitchen
```

## Run

```bash
npm run dev          # everything
npm run dev -w @restaurant-os/api
```

- API: http://localhost:3001
- Health: http://localhost:3001/health, http://localhost:3001/ready

## Verify

```bash
npm run typecheck
npm run lint
npm run test
```
