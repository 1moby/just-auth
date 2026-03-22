# RBAC Design — Role Column + Code-Defined Permissions

**Date:** 2026-03-05
**Status:** Approved
**Approach:** C — Single `role` column on users, permissions computed from config-defined role→permission mapping

## Research Summary

- **NextAuth**: No built-in RBAC. Pattern is adding `role` to user table, exposing via session callback, checking manually.
- **Better Auth**: Full RBAC plugin — `createAccessControl(statements)`, `ac.newRole()`, `hasPermission()`. Multiple roles as comma-separated string. Default `admin`/`user` roles.
- **Lucia**: No RBAC. Just `getUserAttributes()` to expose custom columns.

Our design takes the best of each: Better Auth's access control API (type-safe statements + roles), NextAuth's simplicity (single column), and Lucia's minimalism (optional, zero overhead when unused).

## Database

One column added to `users` table:

```sql
ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user';
```

- Stored as single string (e.g. `"admin"`)
- Added to `MIGRATIONS` array with "duplicate column" error handling (same pattern as `password_hash`)
- Migration runs automatically when `rbac` config is present — handles enabling RBAC after initial table creation
- No permissions table — permissions resolved from code config at runtime

## Config API

```ts
const auth = createReactAuth({
  // ...existing config...
  rbac: {
    // All possible resources and their actions
    statements: {
      post: ["create", "read", "update", "delete"],
      user: ["list", "ban", "set-role"],
      comment: ["create", "delete"],
    },
    // Role → permission mapping
    roles: {
      user: {
        post: ["read"],
        comment: ["create"],
      },
      editor: {
        post: ["create", "read", "update"],
        comment: ["create", "delete"],
      },
      admin: "*",  // wildcard = all permissions
    },
    // Default role for new users (default: "user")
    defaultRole: "user",
  },
});
```

When `rbac` is omitted: no RBAC features active, no migration runs, no role in session response, zero overhead.

## Types

```ts
// New types
interface RbacStatements {
  [resource: string]: readonly string[];
}

interface RbacRolePermissions {
  [resource: string]: string[];
}

interface RbacConfig {
  statements: RbacStatements;
  roles: Record<string, RbacRolePermissions | "*">;
  defaultRole?: string; // default: "user"
}

// Updated types
interface AuthConfig {
  // ...existing...
  rbac?: RbacConfig;
}

interface User {
  id: string;
  email: string | null;
  name: string | null;
  avatarUrl: string | null;
  role?: string;  // present when rbac enabled
}

interface SessionContextValue {
  data: (SessionValidationResult & {
    accounts?: { providerId: string }[];
    permissions?: string[];  // present when rbac enabled
  }) | null;
  status: SessionStatus;
  update(): Promise<void>;
}
```

## Permission Resolution

```ts
// src/core/rbac.ts
function resolvePermissions(role: string, rbacConfig: RbacConfig): string[] {
  const roleDef = rbacConfig.roles[role];
  if (!roleDef) return [];
  if (roleDef === "*") {
    // Expand wildcard to all resource:action pairs
    return Object.entries(rbacConfig.statements).flatMap(
      ([resource, actions]) => actions.map(a => `${resource}:${a}`)
    );
  }
  return Object.entries(roleDef).flatMap(
    ([resource, actions]) => actions.map(a => `${resource}:${a}`)
  );
}
```

## Server API

```ts
// auth(request) returns role when rbac enabled
const session = await auth.auth(request);
// session.user.role = "editor"

// New helpers on AuthInstance
const canEdit = await auth.hasPermission(request, "post:update");  // boolean
const isAdmin = await auth.hasRole(request, "admin");              // boolean
```

Implementation: `hasPermission` and `hasRole` call `auth(request)` internally, resolve permissions from role, check.

## Session Endpoint Changes

`GET /api/auth/session` response when RBAC enabled:

```json
{
  "user": { "id": "...", "email": "...", "name": "...", "avatarUrl": null, "role": "editor" },
  "session": { "expiresAt": "..." },
  "accounts": [{ "providerId": "google" }],
  "permissions": ["post:create", "post:read", "post:update", "comment:create", "comment:delete"]
}
```

## Admin Route

| Route | Method | Description |
|-------|--------|-------------|
| `POST /api/auth/role` | POST | Set a user's role (requires `user:set-role` permission) |

Request body: `{ "userId": "target-user-id", "role": "editor" }`

- Validates the role exists in `rbac.roles`
- Requires the caller to have `user:set-role` permission
- Returns updated user object

## Client API

Session context already carries `permissions` array:

```tsx
const { data } = useSession();
// data.user.role = "editor"
// data.permissions = ["post:create", ...]
```

New `usePermission` hook:

```tsx
import { usePermission } from "react-auth/client";

function PostEditor() {
  const canEdit = usePermission("post:update");
  if (!canEdit) return <p>Access denied</p>;
  return <Editor />;
}
```

New `useRole` hook:

```tsx
import { useRole } from "react-auth/client";

function AdminPanel() {
  const isAdmin = useRole("admin");
  if (!isAdmin) return null;
  return <AdminDashboard />;
}
```

## Migration Strategy

Added to `MIGRATIONS` array (same pattern as `password_hash`):

```ts
const MIGRATIONS = [
  `ALTER TABLE users ADD COLUMN password_hash TEXT`,
  `ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'`,
];
```

- Uses existing "duplicate column" error suppression
- Existing users get `role = 'user'` (the DEFAULT)
- Works when RBAC is enabled after initial table creation — `migrate()` always runs all migrations, idempotently
- First admin must be set via SQL or `POST /api/auth/role` (bootstrap documented)

## Query Changes

```ts
// Updated: getUserByEmail, getUserById, getSessionAndUser — include role column
// New: updateUserRole(db, userId, role)
```

The `role` column is always in the schema (after migration), but only exposed in User type and session response when `rbac` config is present.

## Wiring

- `createReactAuth()` passes `rbac` config to `createHandlers()`
- `createHandlers()` uses `rbac` to:
  - Include role/permissions in session response
  - Gate `POST /api/auth/role` route
  - Set `defaultRole` on new user creation (register + OAuth callback)
- `AuthInstance` gets new `hasPermission()` and `hasRole()` methods
- Client exports `usePermission` and `useRole` hooks

## Files Changed

| File | Changes |
|------|---------|
| `src/core/rbac.ts` | NEW — `resolvePermissions()` |
| `src/types.ts` | Add `RbacConfig`, `role` to User, `permissions` to SessionContextValue, `rbac` to AuthConfig, `hasPermission`/`hasRole` to AuthInstance |
| `src/db/schema.sql` | Add `role` column |
| `src/db/migrate.ts` | Add role migration to MIGRATIONS |
| `src/db/queries.ts` | Update user queries to include `role`, add `updateUserRole()` |
| `src/server/handlers.ts` | Add `POST /api/auth/role`, include role/permissions in session, set defaultRole on user creation |
| `src/index.ts` | Wire `rbac` config, add `hasPermission`/`hasRole` to AuthInstance, export rbac utils |
| `src/client/session-context.tsx` | Store `permissions` from session |
| `src/client/hooks.ts` | NEW — `usePermission()`, `useRole()` |
| `src/client/index.ts` | Export new hooks |
| `tests/rbac.test.ts` | NEW — resolvePermissions tests |
| `tests/handlers.test.ts` | Add role/permissions session tests, role endpoint tests |
| `sample-auth/worker.ts` | Add rbac config |
| `sample-auth/pages/dashboard.tsx` | Show role + permissions |
