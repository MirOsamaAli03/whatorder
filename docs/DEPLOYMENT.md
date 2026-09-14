# Deploying Restaurant OS

A single machine running the database, the cache, the API, the worker, the
dashboard and TLS termination. Enough for a pilot and for a good while after it:
a restaurant taking a few hundred orders a day does not need more, and one box
is something one person can hold in their head.

> **These images have not been built yet.** They were written on a machine
> without Docker, so the Dockerfiles and the compose file are reviewed and
> structurally checked but **not proven to build**. Expect to fix something on
> the first `docker compose build`. The parts most likely to bite are called out
> below under *If the first build fails*.

---

## What you need

- A small VPS — 2 vCPU and 4GB is comfortable; 2GB works
- Docker Engine with the Compose plugin
- Two DNS records pointing at it, e.g. `api.example.com` and
  `dashboard.example.com`
- Ports 80 and 443 reachable from the internet

Meta will not deliver a webhook to plain HTTP, to an IP address, or to a
self-signed certificate. Working TLS on a real domain is not optional — it is
the difference between receiving orders and not.

---

## First deployment

```bash
git clone https://github.com/MirOsamaAli03/whatorder.git
cd whatorder

cp .env.production.example .env.production
# Fill in every blank. Generate each secret with:
#   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"

docker compose \
  -f infrastructure/docker/docker-compose.prod.yml \
  --env-file .env.production \
  up -d --build
```

Startup order is enforced by the compose file rather than by hope: Postgres
becomes healthy, the one-shot `migrate` job applies every migration as the
schema owner, and only then do the API and worker start. An API booting against
a schema it does not recognise fails in ways that look like application bugs.

Check it:

```bash
curl https://api.example.com/health
docker compose -f infrastructure/docker/docker-compose.prod.yml logs -f api worker
```

### Creating the first restaurant

There is no sign-up and no platform back office yet (backlog B-5), so the first
organization is created from the machine:

```bash
docker compose -f infrastructure/docker/docker-compose.prod.yml \
  --env-file .env.production \
  run --rm -e DATABASE_URL_ADMIN="postgresql://restaurant_owner:PASSWORD@postgres:5432/restaurant_os?schema=public" \
  migrate npx tsx packages/database/prisma/seed.ts
```

That seeds the demo tenants. **For a real restaurant, edit the seed first** —
it creates accounts with a published password. Everything after this point
(menu, WhatsApp number, templates, staff, settings) is done by the restaurant in
the dashboard; see [WHATSAPP_ONBOARDING.md](./WHATSAPP_ONBOARDING.md).

---

## The three database roles

The application connects as a role that **cannot bypass Row-Level Security**,
and the API refuses to boot if that turns out not to be true. Keeping them
separate is what makes RLS a real second line of defence rather than decoration.

| Role | Used by | Can |
|---|---|---|
| `restaurant_owner` | migrations, seed | everything; owns the schema |
| `restaurant_app` | API, and the worker's tenant-scoped work | read and write, RLS enforced |
| `restaurant_worker` | the worker's cross-tenant queries | the outbox, orders, escalations, three scheduling columns of `notifications` — and nothing else |

The roles are created by `infrastructure/docker/init/*.sql` **when the database
volume is first initialised, and never again**. The passwords from
`.env.production` are applied by `03-production-passwords.sh` at that same
moment.

**Rotating a password later** therefore needs two steps — the environment file
*and* the database:

```bash
docker compose -f infrastructure/docker/docker-compose.prod.yml exec postgres \
  psql -U restaurant_owner -d restaurant_os \
  -c "ALTER ROLE restaurant_app PASSWORD 'the-new-one';"
# then update .env.production and: docker compose ... up -d api worker
```

---

## Updating

```bash
git pull
docker compose -f infrastructure/docker/docker-compose.prod.yml \
  --env-file .env.production up -d --build
```

Migrations run automatically as part of that. The API and worker are replaced;
in-flight requests are dropped, so do it outside service hours.

**Changing `API_ORIGIN` needs a rebuild, not a restart.** It is compiled into
the browser bundle during `next build` — a `NEXT_PUBLIC_*` value set as a
container environment variable does nothing, and the symptom is a dashboard that
loads and then cannot reach the API, with no server-side error to explain it.

---

## Backups

Not automated. The database is the only thing that cannot be rebuilt from the
repository, so this is the gap that would hurt most:

```bash
docker compose -f infrastructure/docker/docker-compose.prod.yml exec -T postgres \
  pg_dump -U restaurant_owner restaurant_os | gzip > "backup-$(date +%F).sql.gz"
```

Put that on a cron and copy it off the machine. A backup on the same disk is not
a backup.

---

## If the first build fails

The likeliest causes, in order:

**Prisma cannot find its query engine.** The images use `node:22-slim` rather
than Alpine for exactly this reason, and install `openssl`. If it still
complains, the engine for the container's platform was not downloaded during
`npm ci` — add the target to `generator client` in `schema.prisma`:
`binaryTargets = ["native", "debian-openssl-3.0.x"]`.

**`npm ci` fails on a workspace it cannot find.** Every workspace's
`package.json` must be copied before `npm ci` runs; if a package is added later,
add its `COPY` line to both Dockerfiles.

**The dashboard starts and immediately exits with MODULE_NOT_FOUND.** Standalone
output only includes files traced as reachable from `outputFileTracingRoot`. It
is set to the repository root in `next.config.mjs` — if that is changed, shared
packages silently stop being included.

**Caddy cannot get a certificate.** Both domains must already resolve to the
machine and ports 80 and 443 must be open before it starts. Check
`docker compose logs caddy`.

**The image is large (roughly 1GB).** Deliberate: the runtime stage keeps
development dependencies because the Prisma CLI has to be present for
`migrate deploy`, and a migration job that cannot reach the CLI is a deployment
that cannot start. Splitting them is worth doing, and is not worth doing before
a pilot.

---

## What is not here

- **No horizontal scaling.** One API container. The application supports more —
  the realtime layer fans out through Redis precisely so that it can — but the
  compose file does not set it up.
- **No log aggregation.** Logs are structured JSON on stdout, ready for a
  collector that does not exist yet.
- **No metrics or alerting.** `/health` and `/ready` exist; nothing watches them.
- **No CI/CD.** `.github/workflows/ci.yml` tests but does not deploy.
- **No staging environment.**

For a one-restaurant pilot none of these block go-live. All of them matter
before a tenth restaurant.
