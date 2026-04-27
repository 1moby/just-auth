# Project Structure

## Source (`src/`)

### Core (`src/core/`)
| File | Purpose |
|------|---------|
| `session.ts` | `generateSessionToken()`, `hashToken()` (async SHA-256 via Web Crypto), `createSessionManager()` with sliding window, `encodeBase64url()`, `encodeHex()` |
| `cookie.ts` | `resolveCookieConfig()`, `serializeSessionCookie()`, `clearSessionCookie()`, `parseSessionCookie()`, `serializeStateCookie()`, `parseCookieValue()` |
| `password.ts` | `hashPassword()` PBKDF2-SHA256 (600k iterations), `verifyPassword()` with constant-time comparison |
| `oauth.ts` | `generateState()`, `generateCodeVerifier()`, `createS256CodeChallenge()`, `exchangeAuthorizationCode()` — all Web Crypto, zero deps |
| `rbac.ts` | `resolvePermissions(roleString, rbacConfig)` — multi-role (comma-separated), inheritance (cycle-safe), deny-wins. `parseRoles(str)` splits role strings. |

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
| `clickhouse/index.ts` | `@clickhouse/client` | Drop-in `DatabaseAdapter` (auto-FINAL on framework reads, tombstone DELETEs, read-then-merge UPDATEs) plus `migrate()`, `rbac` (org/dept/supervisor graph), `approvals` (state machine). Cluster-aware. Verified on CH 24.8 / 25.3 / 25.10. |

### ClickHouse Adapter Internals (`src/adapters/clickhouse/`)
| File | Purpose |
|------|---------|
| `index.ts` | `createClickhouseAdapter()` — assembles adapter-core + rbac + approvals + migrate; sessions_dict hot path lookup |
| `adapter-core.ts` | Translates `DatabaseAdapter.prepare/bind/run/first/all` to CH calls. Auto-injects `FINAL` on framework table reads. DELETE → `_deleted=1` tombstone insert. UPDATE → SELECT + merge + insert. |
| `sql-translator.ts` | Parses `?`-style INSERT / SELECT / UPDATE / DELETE; rewrites `?` → `{pN:String}`; adds `AND _deleted = 0` to SELECT WHEREs |
| `ddl.ts` | Cluster-aware DDL builders for the 9 `ReplacingMergeTree` tables, 1 append-only `MergeTree` (`approval_decisions`), and 1 `Dictionary` (`sessions_dict`) |
| `migrate.ts` | Runs DDL idempotently. Autodetects current database via `SELECT currentDatabase()` so the dictionary's source query can be fully qualified. |
| `rbac.ts` | `RbacApi`: createOrganization / Department / Role / grant / revoke / `resolvePermission` with `via: 'role' \| 'inherited' \| 'supervisor' \| 'home_org' \| 'superadmin'`. Cycle-safe org-tree + supervisor-chain traversal. |
| `approvals.ts` | `ApprovalsApi`: `open` (chain frozen at submit time), `decide` (idempotent on `(requestId, approverUserId)`, supports approve/reject/delegate), `expireDuePending`, `listForApprover` / `listForRequester`. |
| `cycle-detect.ts` | `traverseChain()` + `collectDescendants()` — `Set<string>` visited set, throws on cycle. |
| `util.ts` | `chDate(d)` canonical CH `DateTime64` formatter (`YYYY-MM-DD HH:MM:SS.mmm`); `chDateNow()`; `uuid()` v4 |
| `types.ts` | `CHClient`, `CHTableNames`, `Organization`, `Department`, `EffectiveRole`, `PermissionDecision`, `ApprovalRequest`, `ApprovalStatus`, `Logger` |

### Entry Points
| File | Purpose |
|------|---------|
| `src/index.ts` | `createReactAuth()` factory + all re-exports (providers, migrate, queries, password, rbac, session, cookie, types) |
| `src/types.ts` | All TypeScript interfaces: `User`, `Session`, `Account`, `AuthConfig`, `AuthInstance`, `DatabaseAdapter`, `RbacConfig`, etc. |

