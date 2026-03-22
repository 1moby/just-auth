# RBAC Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add optional RBAC (role column + code-defined permissions) to react-auth, with server helpers, client hooks, admin endpoint, and sample app integration.

**Architecture:** Single `role TEXT DEFAULT 'user'` column on users table. Permissions defined in config as role→resource:action mappings, resolved at runtime. No new tables. Fully optional — zero overhead when `rbac` config omitted. Migration is idempotent (handles enabling RBAC after initial setup).

**Tech Stack:** TypeScript, bun:test, React hooks, raw SQL (D1-compatible)

---

### Task 1: Core RBAC — Types + resolvePermissions

**Files:**
- Modify: `src/types.ts:77-93` (AuthConfig, AuthInstance, User, SessionContextValue)
- Create: `src/core/rbac.ts`
- Test: `tests/rbac.test.ts`

**Step 1: Write failing tests for resolvePermissions**

Create `tests/rbac.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { resolvePermissions } from "../src/core/rbac.ts";
import type { RbacConfig } from "../src/types.ts";

const rbacConfig: RbacConfig = {
  statements: {
    post: ["create", "read", "update", "delete"],
    user: ["list", "ban", "set-role"],
    comment: ["create", "delete"],
  },
  roles: {
    user: {
      post: ["read"],
      comment: ["create"],
    },
    editor: {
      post: ["create", "read", "update"],
      comment: ["create", "delete"],
    },
    admin: "*",
  },
  defaultRole: "user",
};

describe("resolvePermissions", () => {
  it("should resolve basic role permissions", () => {
    const perms = resolvePermissions("user", rbacConfig);
    expect(perms).toEqual(["post:read", "comment:create"]);
  });

  it("should resolve editor role permissions", () => {
    const perms = resolvePermissions("editor", rbacConfig);
    expect(perms).toEqual([
      "post:create", "post:read", "post:update",
      "comment:create", "comment:delete",
    ]);
  });

  it("should expand wildcard admin to all permissions", () => {
    const perms = resolvePermissions("admin", rbacConfig);
    expect(perms).toEqual([
      "post:create", "post:read", "post:update", "post:delete",
      "user:list", "user:ban", "user:set-role",
      "comment:create", "comment:delete",
    ]);
  });

  it("should return empty array for unknown role", () => {
    const perms = resolvePermissions("unknown", rbacConfig);
    expect(perms).toEqual([]);
  });

  it("should handle role with empty permissions", () => {
    const config: RbacConfig = {
      statements: { post: ["read"] },
      roles: { viewer: {} },
    };
    const perms = resolvePermissions("viewer", config);
    expect(perms).toEqual([]);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test tests/rbac.test.ts`
Expected: FAIL — cannot find `resolvePermissions` or `RbacConfig`

**Step 3: Add RBAC types to `src/types.ts`**

Add before `AuthConfig` (around line 77):

```ts
export interface RbacConfig {
  statements: Record<string, readonly string[]>;
  roles: Record<string, Record<string, string[]> | "*">;
  defaultRole?: string;
}
```

Add `rbac?: RbacConfig` to `AuthConfig` (line 85):

```ts
export interface AuthConfig {
  // ...existing fields...
  rbac?: RbacConfig;
}
```

Add `role?: string` to `User` interface (line 5):

```ts
export interface User {
  id: string;
  email: string | null;
  name: string | null;
  avatarUrl: string | null;
  role?: string;
}
```

Add `hasPermission` and `hasRole` to `AuthInstance` (line 92):

```ts
export interface AuthInstance {
  auth(request: Request): Promise<SessionValidationResult | null>;
  handleRequest(request: Request): Promise<Response>;
  providers: Map<string, OAuthProvider>;
  sessionManager: SessionManager;
  hasPermission(request: Request, permission: string): Promise<boolean>;
  hasRole(request: Request, role: string): Promise<boolean>;
}
```

Update `SessionContextValue` to include `permissions` (line 105):

