# @1moby/just-auth

Lightweight, zero-dependency, edge-native auth library for React.

OAuth 2.0 + PKCE, email/password, session management, RBAC, route-level middleware — all built on Web Crypto API and raw SQL. Works with Cloudflare Workers, Bun, Deno, Next.js, and any runtime that supports standard `Request`/`Response`.

## Features

- **Zero dependencies** — only React as a peer dep
- **OAuth 2.0 + PKCE** — built-in providers for Google, GitHub, LINE
- **Email/password auth** — PBKDF2-SHA256 (600k iterations), timing-safe comparison
- **Account linking** — multiple providers share one user account via email matching
- **Session management** — sliding window (30-day sessions, auto-extend at 15 days), SHA-256 hashed tokens
- **RBAC** — optional role-based access control with code-defined permissions
- **Email/domain restriction** — `allowedEmails` config to restrict by domain or custom function
- **Route permission middleware** — `createAuthMiddleware` for path-based permission gating
- **Database adapters** — D1, bun:sqlite, pg, mysql2, Bun.sql — bring your own driver
- **Table prefix** — `tablePrefix: "myapp_"` for shared databases
- **Non-destructive migrations** — validates existing schema, never ALTER or DROP
- **Security hardened** — open redirect protection, password length limits, POST-only logout
- **Edge-native** — standard `Request`/`Response`, no Node.js-specific APIs

## Install

```bash
bun add @1moby/just-auth
# or
npm install @1moby/just-auth
```

## Quick Start

### 1. Choose a Database Adapter

```ts
// Cloudflare D1
import { createD1Adapter } from "@1moby/just-auth/adapters/d1";
const db = createD1Adapter(env.DB);

// bun:sqlite
import { createBunSQLiteAdapter } from "@1moby/just-auth/adapters/bun-sqlite";
const db = createBunSQLiteAdapter(new Database("auth.db"));

// PostgreSQL (pg)
import { createPgAdapter } from "@1moby/just-auth/adapters/pg";
const db = createPgAdapter(new Pool({ connectionString: env.DATABASE_URL }));

// MySQL (mysql2)
import { createMySQLAdapter } from "@1moby/just-auth/adapters/mysql";
const db = createMySQLAdapter(pool);

// Bun.sql (Postgres or MySQL)
import { createBunSQLAdapter } from "@1moby/just-auth/adapters/bun-sql";
const db = createBunSQLAdapter(Bun.sql);
const db = createBunSQLAdapter(Bun.sql, { dialect: "mysql" });
```

Only the adapter you import gets bundled. Drivers are peer dependencies — install what you need.

### 2. Run Migrations

```ts
import { migrate } from "@1moby/just-auth";

await migrate(db);
// With table prefix:
await migrate(db, { tablePrefix: "myapp_" });
```

Migrations are non-destructive: creates tables if missing, validates existing schema, never alters or drops existing tables.

### 3. Server Setup

```ts
import {
  createReactAuth,
  createGoogleProvider,
  createGitHubProvider,
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
  credentials: true,
  oauthAutoCreateAccount: true,
  allowDangerousEmailAccountLinking: true,
});

// Handle auth routes
const response = await auth.handleRequest(request);
if (response) return response;
```

### 4. Protect Server Routes

```ts
const session = await auth.auth(request);
if (!session) {
  return new Response("Unauthorized", { status: 401 });
}
// session.user = { id, email, name, avatarUrl, role }
```

### 5. React Client

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

### 6. Email/Password

```tsx
import { signIn, signUp } from "@1moby/just-auth/client";

// Register
const res = await signUp({ email: "user@example.com", password: "secret123" });

// Login
const res = await signIn("credentials", { email: "user@example.com", password: "secret123" });
```

## Configuration

