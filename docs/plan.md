# react-auth Architecture & Implementation

## Overview

Lightweight, edge-native NextAuth alternative using Arctic for OAuth, raw SQL for D1/SQLite, and a NextAuth-compatible React API. < 200KB bundle, zero Node.js-specific dependencies, native Cloudflare Workers support.

**Status: Implemented** — 285 tests passing across 17 files

## Architecture

```
react-auth/
├── src/
│   ├── index.ts                 # createReactAuth() factory, re-exports all public API
│   ├── types.ts                 # All shared TypeScript interfaces
│   ├── core/
│   │   ├── session.ts           # generateSessionToken(), hashToken(), createSessionManager()
│   │   └── cookie.ts            # Cookie serialization/parsing, state cookies, PKCE cookies
│   ├── providers/
│   │   ├── index.ts             # createProviderMap() registry
│   │   ├── github.ts            # GitHub OAuth via arctic.GitHub
│   │   ├── google.ts            # Google OAuth via arctic.Google + PKCE
│   │   └── line.ts              # LINE OAuth via arctic.Line + PKCE
│   ├── db/
│   │   ├── schema.sql           # Raw SQL schema (users, accounts, sessions)
│   │   ├── queries.ts           # All raw SQL query functions
│   │   └── migrate.ts           # Schema migration (CREATE TABLE IF NOT EXISTS)
│   ├── server/
│   │   ├── auth.ts              # createAuth() — wraps session validation
│   │   └── handlers.ts          # createHandlers() — login, callback, session, logout routes
│   └── client/
│       ├── index.ts             # Re-exports SessionProvider, useSession, signIn, signOut
│       ├── session-context.tsx   # SessionProvider context + useSession hook
│       └── actions.ts           # signIn(provider), signOut() browser helpers
├── tests/                       # 92 tests across 7 files (bun:test)
│   ├── helpers/mock-db.ts       # In-memory mock DatabaseAdapter
│   ├── session.test.ts
│   ├── cookie.test.ts
│   ├── queries.test.ts
│   ├── providers.test.ts
│   ├── handlers.test.ts
│   ├── auth.test.ts
│   └── migrate.test.ts
├── sample-auth/                 # Working Cloudflare Worker demo
│   ├── worker.ts                # CF Worker with D1 adapter
│   ├── wrangler.jsonc           # Cloudflare config (D1, Assets, SPA)
│   ├── build.ts                 # Bun.build() frontend bundler
│   ├── app.tsx                  # React SPA with SessionProvider
│   ├── pages/login.tsx          # Google + LINE sign-in page
│   ├── pages/dashboard.tsx      # User info + schema + usage docs
│   ├── styles.css
│   ├── index.html
│   ├── db-adapter.ts            # bun:sqlite adapter for local dev
│   └── server.ts                # Bun.serve() for local dev
└── docs/
```

## Package Exports

```json
{
  ".": "./src/index.ts",
  "./client": "./src/client/index.ts",
  "./server": "./src/server/index.ts"
}
```

## Key Interfaces

### DatabaseAdapter (matches D1 API)
```ts
interface DatabaseAdapter {
  prepare(sql: string): PreparedStatement;
  batch<T>(statements: PreparedStatement[]): Promise<T[]>;
}
```

### AuthConfig
```ts
interface AuthConfig {
  providers: OAuthProvider[];
  database: DatabaseAdapter;
  basePath?: string;           // default "/api/auth"
  cookie?: CookieOptions;
  session?: SessionOptions;
}
```

### AuthInstance (returned by createReactAuth)
```ts
interface AuthInstance {
  auth(request: Request): Promise<SessionValidationResult | null>;
  handleRequest(request: Request): Promise<Response>;
  providers: Map<string, OAuthProvider>;
  sessionManager: SessionManager;
}
```

## Database Schema

```sql
CREATE TABLE users (id TEXT PK, email TEXT UQ, name TEXT, avatar_url TEXT);
CREATE TABLE accounts (id TEXT PK, user_id FK, provider_id, provider_user_id, access_token, refresh_token, expires_at);
CREATE TABLE sessions (id TEXT PK, user_id FK, expires_at INTEGER);
-- Indexes on accounts(provider_id, provider_user_id), accounts(user_id), sessions(user_id)
```

## Auth Flow

1. `signIn("google")` -> `/api/auth/login/google`
2. Generate state + PKCE, store in cookies (10min)
3. Redirect to provider authorization URL
4. Callback: validate state, restore PKCE verifier, exchange code, fetch profile
5. Upsert user + account, create session (SHA-256 hash), set cookie (30-day)
6. `SessionProvider` fetches `/api/auth/session`, sliding window refresh at 15 days

## Security

- Session tokens: SHA-256 hashed (Copenhagen Book pattern)
- Cookies: `HttpOnly`, `Secure`, `SameSite=Lax`
- OAuth state for CSRF, PKCE for Google/LINE
- IDs from `crypto.getRandomValues()`

## Dependencies

- `arctic` ^3.7.0, `@oslojs/crypto` ^1.0.1, `@oslojs/encoding` ^1.1.0
- `react` >=18 (peer)

## Cloudflare Workers Notes

- `run_worker_first: ["/api/*"]` ensures API routes hit Worker, not SPA
- Each request creates a new `createReactAuth()` instance (stateless)
- PKCE code verifier persisted via HttpOnly cookie between login and callback
- Migration runs once per Worker instance via `migrated` flag

## Test Coverage

92 tests, 189 assertions across 7 files covering session, cookie, queries, providers, handlers, auth, migration
