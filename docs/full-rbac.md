# Full RBAC Design — @1moby/just-auth

## Current State

**Single role per user** stored as `role VARCHAR(50) DEFAULT 'user'`. Permissions resolved at runtime from code config via `resolvePermissions(role, rbacConfig)`. No database tables for roles/permissions — everything is config-driven.

```ts
rbac: {
  statements: { post: ["create", "read", "update", "delete"] },
  roles: {
    user: { post: ["read"] },
    admin: "*",
  },
  defaultRole: "user",
}
```

**Limitations:**
- Single role per user — no multi-role
- No role inheritance — admin doesn't inherit user permissions unless explicitly listed
- No deny rules — everything is allow-only
- No dynamic roles — can't create roles at runtime (only in code config)

## Design Goals

1. Support **multiple roles per user** without breaking the existing `VARCHAR(50)` column
2. Add **role inheritance** so admin automatically gets all user permissions
3. Add **optional deny rules** for security-sensitive exclusions
4. Keep it **backward-compatible** — existing single-role setups work unchanged
5. Keep it **minimal** — no new database tables, permissions stay in code config
6. Keep it **performant** — resolve permissions from in-memory config, no extra DB queries

## Research Summary

| Library | Role Storage | Multi-Role | Inheritance | Deny Rules |
|---------|-------------|------------|-------------|------------|
| Better Auth | Comma-separated VARCHAR | Yes | No | No |
| Casbin | Separate policy table | Yes | Yes (transitive) | Yes |
| CASL | Not stored (code-only) | N/A | N/A | Yes (`cannot`) |
| AWS IAM | Attached policy docs | Yes | Via groups | Yes (deny wins) |
| Oso/Polar | Separate policy language | Yes | Yes (role-implies-role) | No (allow-only) |

**Best fit for just-auth:** Better Auth's comma-separated approach for storage + Oso's role inheritance + AWS IAM's deny-wins for security.

## Proposed Design

### 1. Multi-Role via Comma-Separated String

Store multiple roles in the existing `role VARCHAR(50)` column as comma-separated values:

```
"user"              ← single role (backward-compatible)
"user,editor"       ← multi-role
"admin"             ← single role with wildcard
```

**No schema change required.** Existing single-role values work as-is.

> **Important:** If the user needs more than ~50 chars of comma-separated roles, they should increase the column width: `ALTER TABLE users ALTER COLUMN role TYPE VARCHAR(255)`. The library should document this but not enforce it — SQLite ignores VARCHAR length anyway.

### 2. Updated RbacConfig

```ts
interface RbacConfig {
  statements: Record<string, readonly string[]>;
  roles: Record<string, RoleDefinition | "*">;
  defaultRole?: string;
}

interface RoleDefinition {
  // Permissions this role grants (same as current)
  allow: Record<string, string[]>;
  // Optional: permissions this role explicitly denies (deny wins over allow)
  deny?: Record<string, string[]>;
  // Optional: inherit all permissions from these roles
  inherits?: string[];
}
```

**Backward-compatible:** Current `Record<string, string[]>` format (without `allow`/`deny`/`inherits` keys) is detected and treated as `{ allow: <the object> }`.

Example:

```ts
rbac: {
  statements: {
    post: ["create", "read", "update", "delete"],
    user: ["list", "ban", "set-role"],
    billing: ["view", "manage"],
  },
  roles: {
    // Simple format (backward-compatible)
    viewer: { post: ["read"] },

    // Full format with inheritance
    editor: {
      allow: { post: ["create", "read", "update"] },
      inherits: ["viewer"],
    },

    // Full format with deny
    moderator: {
      allow: { post: ["read", "update", "delete"], user: ["list", "ban"] },
      deny: { user: ["set-role"] },  // can ban but can't change roles
      inherits: ["editor"],
    },

    // Wildcard with deny
    admin: {
      allow: "*",
      deny: { billing: ["manage"] },  // admin can view billing but not manage
    },

    // Superadmin — unrestricted
    superadmin: "*",
  },
  defaultRole: "viewer",
}
```

### 3. Permission Resolution Algorithm

```
resolvePermissions(roleString, rbacConfig) → string[]

1. Split roleString by comma: ["user", "editor"]
2. For each role, collect permissions (with inheritance, cycle-safe):
   a. If role === "*" → all permissions from statements
   b. If role has `inherits` → recursively resolve inherited roles (track visited to prevent cycles)
   c. Collect `allow` permissions
   d. Collect `deny` permissions
3. Union all `allow` permissions across all roles
4. Subtract all `deny` permissions (deny wins over allow from any role)
5. Return final permission set
```

