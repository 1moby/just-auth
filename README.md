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
  allowEmailAccountLinking: true,
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
  allowEmailAccountLinking: true,      // link accounts by verified email match (default: false)
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

  // RBAC (see full RBAC section below)
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

## Email-based account linking

When a user signs in via OAuth and their `(provider_id, provider_user_id)` has no matching row in `accounts`, but their profile email matches an existing user, the default behavior is to reject with `OAuthAccountNotLinked` (HTTP 403). Set `allowEmailAccountLinking: true` to instead link the incoming OAuth account to the existing user.

```ts
createReactAuth({
  // ...
  allowEmailAccountLinking: true,
});
```

**Trust implication.** Linking by email is safe only when you trust the identity provider to verify the email (e.g. Google Workspace with a hosted-domain restriction, or a corporate IdP). If a provider lets users sign up with unverified emails, a malicious user could claim ownership of another user's email and get their account linked.

When a link occurs, the `signIn` callback (if set) is invoked with `ctx.emailLinked === true` and `ctx.existingUserId` set to the linked user's id — useful for audit logs:

```ts
callbacks: {
  signIn: async (ctx) => {
    if (ctx.emailLinked) {
      await auditLog.record({ event: "oauth_account_linked", userId: ctx.existingUserId, provider: ctx.provider });
    }
    return { allow: true };
  },
}
```

The older `allowDangerousEmailAccountLinking` flag still works as an alias for backward compatibility but is deprecated; prefer `allowEmailAccountLinking` in new code.

## Hooks

Two optional lifecycle callbacks let consumers intercept sign-in and customize the session response without forking the library. Both are plain async functions on `AuthConfig.callbacks`.

### `signIn` — gate OAuth sign-in, inject extra columns

Fires inside the OAuth callback handler, **after** token exchange and user lookup but **before** any user or account row is written. Return `{ allow: false, reason }` to abort (the user is redirected to `pages.error ?? "/"` with `?error=REASON`). Return `{ allow: true, userOverrides }` to continue; `userOverrides` is merged into the `users` INSERT as extra columns — only applied when a new user is being created. The base identity columns (`id`, `email`, `name`, `avatar_url`) cannot be overridden. The `role` column IS overridable — you can assign an initial role to the new user via `userOverrides: { role: "admin" }`. Use with care; the library does not validate role names.

```ts
import type { AuthConfig } from "@1moby/just-auth";

export const authConfig: AuthConfig = {
  // ... providers, database, etc.
  pages: { error: "/auth/error" },
  callbacks: {
    signIn: async (ctx) => {
      if (!ctx.profile.email?.endsWith("@1moby.com")) {
        return { allow: false, reason: "DOMAIN_BLOCKED" };
      }
      // Optional: look up invitation, attach org_id
      return {
        allow: true,
        userOverrides: { org_id: "the-org-uuid" },
      };
    },
  },
};
```

Extra columns must already exist on the `users` table — the library never ALTERs existing tables. Column names are validated against `/^[a-zA-Z_][a-zA-Z0-9_]*$/` before being interpolated into the INSERT; values use parameter binding.

### `session` — customize the `/api/auth/session` response

Fires on every `GET /api/auth/session` call, after the session + user are loaded. Whatever you return becomes the response body verbatim (the default `{ user, session, accounts, permissions }` shape is bypassed entirely — include what you need).

```ts
callbacks: {
  session: async ({ user, session }) => {
    const roles = await fetchRolesFor(user.id);
    return { user, roles, sessionExpiresAt: session.expiresAt };
  },
}
```

With no `callbacks.session` set, the default response shape is unchanged from 0.1.x.

## RBAC

Supports multi-role per user, role inheritance, and deny rules — all backward-compatible with single-role setups.

### Basic (single role)

```ts
rbac: {
  statements: {
    post: ["create", "read", "update", "delete"],
    user: ["list", "ban", "set-role"],
  },
  roles: {
    viewer: { post: ["read"] },
    admin: "*",  // all permissions
  },
  defaultRole: "viewer",
}
```

### Multi-role

Multiple roles stored as comma-separated string in the same `role` column (`"user,editor"`):

```ts
// Assign multiple roles
POST /api/auth/role
{ userId: "u1", roles: ["user", "editor"] }

// Add a role incrementally
{ userId: "u1", addRole: "editor" }

// Remove a role
{ userId: "u1", removeRole: "admin" }
```

### Role Inheritance

```ts
roles: {
  viewer: { post: ["read"] },
  editor: {
    allow: { post: ["create", "read", "update"] },
    inherits: ["viewer"],  // gets all viewer permissions
  },
  moderator: {
    allow: { user: ["list", "ban"] },
    inherits: ["editor"],  // editor → viewer chain
  },
}
```

### Deny Rules (deny always wins)

```ts
roles: {
  moderator: {
    allow: { user: ["list", "ban", "set-role"] },
    deny: { user: ["set-role"] },  // can ban but can't change roles
  },
  admin: {
    allow: "*",
    deny: { billing: ["manage"] },  // can view but not manage billing
  },
  superadmin: "*",  // unrestricted
}
```

### Server API

```ts
const canEdit = await auth.hasPermission(request, "post:update");
const isAdmin = await auth.hasRole(request, "admin");     // multi-role aware
const roles = await auth.getRoles(request);                // ["user", "editor"]
```

### Client API

```tsx
import { usePermission, useRole } from "@1moby/just-auth/client";

const canEdit = usePermission("post:update");
const isAdmin = useRole("admin");  // works with "user,admin" multi-role
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
import { hashPassword, verifyPassword, resolvePermissions, parseRoles } from "@1moby/just-auth";
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
  RbacConfig, RoleDefinition, SessionContextValue, SessionStatus,
  Queries, TableNames, MigrateOptions,
} from "@1moby/just-auth";
```

## Testing

```bash
bun test  # 285 tests across 17 files
```

## License

MIT
