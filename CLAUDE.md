# @1moby/just-auth

Lightweight, zero-dependency, edge-native auth library for React. Uses Web Crypto API for OAuth + PKCE, raw SQL for D1/SQLite, NextAuth-compatible React API.

## Project Structure

- `src/index.ts` — `createReactAuth()` factory, re-exports all public API
- `src/types.ts` — All TypeScript interfaces (User, Session, Account, DatabaseAdapter, AuthConfig, etc.)
- `src/core/session.ts` — `generateSessionToken()`, `hashToken()` (async SHA-256 via Web Crypto), `createSessionManager()`, `encodeBase64url()`, `encodeHex()`
- `src/core/cookie.ts` — Cookie serialization/parsing, state cookies, PKCE cookies
- `src/core/password.ts` — PBKDF2-SHA256 password hashing via Web Crypto API, constant-time comparison
- `src/core/oauth.ts` — OAuth 2.0 utilities: `generateState()`, `generateCodeVerifier()`, `createS256CodeChallenge()`, `exchangeAuthorizationCode()`
- `src/core/rbac.ts` — `resolvePermissions()` for role→permission mapping
- `src/providers/` — OAuth providers: `github.ts`, `google.ts` (PKCE), `line.ts` (PKCE)
- `src/db/queries.ts` — Raw SQL queries, `src/db/migrate.ts` — Auto migration with MIGRATIONS array
- `src/server/handlers.ts` — Route handlers (login, callback, session, logout, register, credentials login, set-role)
- `src/server/auth.ts` — `auth(request)` session validation helper
- `src/client/` — `SessionProvider`, `useSession()`, `signIn()`, `signUp()`, `signOut()`, `usePermission()`, `useRole()`
- `tests/` — 123 bun:test tests across 9 files with mock DB adapter in `tests/helpers/mock-db.ts`
- `sample-auth/` — Working Cloudflare Worker demo deployed at https://sample-auth.anu.workers.dev
- `dist/` — Compiled JS + .d.ts output (built via `bun run build`)

## Package Exports

- `@1moby/just-auth` (`.`) — `createReactAuth`, providers, `migrate`, session/cookie utils, `hashPassword`, `verifyPassword`, `resolvePermissions`, all types
- `@1moby/just-auth/client` (`./client`) — `SessionProvider`, `useSession`, `signIn`, `signUp`, `signOut`, `usePermission`, `useRole`
- `@1moby/just-auth/server` (`./server`) — Server-side auth helpers

## Build & Publish

- `bun run build` — Compiles `src/` to `dist/` (ESM .js + .d.ts via tsc)
- `npm publish --access public` — Publish to npm (runs build via prepublishOnly)
- Dual output: consumers can import from `dist/` (compiled) or `src/` (raw .ts for Bun/bundlers)

## Database

3 tables: `users` (with optional `password_hash` and `role`), `accounts`, `sessions`. DatabaseAdapter interface matches D1's `prepare().bind().run()/first()/all()` API. Session tokens stored as SHA-256 hashes. Sliding window: 30-day sessions, extend at 15 days remaining. Passwords hashed with PBKDF2-SHA256 (100k iterations, Web Crypto API). Optional RBAC: `role TEXT DEFAULT 'user'` column, permissions defined in code config.

## Auth Routes (default basePath: /api/auth)

- `GET /api/auth/login/:provider` — Redirect to OAuth provider
- `GET /api/auth/callback/:provider` — Handle OAuth callback, create session
- `POST /api/auth/register` — Register with email/password (requires `credentials: true`)
- `POST /api/auth/callback/credentials` — Login with email/password (requires `credentials: true`)
- `GET /api/auth/session` — Return current session JSON with linked accounts and permissions
- `POST /api/auth/role` — Set user role (requires `rbac` config + `user:set-role` permission)
- `GET /api/auth/logout` — Invalidate session, redirect to /

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

Use `bun test` to run tests. 123 tests across 9 files.

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.
