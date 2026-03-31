import type { RbacConfig, RoleDefinition } from "../types.ts";

/**
 * Parse a role string into an array of roles.
 * Supports comma-separated multi-role: "user,editor" → ["user", "editor"]
 */
export function parseRoles(roleString: string): string[] {
  return roleString.split(",").map((r) => r.trim()).filter(Boolean);
}

/**
 * Check if a role definition is legacy format (Record<string, string[]>)
 * vs new format (RoleDefinition with allow/deny/inherits).
 */
function isLegacyRoleDef(def: Record<string, unknown>): boolean {
  return !("allow" in def || "deny" in def || "inherits" in def);
}

function allPermissions(statements: RbacConfig["statements"]): string[] {
  return Object.entries(statements).flatMap(
    ([resource, actions]) => actions.map((a) => `${resource}:${a}`)
  );
}

function permissionsFromMap(map: Record<string, string[]>): string[] {
  return Object.entries(map).flatMap(
    ([resource, actions]) => actions.map((a) => `${resource}:${a}`)
  );
}

/**
 * Resolve all permissions for a role string (supports comma-separated multi-role).
 * Handles role inheritance (cycle-safe) and deny rules (deny wins over allow).
 */
export function resolvePermissions(roleString: string, rbacConfig: RbacConfig): string[] {
  const roles = parseRoles(roleString);
  const allow = new Set<string>();
  const deny = new Set<string>();

  for (const role of roles) {
    collectPermissions(role, rbacConfig, allow, deny, new Set());
  }

  // Deny wins — remove denied permissions from allow set
  for (const d of deny) {
    allow.delete(d);
  }

  return Array.from(allow);
}

function collectPermissions(
  role: string,
  config: RbacConfig,
  allow: Set<string>,
  deny: Set<string>,
  visited: Set<string>
): void {
  if (visited.has(role)) return; // cycle protection
  visited.add(role);

  const def = config.roles[role];
  if (!def) return;

  // Wildcard: all permissions, no deny
  if (def === "*") {
    for (const p of allPermissions(config.statements)) {
      allow.add(p);
    }
    return;
  }

  // Legacy format: { post: ["read"], user: ["list"] }
  if (isLegacyRoleDef(def as Record<string, unknown>)) {
    for (const p of permissionsFromMap(def as Record<string, string[]>)) {
      allow.add(p);
    }
    return;
  }

  // New format: RoleDefinition
  const roleDef = def as RoleDefinition;

  // Resolve inherited roles first
  if (roleDef.inherits) {
    for (const parent of roleDef.inherits) {
      collectPermissions(parent, config, allow, deny, visited);
    }
  }

  // Collect allow — handle wildcard allow
  if ((roleDef.allow as unknown) === "*") {
    for (const p of allPermissions(config.statements)) {
      allow.add(p);
    }
  } else {
    for (const p of permissionsFromMap(roleDef.allow)) {
      allow.add(p);
    }
  }

  // Collect deny
  if (roleDef.deny) {
    for (const p of permissionsFromMap(roleDef.deny)) {
      deny.add(p);
    }
  }
}