```ts
createReactAuth({
  providers: [...],
  database: db,

  // Auth options
  basePath: "/api/auth",               // default: "/api/auth"
  credentials: true,                   // enable email/password auth
  allowRegistration: true,             // allow self-registration (default: true when credentials enabled)
  oauthAutoCreateAccount: true,        // auto-create users on OAuth login (default: false)
  allowDangerousEmailAccountLinking: true,  // link accounts by email match
  passwordMinLength: 8,               // default: 8, max: 128

  // Email restriction
  allowedEmails: ["@1moby.com"],       // domain allowlist
  // or: allowedEmails: (email) => email.endsWith("@1moby.com"),

  // Table prefix for shared databases
  tablePrefix: "myapp_",              // → myapp_users, myapp_accounts, myapp_sessions

  // Cookie options
  cookie: {
    name: "auth_session",             // default: "auth_session"
    secure: true,                     // default: true
    sameSite: "lax",                  // default: "lax"
    domain: ".example.com",           // for subdomain sharing
    path: "/",                        // default: "/"
  },

  // Session options
  session: {
    maxAge: 30 * 86400,               // 30 days (seconds)
    refreshThreshold: 15 * 86400,     // extend when < 15 days remaining
  },

  // RBAC
  rbac: {
    statements: {
      post: ["create", "read", "update", "delete"],
      user: ["list", "ban", "set-role"],
    },
    roles: {
      user: { post: ["read"] },
      admin: "*",  // wildcard = all permissions
    },
    defaultRole: "user",
  },
});
```

## RBAC

```ts
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

## Route Permission Middleware

```ts
import { createAuthMiddleware } from "@1moby/just-auth/middleware";

const { handle } = createAuthMiddleware(auth, {
  publicPaths: ["/login", "/public/*"],
  loginRedirect: "/login",
  routePermissions: {
    "/admin/*": "admin:access",
    "/api/admin/*": "admin:access",
  },
  onForbidden: (req) => new Response("Forbidden", { status: 403 }),
});

// In your server:
const blocked = await handle(request);
if (blocked) return blocked;
// ...proceed with normal routing
```

Auto-skips static files (`.js`, `.css`, `.png`, etc.). Supports exact paths and glob patterns.

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
| `/api/auth/logout` | POST | Invalidate session, return `{ ok: true }` |

## Database Adapters

Bring your own driver — only the adapter you import gets bundled:

```ts
import { createD1Adapter } from "@1moby/just-auth/adapters/d1";
import { createBunSQLiteAdapter } from "@1moby/just-auth/adapters/bun-sqlite";
import { createPgAdapter } from "@1moby/just-auth/adapters/pg";
import { createMySQLAdapter } from "@1moby/just-auth/adapters/mysql";
import { createBunSQLAdapter } from "@1moby/just-auth/adapters/bun-sql";
```

The Pg and Bun.sql adapters auto-translate `?` placeholders to `$1, $2, ...`. Schema uses portable types (`VARCHAR(255)`, `BIGINT`, `TEXT`) that work across SQLite, Postgres, and MySQL.

You can also implement the `DatabaseAdapter` interface directly for any custom driver.

## Exports

```ts
// Main
import { createReactAuth, migrate } from "@1moby/just-auth";
import { createGoogleProvider, createGitHubProvider, createLineProvider } from "@1moby/just-auth";
import { hashPassword, verifyPassword, resolvePermissions } from "@1moby/just-auth";
import { createQueries, resolveTableNames } from "@1moby/just-auth";

// Client
import { SessionProvider, useSession, signIn, signUp, signOut } from "@1moby/just-auth/client";
import { usePermission, useRole } from "@1moby/just-auth/client";

// Middleware
import { createAuthMiddleware } from "@1moby/just-auth/middleware";

// Database Adapters
import { createD1Adapter } from "@1moby/just-auth/adapters/d1";
import { createBunSQLiteAdapter } from "@1moby/just-auth/adapters/bun-sqlite";
import { createPgAdapter } from "@1moby/just-auth/adapters/pg";
import { createMySQLAdapter } from "@1moby/just-auth/adapters/mysql";
import { createBunSQLAdapter } from "@1moby/just-auth/adapters/bun-sql";

// Types
import type {
  AuthConfig, AuthInstance, User, Session, Account,
  DatabaseAdapter, OAuthProvider, SessionManager,
  RbacConfig, SessionContextValue, SessionStatus,
  Queries, TableNames, MigrateOptions,
} from "@1moby/just-auth";
```

## Demo

[https://sample-auth.anu.workers.dev](https://sample-auth.anu.workers.dev)

## Testing

```bash
bun test  # 152 tests
```

## License

MIT
