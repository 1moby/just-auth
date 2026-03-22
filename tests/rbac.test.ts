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
