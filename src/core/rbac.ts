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