```ts
export interface SessionContextValue {
  data: (SessionValidationResult & {
    accounts?: { providerId: string }[];
    permissions?: string[];
  }) | null;
  status: SessionStatus;
  update(): Promise<void>;
}
```

**Step 4: Create `src/core/rbac.ts`**

```ts
import type { RbacConfig } from "../types.ts";

export function resolvePermissions(role: string, rbacConfig: RbacConfig): string[] {
  const roleDef = rbacConfig.roles[role];
  if (!roleDef) return [];
  if (roleDef === "*") {
    return Object.entries(rbacConfig.statements).flatMap(
      ([resource, actions]) => actions.map((a) => `${resource}:${a}`)
    );
  }
  return Object.entries(roleDef).flatMap(
    ([resource, actions]) => actions.map((a) => `${resource}:${a}`)
  );
}
```

**Step 5: Run tests to verify they pass**

Run: `bun test tests/rbac.test.ts`
Expected: 5 pass

**Step 6: Run full test suite to verify no regressions**

Run: `bun test`
Expected: All 110+ tests pass

---

### Task 2: Database — Schema, Migration, Queries

**Files:**
- Modify: `src/db/schema.sql:1-7`
- Modify: `src/db/migrate.ts:32-34`
- Modify: `src/db/queries.ts:9-14,38-45,55-64,90-96,98-106,207-232`
- Test: `tests/queries.test.ts` (add tests)
- Test: `tests/migrate.test.ts` (add test)

**Step 1: Write failing tests**

Add to `tests/queries.test.ts`:

```ts
it("should update user role", async () => {
  await createUser(db, { id: "u1", email: "a@b.com", name: "A", avatarUrl: null });
  await updateUserRole(db, "u1", "admin");
  const user = await getUserById(db, "u1");
  expect(user?.role).toBe("admin");
});
```

Add to `tests/migrate.test.ts`:

```ts
it("should include role column migration in MIGRATIONS", () => {
  const hasRoleMigration = MIGRATIONS.some((m) => m.includes("role"));
  expect(hasRoleMigration).toBe(true);
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test tests/queries.test.ts tests/migrate.test.ts`
Expected: FAIL — `updateUserRole` not found, role migration not found

**Step 3: Update `src/db/schema.sql`**

Add `role` column after `password_hash` (line 6):

```sql
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE,
  name TEXT,
  avatar_url TEXT,
  password_hash TEXT,
  role TEXT NOT NULL DEFAULT 'user'
);
```

**Step 4: Update `src/db/migrate.ts`**

Add to SCHEMA_STATEMENTS — add `role TEXT NOT NULL DEFAULT 'user'` after `password_hash TEXT` in the CREATE TABLE users statement (line 9).

Add to MIGRATIONS array (line 33):

```ts
const MIGRATIONS = [
  `ALTER TABLE users ADD COLUMN password_hash TEXT`,
  `ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'`,
];
```

**Step 5: Update `src/db/queries.ts`**

Add `role` to `UserRow` interface (line 9):

```ts
interface UserRow {
  id: string;
  email: string | null;
  name: string | null;
  avatar_url: string | null;
  role?: string;
}
```

Update `rowToUser` to include role (line 38):

```ts
function rowToUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    avatarUrl: row.avatar_url,
    role: row.role,
  };
}
```

Update `SessionWithUserRow` to include role (line 32):

```ts
interface SessionWithUserRow extends SessionRow {
  user_email: string | null;
  user_name: string | null;
  user_avatar_url: string | null;
  user_role?: string;
}
```

Update `getSessionAndUser` SQL to select `u.role as user_role` (line 213), and include role in the returned user object (line 229):

```ts
export async function getSessionAndUser(
  db: DatabaseAdapter,
  sessionId: string
): Promise<SessionValidationResult | null> {
  const row = await db
    .prepare(
      `SELECT s.id, s.user_id, s.expires_at, u.email as user_email, u.name as user_name, u.avatar_url as user_avatar_url, u.role as user_role
       FROM sessions s
       INNER JOIN users u ON u.id = s.user_id
       WHERE s.id = ?`
    )
    .bind(sessionId)
    .first<SessionWithUserRow>();

  if (!row) return null;

  return {
    session: rowToSession(row),
    user: {
      id: row.user_id,
      email: row.user_email,
      name: row.user_name,
      avatarUrl: row.user_avatar_url,
      role: row.user_role,
    },
  };
}
```

Update `createUser` to accept optional role and include in INSERT (line 55-64, 90-96):

```ts
export function createUserQuery(
  db: DatabaseAdapter,
  user: { id: string; email: string | null; name: string | null; avatarUrl: string | null; role?: string }
) {
  if (user.role) {
    return db
      .prepare("INSERT INTO users (id, email, name, avatar_url, role) VALUES (?, ?, ?, ?, ?)")
      .bind(user.id, user.email, user.name, user.avatarUrl, user.role);
  }
  return db
    .prepare("INSERT INTO users (id, email, name, avatar_url) VALUES (?, ?, ?, ?)")
    .bind(user.id, user.email, user.name, user.avatarUrl);
}

