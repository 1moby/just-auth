# @1moby/just-auth

Lightweight, zero-dependency, edge-native auth library for React. Uses Web Crypto API for OAuth + PKCE, raw SQL for D1/SQLite/Postgres/MySQL, NextAuth-compatible React API.

## Project Structure

See [docs/structure.md](docs/structure.md) for detailed file-by-file breakdown.

```
src/
├── index.ts              # createReactAuth() factory + all re-exports
├── types.ts              # All TypeScript interfaces
├── core/                 # session, cookie, password (PBKDF2), oauth, rbac
├── providers/            # github, google (PKCE), line (PKCE)
├── db/                   # queries (with table prefix), migrate (non-destructive)
├── server/               # auth helper, route handlers (HTML redirects, header tuples)
├── client/               # SessionProvider, useSession, signIn/signUp/signOut, usePermission/useRole
├── middleware/            # createAuthMiddleware (route-level permission gating)
└── adapters/             # d1, bun-sqlite, pg, mysql, bun-sql
```

## Package Exports

- `@1moby/just-auth` (`.`) — `createReactAuth`, providers, `migrate`, `createQueries`, `resolveTableNames`, session/cookie utils, `hashPassword`, `verifyPassword`, `resolvePermissions`, all types
- `@1moby/just-auth/client` (`./client`) — `SessionProvider`, `useSession`, `signIn`, `signUp`, `signOut`, `usePermission`, `useRole`
- `@1moby/just-auth/server` (`./server`) — Server-side auth helpers
- `@1moby/just-auth/middleware` (`./middleware`) — `createAuthMiddleware` for route permission gating
- `@1moby/just-auth/adapters/d1` — Cloudflare D1 adapter
- `@1moby/just-auth/adapters/bun-sqlite` — bun:sqlite adapter
- `@1moby/just-auth/adapters/pg` — node-postgres (pg) adapter
- `@1moby/just-auth/adapters/mysql` — mysql2 adapter
- `@1moby/just-auth/adapters/bun-sql` — Bun.sql adapter (Postgres/MySQL)

## Build & Publish

- `bun run build` — Compiles `src/` to `dist/` (ESM .js + .d.ts via tsc)
- `npm publish --access public` — Publish to npm (runs build via prepublishOnly)
- `prepare` script auto-builds on `bun install` from git source
- Dual output: consumers can import from `dist/` (compiled) or `src/` (raw .ts for Bun/bundlers)

## Database

3 tables: `users` (with optional `password_hash` and `role`), `accounts`, `sessions`. DatabaseAdapter interface: `prepare().bind().run()/first()/all()`. Schema uses portable types (`VARCHAR(255)`, `BIGINT`, `TEXT`) for SQLite/Postgres/MySQL compatibility. Session tokens stored as SHA-256 hashes. Sliding window: 30-day sessions, extend at 15 days remaining. Passwords hashed with PBKDF2-SHA256 (600k iterations, Web Crypto API). Optional RBAC: `role VARCHAR(50) DEFAULT 'user'` column, permissions defined in code config. Multi-role via comma-separated string (`"user,editor"`), role inheritance (`inherits`), deny rules (deny wins). Table prefix support: `tablePrefix: "myapp_"`. See [docs/full-rbac.md](docs/full-rbac.md) for design.

## Auth Routes (default basePath: /api/auth)

- `GET /api/auth/login/:provider` — HTML redirect to OAuth provider (sets state + PKCE cookies)
- `GET /api/auth/callback/:provider` — Handle OAuth callback, create session (HTML redirect with cookies)
- `POST /api/auth/register` — Register with email/password (requires `credentials: true`)
- `POST /api/auth/callback/credentials` — Login with email/password (requires `credentials: true`)
- `GET /api/auth/session` — Return current session JSON with linked accounts and permissions
- `POST /api/auth/role` — Set user role (requires `rbac` config + `user:set-role` permission)
- `POST /api/auth/logout` — Invalidate session, return `{ ok: true }` with cleared cookie

Note: Login/callback use HTML redirects (200 + meta refresh) instead of 302 to survive reverse proxies (nginx, k8s, ALB). Same pattern as Auth.js/NextAuth. Set-Cookie headers use `[string, string][]` tuples to prevent comma-merging in frameworks like Next.js.

## Sample App (sample-auth/)

- `worker.ts` — Cloudflare Worker with D1 adapter
- `wrangler.jsonc` — D1 binding, Assets with SPA mode, `run_worker_first: ["/api/*"]`
- `build.ts` — `Bun.build()` with content-hashed filenames and React aliasing
- Env vars: `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `LINE_CLIENT_ID`, `LINE_CLIENT_SECRET`, `BASE_URL`
- Deploy: `cd sample-auth && bun run build.ts && bunx wrangler deploy`

## Dependencies

- Zero production dependencies
- `react` >=18 (peer)

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
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests. 169 tests across 11 files.

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.