## Tests (`tests/`)

331 tests across 20 files using `bun:test`:

### Unit suite

| File | What it tests |
|------|---------------|
| `session.test.ts` | Token generation, SHA-256 hashing, session CRUD, sliding window |
| `cookie.test.ts` | Cookie serialization, parsing, config resolution |
| `password.test.ts` | PBKDF2 hashing, verification, constant-time comparison |
| `providers.test.ts` | Provider creation, auth URL generation, PKCE |
| `queries.test.ts` | All SQL operations via mock DB; createUser `extraColumns` + reserved-key guard |
| `handlers.test.ts` | All route handlers, email restriction, RBAC endpoints |
| `auth.test.ts` | Full OAuth flow integration (login → callback → session → logout) |
| `migrate.test.ts` | Schema creation, idempotent migration |
| `rbac.test.ts` | Permission resolution, wildcards, unknown roles |
| `middleware.test.ts` | Public paths, auth gating, route permissions, static file skip |
| `adapters.test.ts` | All 5 SQL adapters: D1, bun:sqlite, pg, mysql, bun:sql |
| `callbacks.test.ts` | `signIn` / `session` lifecycle callbacks; `userOverrides` injection; `pages.error` open-redirect guard |
| `email-linking.test.ts` | `allowEmailAccountLinking` flag + `emailLinked` callback context field |
| `security-*.test.ts` | CSRF, OAuth state, session, password enumeration, SQL injection (meta) |
| `adapters/clickhouse/clickhouse.test.ts` | All 12 spec scenarios against the in-memory mock CH client (round-trip auth, cascade delete, org/dept tree, cycle detection, `resolvePermission` `via` outcomes, approval flow + delegation + rejection + expire, sessions_dict, cluster mode) |
| `adapters/clickhouse/helpers/mock-ch.ts` | In-memory `CHClient` simulating `ReplacingMergeTree FINAL`, `dictGet`, named-params |
| `helpers/mock-db.ts` | In-memory `DatabaseAdapter` mock for SQL adapter tests |

### Integration suite (requires Docker)

`tests/integration/clickhouse/run.ts` — drives the same 13 spec scenarios against three live ClickHouse versions (`24.8`, `25.3`, `25.10`) booted via `examples/clickhouse/docker-compose.yml`. Run with:

```bash
docker compose -f examples/clickhouse/docker-compose.yml up -d
bun tests/integration/clickhouse/run.ts          # all three
bun tests/integration/clickhouse/run.ts 24       # one version
docker compose -f examples/clickhouse/docker-compose.yml down -v
```

Prints a per-version pass/fail summary.

## Sample App (`sample-auth/`)

Cloudflare Worker demo (deploy your own — see `sample-auth/README.md`)

| File | Purpose |
|------|---------|
| `worker.ts` | CF Worker entry — D1 adapter, Google/LINE providers, RBAC config |
| `server.ts` | Local dev server (bun:sqlite) |
| `pages/login.tsx` | OAuth buttons + email/password form |
| `pages/dashboard.tsx` | Session info, RBAC, linked accounts, feature overview |
| `build.ts` | `Bun.build()` with content-hashed filenames |
| `wrangler.jsonc` | D1 binding, Assets SPA mode |

## ClickHouse Example (`examples/clickhouse/`)

Runnable adapter integration with a real ClickHouse server:

| File | Purpose |
|------|---------|
| `docker-compose.yml` | Runs CH 24.8, 25.3, 25.10 simultaneously on ports 8124/8125/8126 |
| `server.ts` | `createReactAuth({ database: createClickhouseAdapter({ client }) })` with a Google provider, `migrate()`, RBAC bootstrap, structured JSON logger |
| `README.md` | How to spin up CH, run the integration test runner, validate against your CI |