export async function createUser(
  db: DatabaseAdapter,
  user: { id: string; email: string | null; name: string | null; avatarUrl: string | null; role?: string }
): Promise<User> {
  await createUserQuery(db, user).run();
  return { id: user.id, email: user.email, name: user.name, avatarUrl: user.avatarUrl, role: user.role };
}
```

Update `createUserWithPassword` to accept optional role (line 98-106):

```ts
export async function createUserWithPassword(
  db: DatabaseAdapter,
  user: { id: string; email: string; name: string | null; avatarUrl: string | null; passwordHash: string; role?: string }
): Promise<void> {
  if (user.role) {
    await db
      .prepare("INSERT INTO users (id, email, name, avatar_url, password_hash, role) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(user.id, user.email, user.name, user.avatarUrl, user.passwordHash, user.role)
      .run();
  } else {
    await db
      .prepare("INSERT INTO users (id, email, name, avatar_url, password_hash) VALUES (?, ?, ?, ?, ?)")
      .bind(user.id, user.email, user.name, user.avatarUrl, user.passwordHash)
      .run();
  }
}
```

Add new `updateUserRole` function:

```ts
export async function updateUserRole(
  db: DatabaseAdapter,
  userId: string,
  role: string
): Promise<void> {
  await db
    .prepare("UPDATE users SET role = ? WHERE id = ?")
    .bind(role, userId)
    .run();
}
```

**Step 6: Update mock-db session-user join to include role**

In `tests/helpers/mock-db.ts`, update the session-user join result (line 153-162) to include `user_role`:

```ts
return [
  {
    id: session.id,
    user_id: session.user_id,
    expires_at: session.expires_at,
    user_email: user.email,
    user_name: user.name,
    user_avatar_url: user.avatar_url,
    user_role: user.role,
  },
];
```

**Step 7: Run tests to verify they pass**

Run: `bun test`
Expected: All tests pass (112+)

---

### Task 3: Server Handlers — Session with RBAC + Role Endpoint

**Files:**
- Modify: `src/server/handlers.ts:33-54,64-96,196-214,244-274`
- Test: `tests/handlers.test.ts`

**Step 1: Write failing tests**

Add to `tests/handlers.test.ts`:

```ts
describe("RBAC", () => {
  let rbacHandlers: ReturnType<typeof createHandlers>;

  beforeEach(() => {
    const providers = new Map<string, OAuthProvider>();
    providers.set("github", createMockProvider("github"));

    rbacHandlers = createHandlers({
      providers,
      sessionManager,
      cookieConfig,
      database: db,
      basePath: "/api/auth",
      sessionMaxAge: 86400,
      credentials: true,
      allowDangerousEmailAccountLinking: true,
      rbac: {
        statements: {
          post: ["create", "read", "update", "delete"],
          user: ["list", "set-role"],
        },
        roles: {
          user: { post: ["read"] },
          admin: "*",
        },
        defaultRole: "user",
      },
    });
  });

  it("should include role and permissions in session response", async () => {
    db.tables.set("users", [
      { id: "u1", email: "a@b.com", name: "A", avatar_url: null, role: "admin" },
    ]);
    db.tables.set("accounts", []);
    const { token } = await sessionManager.createSession("u1");
    const req = new Request("http://localhost/api/auth/session", {
      headers: { cookie: `auth_session=${token}` },
    });
    const res = await rbacHandlers.handleRequest(req);
    const body = await res!.json();
    expect(body.user.role).toBe("admin");
    expect(body.permissions).toContain("post:create");
    expect(body.permissions).toContain("user:set-role");
  });

  it("should not include permissions when rbac is not configured", async () => {
    db.tables.set("users", [
      { id: "u1", email: "a@b.com", name: "A", avatar_url: null },
    ]);
    db.tables.set("accounts", []);
    const { token } = await sessionManager.createSession("u1");
    const req = new Request("http://localhost/api/auth/session", {
      headers: { cookie: `auth_session=${token}` },
    });
    const res = await handlers.handleRequest(req);
    const body = await res!.json();
    expect(body.permissions).toBeUndefined();
  });

  it("should allow admin to set user role via POST /api/auth/role", async () => {
    db.tables.set("users", [
      { id: "admin1", email: "admin@b.com", name: "Admin", avatar_url: null, role: "admin" },
      { id: "u2", email: "user@b.com", name: "User", avatar_url: null, role: "user" },
    ]);
    db.tables.set("accounts", []);
    const { token } = await sessionManager.createSession("admin1");
    const req = new Request("http://localhost/api/auth/role", {
      method: "POST",
      headers: {
        cookie: `auth_session=${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ userId: "u2", role: "admin" }),
    });
    const res = await rbacHandlers.handleRequest(req);
    expect(res!.status).toBe(200);
    const body = await res!.json();
    expect(body.user.role).toBe("admin");
  });

  it("should reject role change from user without set-role permission", async () => {
    db.tables.set("users", [
      { id: "u1", email: "a@b.com", name: "A", avatar_url: null, role: "user" },
      { id: "u2", email: "b@b.com", name: "B", avatar_url: null, role: "user" },
    ]);
    db.tables.set("accounts", []);
    const { token } = await sessionManager.createSession("u1");
    const req = new Request("http://localhost/api/auth/role", {
      method: "POST",
      headers: {
        cookie: `auth_session=${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ userId: "u2", role: "admin" }),
    });
    const res = await rbacHandlers.handleRequest(req);
    expect(res!.status).toBe(403);
  });

  it("should reject invalid role name", async () => {
    db.tables.set("users", [
      { id: "admin1", email: "admin@b.com", name: "Admin", avatar_url: null, role: "admin" },
      { id: "u2", email: "user@b.com", name: "User", avatar_url: null, role: "user" },
    ]);
    db.tables.set("accounts", []);
    const { token } = await sessionManager.createSession("admin1");
    const req = new Request("http://localhost/api/auth/role", {
      method: "POST",
      headers: {
        cookie: `auth_session=${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ userId: "u2", role: "superadmin" }),
    });
    const res = await rbacHandlers.handleRequest(req);
    expect(res!.status).toBe(400);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test tests/handlers.test.ts`
Expected: FAIL — `rbac` not in HandlersConfig

**Step 3: Update `src/server/handlers.ts`**

Add import for rbac and updateUserRole:

```ts
import { resolvePermissions } from "../core/rbac.ts";
import { updateUserRole } from "../db/queries.ts";
import type { RbacConfig } from "../types.ts";
```

Add `rbac` to `HandlersConfig` (line 41):

```ts
export interface HandlersConfig {
  // ...existing...
  rbac?: RbacConfig;
}
```

Add `POST /api/auth/role` route in `handleRequest` (after credentials login, before login match):

```ts
// POST /api/auth/role (requires rbac + user:set-role permission)
if (subPath === "/role" && request.method === "POST" && config.rbac) {
  return handleSetRole(request);
}
```

Update `handleSession` to include role/permissions when rbac is configured. After the accounts line:

```ts
const responseData: Record<string, unknown> = {
  user: result.user,
  session: { expiresAt: result.session.expiresAt },
  accounts: accountList,
};

if (config.rbac && result.user.role) {
  responseData.permissions = resolvePermissions(result.user.role, config.rbac);
}

return new Response(JSON.stringify(responseData), {
  status: 200,
  headers: { "Content-Type": "application/json" },
});
```

Update `handleCallback` new user creation to set defaultRole when rbac configured. In the `if (!user)` block where new user is created (line 196-204):

```ts
const defaultRole = config.rbac?.defaultRole ?? "user";
user = {
  id: userId,
  email: profile.email,
  name: profile.name,
  avatarUrl: profile.avatarUrl,
  role: config.rbac ? defaultRole : undefined,
};
await createUser(database, user);
```

Update `handleRegister` to set defaultRole. In user creation (line 316):

```ts
const defaultRole = config.rbac?.defaultRole ?? "user";
const user = { id: userId, email, name: name ?? null, avatarUrl: null, role: config.rbac ? defaultRole : undefined };
```

Add `handleSetRole` function:

```ts
async function handleSetRole(request: Request): Promise<Response> {
  const cookieHeader = request.headers.get("cookie");
  const token = parseSessionCookie(cookieConfig, cookieHeader);
  if (!token) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const session = await sessionManager.validateSession(token);
  if (!session) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Check caller has user:set-role permission
  const callerPerms = resolvePermissions(session.user.role ?? "user", config.rbac!);
  if (!callerPerms.includes("user:set-role")) {
    return new Response(JSON.stringify({ error: "Forbidden" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const body = await request.json() as { userId?: string; role?: string };
    if (!body.userId || !body.role) {
      return new Response(
        JSON.stringify({ error: "userId and role are required" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // Validate role exists in config
    if (!config.rbac!.roles[body.role]) {
      return new Response(
        JSON.stringify({ error: `Invalid role: ${body.role}` }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    await updateUserRole(database, body.userId, body.role);

    return new Response(
      JSON.stringify({ user: { id: body.userId, role: body.role } }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to set role";
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `bun test`
Expected: All tests pass (117+)

---

### Task 4: Wire RBAC through createReactAuth + hasPermission/hasRole

**Files:**
- Modify: `src/index.ts:6-28`
- Test: `tests/handlers.test.ts` (already covered by Task 3 tests)

**Step 1: Update `src/index.ts`**

Add import:

```ts
import { resolvePermissions } from "./core/rbac.ts";
```

Pass `rbac` to createHandlers (around line 18):

```ts
const { handleRequest } = createHandlers({
  // ...existing...
  rbac: config.rbac,
});
```

Add `hasPermission` and `hasRole` methods to the returned object (around line 22):

```ts
async function hasPermission(request: Request, permission: string): Promise<boolean> {
  if (!config.rbac) return false;
  const session = await auth(request);
  if (!session?.user.role) return false;
  const perms = resolvePermissions(session.user.role, config.rbac);
  return perms.includes(permission);
}

async function hasRole(request: Request, role: string): Promise<boolean> {
  const session = await auth(request);
  return session?.user.role === role;
}

return {
  auth,
  handleRequest,
  providers: providerMap,
  sessionManager,
  hasPermission,
  hasRole,
};
```

Export `resolvePermissions` and `RbacConfig` type:

```ts
export { resolvePermissions } from "./core/rbac.ts";
export type { RbacConfig } from "./types.ts";
```

**Step 2: Run tests to verify no regressions**

Run: `bun test`
Expected: All tests pass

---

### Task 5: Client — usePermission + useRole hooks

**Files:**
- Create: `src/client/hooks.ts`
- Modify: `src/client/session-context.tsx:41`
- Modify: `src/client/index.ts`

**Step 1: Create `src/client/hooks.ts`**

```ts
"use client";

import { useSession } from "./session-context.tsx";

export function usePermission(permission: string): boolean {
  const { data } = useSession();
  return data?.permissions?.includes(permission) ?? false;
}

export function useRole(role: string): boolean {
  const { data } = useSession();
  return data?.user?.role === role;
}
```

**Step 2: Update `src/client/session-context.tsx`**

Line 41 — already stores `accounts` from json, add `permissions`:

```ts
setData({ user: json.user, session: json.session, accounts: json.accounts, permissions: json.permissions });
```

**Step 3: Update `src/client/index.ts`**

Add exports:

```ts
export { usePermission, useRole } from "./hooks.ts";
```

**Step 4: Run tests to verify no regressions**

Run: `bun test`
Expected: All tests pass

---

### Task 6: Sample App — Add RBAC config, show role/permissions

**Files:**
- Modify: `sample-auth/worker.ts:58-77`
- Modify: `sample-auth/pages/dashboard.tsx:30-40`

**Step 1: Add rbac config to `sample-auth/worker.ts`**

After `allowDangerousEmailAccountLinking: true,` (line 76), add:

```ts
rbac: {
  statements: {
    post: ["create", "read", "update", "delete"],
    user: ["list", "ban", "set-role"],
  },
  roles: {
    user: {
      post: ["read"],
    },
    admin: "*",
  },
  defaultRole: "user",
},
```

**Step 2: Add hasPermission example to /api/me route**

Update the `/api/me` handler (line 86-98):

```ts
if (url.pathname === "/api/me") {
  const session = await auth.auth(request);
  if (!session) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const canManageUsers = await auth.hasPermission(request, "user:set-role");
  return Response.json({
    user: session.user,
    session: {
      id: session.session.id,
      expiresAt: session.session.expiresAt,
    },
    canManageUsers,
  });
}
```

**Step 3: Show role and permissions on dashboard**

In `sample-auth/pages/dashboard.tsx`, after the Session Info section (around line 40), add:

```tsx
<div className="divider" />

<h3>RBAC</h3>
<p>
  Role: <code>{user.role ?? "none"}</code>
</p>
{data.permissions && data.permissions.length > 0 && (
  <>
    <p>Permissions:</p>
    <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
      {data.permissions.map((p, i) => (
        <li key={i} style={{ padding: "2px 0" }}>
          <code>{p}</code>
        </li>
      ))}
    </ul>
  </>
)}
```

**Step 4: Build and verify**

Run: `cd sample-auth && bun run build.ts`
Expected: Build succeeds

---

### Task 7: Documentation + Final Tests

**Files:**
- Modify: `CLAUDE.md`
- Modify: `README.md`

**Step 1: Update CLAUDE.md**

- Add `src/core/rbac.ts` to Project Structure
- Add RBAC routes to Auth Routes section
- Add `rbac` config description to Database section
- Update test count
- Add `hasPermission`, `hasRole`, `resolvePermissions` to Package Exports

**Step 2: Update README.md**

- Add RBAC section (section 7) after Account Linking section
- Update auth routes table with `POST /api/auth/role`
- Update schema diagram to include `role` column
- Update SQL in schema section
- Add `usePermission`, `useRole` to exports section
- Update test count

**Step 3: Run full test suite**

Run: `bun test`
Expected: All tests pass (117+)

**Step 4: Build sample app**

Run: `cd sample-auth && bun run build.ts`
Expected: Build succeeds

---

Plan complete and saved to `docs/plans/2026-03-05-rbac-implementation.md`. Two execution options:

**1. Subagent-Driven (this session)** - I dispatch fresh subagent per task, review between tasks, fast iteration

**2. Parallel Session (separate)** - Open new session with executing-plans, batch execution with checkpoints

Which approach?