**Deny always wins.** If any role (even an inherited one) denies a permission, it's removed from the final set regardless of other roles allowing it. This matches AWS IAM's explicit-deny-wins model.

### 4. Multi-Role Assignment

Update `POST /api/auth/role` to support adding/removing roles:

```ts
// Set exact roles (replaces all)
POST /api/auth/role
{ userId: "u1", role: "editor" }              // single role
{ userId: "u1", role: "user,editor" }         // multi-role
{ userId: "u1", roles: ["user", "editor"] }   // array format (joined to comma-separated)

// Add a role (keeps existing)
POST /api/auth/role
{ userId: "u1", addRole: "editor" }

// Remove a role
POST /api/auth/role
{ userId: "u1", removeRole: "admin" }
```

The handler validates all role names exist in config before saving.

### 5. Client API Updates

```tsx
// Existing (unchanged)
const canEdit = usePermission("post:update");   // checks resolved permissions
const isAdmin = useRole("admin");               // checks if user has "admin" role

// useRole now checks against comma-separated roles
// "user,editor" → useRole("editor") returns true
```

### 6. Server API Updates

```ts
// Existing (unchanged behavior, now multi-role aware)
const canEdit = await auth.hasPermission(request, "post:update");
const isAdmin = await auth.hasRole(request, "admin");

// New: get all roles for a user
const roles = await auth.getRoles(request); // ["user", "editor"]
```

## Migration Path

### Existing users (single role)

**No changes needed.** Single-role strings like `"user"` or `"admin"` work exactly as before:
- `resolvePermissions("user", config)` → same result as current
- `useRole("user")` → still returns true
- No schema migration required

### Upgrading to multi-role

1. Update `RbacConfig` to use new format (old format still works)
2. Use `POST /api/auth/role` with `addRole`/`removeRole` or comma-separated string
3. Optionally increase column width if many roles: `ALTER TABLE users ALTER COLUMN role TYPE VARCHAR(255)`

### Detecting legacy vs new format

In `resolvePermissions()`:

```ts
function isLegacyRoleDefinition(def: unknown): def is Record<string, string[]> {
  // Legacy format: { post: ["read"], user: ["list"] }
  // New format has "allow", "deny", or "inherits" keys
  if (typeof def !== "object" || def === null) return false;
  return !("allow" in def || "deny" in def || "inherits" in def);
}
```

If all keys in the role definition are resource names (matching `statements` keys), it's legacy format. If it has `allow`/`deny`/`inherits`, it's new format.

## Implementation Plan

### Task 1: Update `resolvePermissions()` in `src/core/rbac.ts`
- Parse comma-separated role strings
- Support `RoleDefinition` with `allow`/`deny`/`inherits`
- Auto-detect legacy format
- Cycle-safe inheritance resolution
- Deny-wins subtraction

### Task 2: Update `RbacConfig` type in `src/types.ts`
- Add `RoleDefinition` interface
- Keep backward-compatible with `Record<string, string[]> | "*"`

### Task 3: Update `handleSetRole` in `src/server/handlers.ts`
- Support `roles: string[]` array format
- Support `addRole` / `removeRole` operations
- Validate all role names against config

### Task 4: Update client hooks in `src/client/hooks.ts`
- `useRole()` checks against comma-separated roles

### Task 5: Update `hasRole()` in `src/index.ts`
- Parse comma-separated roles from user

### Task 6: Add `getRoles()` to `AuthInstance`
- Returns parsed role array from session

### Task 7: Tests
- Multi-role resolution
- Role inheritance (single + multi-level)
- Deny rules (deny wins over allow)
- Cycle detection in inheritance
- Legacy format backward compatibility
- `addRole`/`removeRole` endpoint
- `useRole` with multi-role strings

### Task 8: Update docs
- Update `docs/rbac.md` with full RBAC examples
- Update `README.md` RBAC section
- Update `CLAUDE.md`

## Scope Boundaries

**In scope:**
- Multi-role via comma-separated string
- Role inheritance
- Deny rules (deny wins)
- Add/remove role API
- Backward-compatible with current single-role setup

**Out of scope (future):**
- Resource-scoped roles (e.g., admin of project X but viewer of project Y)
- Runtime role/permission creation (stored in DB instead of code)
- Separate roles/permissions database tables
- Organization/team-level RBAC
- Permission conditions/filters (CASL-style `can('read', 'Post', { author: userId })`)
