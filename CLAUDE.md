# @1moby/just-auth

Lightweight, zero-runtime-dep, edge-native auth library for React. Web Crypto API for OAuth + PKCE. Raw SQL for D1/SQLite/Postgres/MySQL/ClickHouse. NextAuth-compatible React API.

## Project Structure

See [docs/structure.md](docs/structure.md) for the file-by-file breakdown.

```
src/
├── index.ts              # createReactAuth() factory + all re-exports
├── types.ts              # All TypeScript interfaces + AuthConfig
├── core/                 # session, cookie, password (PBKDF2), oauth, rbac
├── providers/            # github, google (PKCE), line (PKCE)
├── db/                   # queries (with table prefix), migrate (non-destructive)
├── server/               # auth helper + route handlers (HTML redirects, header tuples, signIn/session callbacks)
├── client/               # SessionProvider, useSession, signIn/signUp/signOut, usePermission/useRole
├── middleware/           # createAuthMiddleware (route-level permission gating)
└── adapters/
    ├── d1.ts             # Cloudflare D1
    ├── bun-sqlite.ts     # bun:sqlite
    ├── pg.ts             # node-postgres
    ├── mysql.ts          # mysql2
    ├── bun-sql.ts        # Bun.sql (Postgres / MySQL)
    └── clickhouse/       # ClickHouse adapter + RBAC graph + approval flow
        ├── index.ts      # createClickhouseAdapter() factory
        ├── adapter-core.ts   # DatabaseAdapter ?-style → CH named-params + auto-FINAL
        ├── sql-translator.ts # SQL parser/rewriter
        ├── ddl.ts        # cluster-aware CREATE TABLE / DICTIONARY builders
        ├── migrate.ts    # idempotent DDL runner
        ├── rbac.ts       # org/dept/supervisor graph + resolvePermission
        ├── approvals.ts  # open / decide / delegate / expire state machine
        ├── cycle-detect.ts   # cycle-safe traversal helpers
        ├── util.ts       # uuid + chDate (canonical CH DateTime64 formatter)
        └── types.ts      # CHClient, Organization, Department, etc.
```

## Package Exports

- `@1moby/just-auth` (`.`) — `createReactAuth`, providers, `migrate`, `createQueries`, `resolveTableNames`, session/cookie utils, `hashPassword`, `verifyPassword`, `resolvePermissions`, all types
- `@1moby/just-auth/client` — `SessionProvider`, `useSession`, `signIn`, `signUp`, `signOut`, `usePermission`, `useRole`
- `@1moby/just-auth/server` — server-side auth helpers
- `@1moby/just-auth/middleware` — `createAuthMiddleware` for route permission gating
- `@1moby/just-auth/adapters/d1` — Cloudflare D1
- `@1moby/just-auth/adapters/bun-sqlite` — bun:sqlite
- `@1moby/just-auth/adapters/pg` — node-postgres
- `@1moby/just-auth/adapters/mysql` — mysql2
- `@1moby/just-auth/adapters/bun-sql` — Bun.sql (Postgres / MySQL)
- `@1moby/just-auth/adapters/clickhouse` — ClickHouse adapter + `rbac` (org graph) + `approvals` (state machine)

## Build & Publish

- `bun run build` — compiles `src/` → `dist/` (ESM `.js` + `.d.ts` via tsc)
- `npm publish --access public` — publish to npm (`prepublishOnly` runs build)
- **Versioning:** bump in `package.json` before each publish. Patch (`0.4.1` → `0.4.2`) for fixes/docs; minor (`0.3.0` → `0.4.0`) for additive features.
- `prepare` script auto-builds on `bun install` from git source
- Dual output: consumers can import from `dist/` (compiled) or `src/` (raw `.ts` for Bun/bundlers)

## Schemas

**Core (SQL adapters):** 3 tables — `users` (with optional `password_hash` and `role`), `accounts`, `sessions`. Session tokens stored as SHA-256 hashes. Sliding window: 30-day sessions, extend at 15 days remaining. Passwords hashed with PBKDF2-SHA256 (600k iterations). Schema uses portable types (`VARCHAR(255)`, `BIGINT`, `TEXT`) for cross-engine compatibility. Optional RBAC: `role VARCHAR(50)` column + permissions defined in code config (multi-role via comma-separated, role inheritance, deny rules). Table prefix support: `tablePrefix: "myapp_"`.

