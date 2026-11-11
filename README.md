# Legislative Analysis

Software for state legislative offices. Two halves share one sign-in and one database:

- **Bills.** Where every bill stands, what is on the calendar, how members voted, which bills are related, and what changed between versions of the text. An office tracks bills with a position, a priority and an owner, and is alerted when a tracked bill moves.
- **Constituent Center.** Reads the office's mailboxes (Gmail, Outlook or any IMAP mailbox), sorts each letter by kind, issue, bill and the writer's position, places the writer inside or outside the district, groups form letters, opens casework, and drafts replies that staff approve and send.

Multi-tenant: each office sees only its own records, enforced in PostgreSQL by row-level security. Legislative data comes from LegiScan or Open States, and for Connecticut straight from the General Assembly's own files.

## Run the demo (no credentials)

Requires Node 22 or later.

```bash
npm install
```

Create `.env.demo` (git-ignored) with generated secrets:

```bash
printf "APP_ENV=demo\nAPP_URL=http://localhost:3100\nDATABASE_URL=pglite://.data/demo\nSESSION_SECRET=$(openssl rand -hex 32)\nTOKEN_ENCRYPTION_KEY=$(openssl rand -base64 32)\nWORKER_MODE=inline\n" > .env.demo
```

```bash
npm run demo:seed
```

```bash
npm run demo
```

Open http://localhost:3100 and sign in as `demo.owner@example.org`. The seed prints each demo account and its password. The demo office, its staff and its mail are fictional, in a jurisdiction called "Demo State"; a second office is built from Connecticut's public legislative record. To reseed, stop the server, delete `.data/demo` and run `demo:seed` again. The embedded database is single-process, so only one server can use it at a time.

## Development

Copy `.env.example` to `.env.local` and fill in `SESSION_SECRET` and `TOKEN_ENCRYPTION_KEY`; add `LEGISCAN_API_KEY` to load a state's bills. `DATABASE_URL=pglite://.data/pglite` runs an embedded PostgreSQL (PGlite) with pgvector, so no database server is needed, and with `WORKER_MODE=inline` the background worker runs inside the dev server.

Create an office and its first sign-in:

```bash
OWNER_PASSWORD='a long passphrase' npm run office:create -- --name "Office of Rep. Example" --slug rep-example --state GA --owner-email you@example.org --owner-name "Your Name"
```

| Command | What it does |
|---|---|
| `npm run dev` | Next.js dev server (migrations apply automatically on the embedded database) |
| `npm test` / `npm run test:watch` | Unit, integration and evaluation tests on an in-memory PostgreSQL, with no network |
| `npm run typecheck` / `npm run lint` | TypeScript and ESLint |
| `npm run build` / `npm start` | Production build and server |
| `npm run db:generate` | Generate a migration after editing `src/server/db/schema` |
| `npm run db:migrate` | Apply migrations |
| `npm run worker` | Background worker (BullMQ if `REDIS_URL` is set, otherwise a PostgreSQL queue) |
| `npm run office:create -- …` | Create an office and its owner. Add `--temporary-password` when setting it up for someone else, so they choose their own at first sign-in |
| `npm run center:enable -- --slug rep-x` | Turn on the Constituent Center for an office (this makes two-step sign-in mandatory for it) |
| `npm run center:import-rules -- --slug rep-x --file rules.txt` | Load a list of senders to file or set aside |
| `npm run legislation:check -- --state GA` | Read-only LegiScan check: sessions, bill count, three sample bills, queries used |
| `npm run legislation:sync -- --state GA` | Sync a state's current sessions from LegiScan |
| `npm run microsoft:register` | Register the app with Microsoft for Outlook sign-in (needs the Azure CLI) |
| `npm run private` | macOS: keep one private copy of the app, with its own database, in `~/ConstituentCenter` |
| `npm run schema:doc` | Write `DATABASE_SCHEMA.md` from the migrations |
| `npm run openapi` | Regenerate `docs/openapi.json` |

Three scripts have no alias: `npx tsx scripts/eval.ts` scores mail classification against the labelled letters in `tests/eval`, `scripts/ct-snapshot.ts` rebuilds the Connecticut snapshot, and `scripts/smoke-routes.ts` loads every page as a given member.

## Production

PostgreSQL 16 or later with the `vector` extension, HTTPS, and optionally Redis 7. Set `APP_ENV=production`, `APP_URL`, `DATABASE_URL=postgres://…` and the two secrets; `.env.example` lists the rest.

The `Dockerfile` builds one image for the web server, the worker and migrations. On start it applies migrations and then serves. Give it `MIGRATION_DATABASE_URL` for a login that owns the tables and `DATABASE_URL` for a login that cannot change the schema, and the server never holds schema rights.

`docker-compose.yml` runs the same layout locally with PostgreSQL and Redis. It reads `.env.docker`:

```
APP_ENV=development
APP_URL=http://localhost:3000
DATABASE_URL=postgres://li:li_dev_password@db:5432/legislative_intelligence
REDIS_URL=redis://redis:6379
SESSION_SECRET=<openssl rand -hex 32>
TOKEN_ENCRYPTION_KEY=<openssl rand -base64 32>
```

## Layout

```
src/app/            routes: (auth) sign-in, two-step and account; (app) bills; (center) Constituent Center;
                    (public) privacy; api/ search, exports, health, mailbox sign-in and provider webhooks
src/components/     shell, UI primitives, bill pieces, chamber and comparison views, Constituent Center controls
src/lib/            small helpers shared by the server and the browser
src/server/         env, db (schema, row-level-security access), auth, authz, services, jobs, search
  legislation/      providers, sync, stages, related bills, text comparison
  email/            Gmail, Outlook and IMAP providers, sync, sending, sender trust
  classification/   rules, bill matching, positions, form letters; ai/ is the optional model reader
  district/         address parsing and district lookup
tests/              unit, integration and eval (labelled letters), with shared helpers
scripts/            the command-line entry points above
drizzle/            SQL migrations (0001 is the hand-written row-level security and roles)
data/connecticut/   a snapshot of Connecticut's 2026 session, for development
```
