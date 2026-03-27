# Project Structure

## Source (`src/`)

### Core (`src/core/`)
| File | Purpose |
|------|---------|
| `session.ts` | `generateSessionToken()`, `hashToken()` (async SHA-256 via Web Crypto), `createSessionManager()` with sliding window, `encodeBase64url()`, `encodeHex()` |
| `cookie.ts` | `resolveCookieConfig()`, `serializeSessionCookie()`, `clearSessionCookie()`, `parseSessionCookie()`, `serializeStateCookie()`, `parseCookieValue()` |
| `password.ts` | `hashPassword()` PBKDF2-SHA256 (600k iterations), `verifyPassword()` with constant-time comparison |
| `oauth.ts` | `generateState()`, `generateCodeVerifier()`, `createS256CodeChallenge()`, `exchangeAuthorizationCode()` — all Web Crypto, zero deps |
| `rbac.ts` | `resolvePermissions(role, rbacConfig)` — maps role to `resource:action` permission strings |

### Providers (`src/providers/`)
| File | Purpose |
|------|---------|
| `github.ts` | `createGitHubProvider(config)` — OAuth 2.0, Basic auth for token exchange |
| `google.ts` | `createGoogleProvider(config)` — OAuth 2.0 + PKCE (S256) |
| `line.ts` | `createLineProvider(config)` — OAuth 2.0 + PKCE (S256) |
| `index.ts` | `createProviderMap(providers[])` — builds `Map<id, OAuthProvider>` |

### Database (`src/db/`)
| File | Purpose |
|------|---------|
| `queries.ts` | `createQueries(db, prefix?)` factory — all SQL operations (users, accounts, sessions). `resolveTableNames(prefix?)` for table prefix support. Uses `?` placeholders (adapters translate for Postgres). |
| `migrate.ts` | `migrate(db, options?)` — non-destructive: validates existing schema, creates missing tables/indexes, never ALTERs/DROPs. Logs manual ALTER instructions if schema mismatches. |

### Server (`src/server/`)
| File | Purpose |
|------|---------|
| `auth.ts` | `createAuth(config)` — wires `sessionManager`, `queries`, `cookieConfig` from `AuthConfig` |
| `handlers.ts` | `createHandlers(config)` → `handleRequest(request)` — all auth routes. Uses HTML redirects (not 302) for login/callback to survive reverse proxies. Uses `[string, string][]` header tuples for Set-Cookie to prevent comma-merging. |

### Client (`src/client/`)
| File | Purpose |
|------|---------|
| `session-context.tsx` | `SessionProvider` + `useSession()` — React context with auto-fetch, refetch on window focus |
| `actions.ts` | `signIn(provider, opts?)`, `signUp(opts)`, `signOut()` — `signIn("credentials")` POSTs, OAuth redirects via `window.location`, `signOut()` POSTs then redirects |
| `hooks.ts` | `usePermission(permission)`, `useRole(role)` — boolean checks against session data |

### Middleware (`src/middleware/`)
| File | Purpose |
|------|---------|
| `index.ts` | `createAuthMiddleware(auth, config)` → `{handle(request)}` — route-level permission gating. Auto-skips static files. Supports `publicPaths`, `routePermissions` (glob patterns), `loginRedirect`, custom `onForbidden`. |

### Adapters (`src/adapters/`)
| File | Driver | Notes |
|------|--------|-------|
| `d1.ts` | Cloudflare D1 | Wraps D1's prepare/bind API |
| `bun-sqlite.ts` | bun:sqlite | Wraps sync methods as async |
| `pg.ts` | pg (node-postgres) | Auto-translates `?` → `$1, $2, ...` |
| `mysql.ts` | mysql2 | Uses `pool.execute()` with `?` placeholders |
| `bun-sql.ts` | Bun.sql | Uses `sql.unsafe()`. Options: `{dialect: "mysql"}` keeps `?`, default (postgres) converts to `$1,$2` |

### Entry Points
| File | Purpose |
|------|---------|
| `src/index.ts` | `createReactAuth()` factory + all re-exports (providers, migrate, queries, password, rbac, session, cookie, types) |
| `src/types.ts` | All TypeScript interfaces: `User`, `Session`, `Account`, `AuthConfig`, `AuthInstance`, `DatabaseAdapter`, `RbacConfig`, etc. |

## Tests (`tests/`)

152 tests across 11 files using `bun:test`:

| File | What it tests |
|------|---------------|
| `session.test.ts` | Token generation, SHA-256 hashing, session CRUD, sliding window |
| `cookie.test.ts` | Cookie serialization, parsing, config resolution |
| `password.test.ts` | PBKDF2 hashing, verification, constant-time comparison |
| `providers.test.ts` | Provider creation, auth URL generation, PKCE |
| `queries.test.ts` | All SQL operations via mock DB |
| `handlers.test.ts` | All route handlers, email restriction, RBAC endpoints |
| `auth.test.ts` | Full OAuth flow integration (login → callback → session → logout) |
| `migrate.test.ts` | Schema creation, idempotent migration |
| `rbac.test.ts` | Permission resolution, wildcards, unknown roles |
| `middleware.test.ts` | Public paths, auth gating, route permissions, static file skip |
| `adapters.test.ts` | All 5 adapters: D1, bun:sqlite, pg, mysql, bun:sql |
| `helpers/mock-db.ts` | In-memory DatabaseAdapter mock for testing |

## Sample App (`sample-auth/`)

Cloudflare Worker demo at https://sample-auth.anu.workers.dev

| File | Purpose |
|------|---------|
| `worker.ts` | CF Worker entry — D1 adapter, Google/LINE providers, RBAC config |
| `server.ts` | Local dev server (bun:sqlite) |
| `pages/login.tsx` | OAuth buttons + email/password form |
| `pages/dashboard.tsx` | Session info, RBAC, linked accounts, feature overview |
| `build.ts` | `Bun.build()` with content-hashed filenames |
| `wrangler.jsonc` | D1 binding, Assets SPA mode |