**ClickHouse adapter:** 9 `ReplacingMergeTree` tables + 1 append-only `MergeTree` (`approval_decisions`) + 1 `Dictionary` (`sessions_dict`). Tables: `users`, `accounts`, `sessions`, `verification_tokens`, `organizations`, `departments`, `roles`, `user_role_grants`, `approval_requests`, `approval_decisions`. Hot reads use `FINAL`. Tombstones via `_deleted` column. UPDATE = read-then-merge; DELETE = `_deleted=1` row. Cluster mode wraps engines in `Replicated*` and adds `ON CLUSTER`. Verified against CH 24.8 / 25.3 / 25.10.

## Auth Routes (default basePath: /api/auth)

- `GET /login/:provider` — HTML redirect to OAuth provider (sets state + PKCE cookies)
- `GET /callback/:provider` — handle OAuth callback; runs `signIn` callback (if set) before any DB write; creates session
- `POST /register` — register with email/password (requires `credentials: true`)
- `POST /callback/credentials` — login with email/password (requires `credentials: true`)
- `GET /session` — return current session JSON (`user`, `session.expiresAt`, `accounts`, `permissions?`); return value can be customized via the `session` callback
- `POST /role` — set user role (requires `rbac` config + `user:set-role` permission)
- `POST /logout` — invalidate session, return `{ ok: true }` with cleared cookie

Notes: login/callback use HTML redirects (200 + meta refresh) instead of 302 to survive reverse proxies (nginx, k8s, ALB). `Set-Cookie` headers use `[string, string][]` tuples to prevent comma-merging in frameworks like Next.js.

## Lifecycle Callbacks (since 0.2.0)

- `callbacks.signIn(ctx)` — fires after OAuth profile retrieval, before user/account/session writes. Return `{ allow: false, reason }` to abort (redirects to `pages.error ?? "/"` with `?error=REASON`); `{ allow: true, userOverrides }` injects extra columns into the `users` INSERT (validated against `/^[a-zA-Z_][a-zA-Z0-9_]*$/`; `id`/`email`/`name`/`avatar_url` are reserved). `ctx.emailLinked` is true when sign-in just auto-linked an OAuth account by email.
- `callbacks.session(ctx)` — fires on `GET /api/auth/session`. Whatever you return becomes the response body verbatim (default shape is bypassed).

## Email-based Account Linking (since 0.3.0)

`AuthConfig.allowEmailAccountLinking: true` lets OAuth sign-in link a new provider account to an existing user when emails match. Default: false → returns `OAuthAccountNotLinked`. Older flag `allowDangerousEmailAccountLinking` is a deprecated alias.

## ClickHouse Extras (since 0.4.0)

`createClickhouseAdapter({ client })` returns the standard `DatabaseAdapter` plus three extras:
- `adapter.migrate()` — idempotent DDL setup
- `adapter.rbac` — multi-org / department / supervisor graph; `resolvePermission` resolves with `via: 'role' | 'inherited' | 'supervisor' | 'home_org' | 'superadmin'`
- `adapter.approvals` — `open / decide / delegate / expire` state machine with chain-frozen-at-open-time

Trade-offs documented in README "ClickHouse adapter (experimental)" section: FINAL cost, dictionary staleness window (≤15s on revoke), email-uniqueness residual race, sequential cascade-delete, no multi-table transactions.

## Sample App (sample-auth/)

- `worker.ts` — Cloudflare Worker with D1 adapter
- `wrangler.jsonc` — D1 binding, Assets with SPA mode, `run_worker_first: ["/api/*"]`
- `build.ts` — `Bun.build()` with content-hashed filenames and React aliasing
- Env vars: `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `LINE_CLIENT_ID`, `LINE_CLIENT_SECRET`, `BASE_URL`
- Deploy: `cd sample-auth && bun run build.ts && bunx wrangler deploy`

## ClickHouse Example (examples/clickhouse/)

- `docker-compose.yml` — runs CH 24.8, 25.3, 25.10 side-by-side on ports 8124/8125/8126
- `server.ts` — `createReactAuth` wired to `createClickhouseAdapter` with logging
- Env vars: `CH_URL`, `CH_USER`, `CH_PASSWORD`, `CH_DATABASE`, `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`

## Dependencies

- Zero production dependencies
- `react` >=18 (peer)
- `@clickhouse/client` >=1.0.0 (optional peer; only required when using the CH adapter)

---

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile.
- `Bun.$\`ls\`` instead of execa.

## Testing

- Unit: `bun test` — 331 tests across 20 files. Mock CH client at `tests/adapters/clickhouse/helpers/mock-ch.ts` simulates `ReplacingMergeTree FINAL` + `dictGet` for the spec scenarios.
- Integration (ClickHouse): `docker compose -f examples/clickhouse/docker-compose.yml up -d && bun tests/integration/clickhouse/run.ts`. Sweeps 13 scenarios across CH 24.8 / 25.3 / 25.10 and prints a per-version pass/fail summary.

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.
