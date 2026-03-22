# @1moby/just-auth

Lightweight, zero-dependency, edge-native auth library for React.

OAuth 2.0 + PKCE, email/password, session management, RBAC — all built on Web Crypto API and raw SQL. Works with Cloudflare Workers, Bun, Deno, and any runtime that supports standard `Request`/`Response`.

## Features

- **Zero dependencies** — only React as a peer dep
- **OAuth 2.0 + PKCE** — built-in providers for Google, GitHub, LINE
- **Email/password auth** — PBKDF2-SHA256 via Web Crypto API, timing-safe comparison
- **Account linking** — multiple providers share one user account via email matching
- **Session management** — sliding window (30-day sessions, auto-extend at 15 days), SHA-256 hashed tokens
- **RBAC** — optional role-based access control with code-defined permissions
- **React client** — `SessionProvider`, `useSession()`, `signIn()`, `signOut()`, `signUp()`
- **Edge-native** — standard `Request`/`Response`, no Node.js-specific APIs
- **Raw SQL** — compatible with Cloudflare D1, bun:sqlite, or any SQLite driver

## Install

```bash
bun add @1moby/just-auth
# or
npm install @1moby/just-auth
```

## Quick Start

### 1. Database Setup

Run the auto migration or create tables manually:

```ts
import { migrate } from "@1moby/just-auth";

await migrate(db); // Creates users, accounts, sessions tables
```

### 2. Server Setup

```ts
import {
  createReactAuth,
  createGoogleProvider,
  createGitHubProvider,
  migrate,
} from "@1moby/just-auth";

const auth = createReactAuth({
  providers: [
    createGoogleProvider({
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      redirectURI: "https://example.com/api/auth/callback/google",
    }),
    createGitHubProvider({
      clientId: env.GITHUB_CLIENT_ID,
      clientSecret: env.GITHUB_CLIENT_SECRET,
      redirectURI: "https://example.com/api/auth/callback/github",
    }),
  ],
  database: db,
  credentials: true, // enable email/password
  allowDangerousEmailAccountLinking: true,
});

// Handle auth routes
const response = await auth.handleRequest(request);
if (response) return response;
```

### 3. Protect Server Routes

```ts
const session = await auth.auth(request);
if (!session) {
  return new Response("Unauthorized", { status: 401 });
}
// session.user = { id, email, name, avatarUrl, role }
```

### 4. React Client

```tsx
import { SessionProvider, useSession, signIn, signOut } from "@1moby/just-auth/client";

function App() {
  return (
    <SessionProvider>
      <Profile />
    </SessionProvider>
  );
}

function Profile() {
  const { data, status } = useSession();

  if (status === "loading") return <p>Loading...</p>;
  if (status === "unauthenticated") return <button onClick={() => signIn("google")}>Sign In</button>;

  return (
    <div>
      <p>Hello, {data.user.name}</p>
      <button onClick={() => signOut()}>Sign Out</button>
    </div>
  );
}
```

### 5. Email/Password

```tsx
import { signIn, signUp } from "@1moby/just-auth/client";

// Register
const res = await signUp({ email: "user@example.com", password: "secret123" });

// Login
const res = await signIn("credentials", { email: "user@example.com", password: "secret123" });
```

### 6. RBAC (Optional)

```ts
const auth = createReactAuth({
  // ...providers, database...
  rbac: {
    statements: {
      post: ["create", "read", "update", "delete"],
      user: ["list", "ban", "set-role"],
    },
    roles: {
      user: { post: ["read"] },
      admin: "*", // all permissions
    },
    defaultRole: "user",
  },
});

// Server
const canEdit = await auth.hasPermission(request, "post:update");
const isAdmin = await auth.hasRole(request, "admin");
```

```tsx
// Client
import { usePermission, useRole } from "@1moby/just-auth/client";

const canEdit = usePermission("post:update");
const isAdmin = useRole("admin");
```

## Auth Routes

Default `basePath: "/api/auth"`:

| Route | Method | Description |
|-------|--------|-------------|
| `/api/auth/login/:provider` | GET | Redirect to OAuth provider |
| `/api/auth/callback/:provider` | GET | Handle OAuth callback, create session |
| `/api/auth/register` | POST | Register with email/password |
| `/api/auth/callback/credentials` | POST | Login with email/password |
| `/api/auth/session` | GET | Return session JSON + linked accounts + permissions |
| `/api/auth/role` | POST | Set user role (requires `user:set-role` permission) |
| `/api/auth/logout` | GET | Invalidate session, redirect to `/` |

## Database Schema

3 tables: `users`, `accounts`, `sessions`. Uses raw SQL compatible with any SQLite driver.

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE,
  name TEXT,
  avatar_url TEXT,
  password_hash TEXT,
  role TEXT NOT NULL DEFAULT 'user'
);

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider_id TEXT NOT NULL,
  provider_user_id TEXT NOT NULL,
  access_token TEXT,
  refresh_token TEXT,
  expires_at INTEGER
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
```

## Database Adapter

Implement the `DatabaseAdapter` interface to connect any database:

```ts
import type { DatabaseAdapter } from "@1moby/just-auth";

// Example: Cloudflare D1 adapter
function createD1Adapter(db: D1Database): DatabaseAdapter {
  return {
    prepare(sql) {
      return {
        bind(...params) {
          const stmt = db.prepare(sql).bind(...params);
          return {
            async run() { await stmt.run(); return { success: true }; },
            async first<T>() { return await stmt.first<T>(); },
            async all<T>() { return { results: (await stmt.all<T>()).results }; },
          };
        },
      };
    },
    async batch(statements) {
      const results = [];
      for (const stmt of statements) results.push(await stmt.run());
      return results;
    },
  };
}
```

## Exports

```ts
// Main
import { createReactAuth, migrate } from "@1moby/just-auth";
import { createGoogleProvider, createGitHubProvider, createLineProvider } from "@1moby/just-auth";
import { hashPassword, verifyPassword, resolvePermissions } from "@1moby/just-auth";

// Client
import { SessionProvider, useSession, signIn, signUp, signOut } from "@1moby/just-auth/client";
import { usePermission, useRole } from "@1moby/just-auth/client";

// Types
import type {
  AuthConfig, AuthInstance, User, Session, Account,
  DatabaseAdapter, OAuthProvider, SessionManager,
  RbacConfig, SessionContextValue, SessionStatus,
} from "@1moby/just-auth";
```

## Demo

[https://sample-auth.anu.workers.dev](https://sample-auth.anu.workers.dev)

## Testing

```bash
bun test  # 123 tests
```

## License

MIT
