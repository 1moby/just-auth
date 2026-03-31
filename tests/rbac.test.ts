import { describe, it, expect } from "bun:test";
import { resolvePermissions, parseRoles } from "../src/core/rbac.ts";
import type { RbacConfig } from "../src/types.ts";

// Legacy format config (backward-compatible)
const legacyConfig: RbacConfig = {
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

// Full RBAC config with inheritance + deny
const fullConfig: RbacConfig = {
  statements: {
    post: ["create", "read", "update", "delete"],
    user: ["list", "ban", "set-role"],
    billing: ["view", "manage"],
  },
  roles: {
    viewer: { post: ["read"] },
    editor: {
      allow: { post: ["create", "read", "update"] },
      inherits: ["viewer"],
    },
    moderator: {
      allow: { post: ["read", "update", "delete"], user: ["list", "ban"] },
      deny: { user: ["set-role"] },
      inherits: ["editor"],
    },
    admin: {
      allow: "*" as unknown as Record<string, string[]>,
      deny: { billing: ["manage"] },
    },
    superadmin: "*",
  },
  defaultRole: "viewer",
};

describe("parseRoles", () => {
  it("should parse single role", () => {
    expect(parseRoles("user")).toEqual(["user"]);
  });

  it("should parse comma-separated roles", () => {
    expect(parseRoles("user,editor")).toEqual(["user", "editor"]);
  });

  it("should trim whitespace", () => {
    expect(parseRoles("user, editor , admin")).toEqual(["user", "editor", "admin"]);
  });

  it("should filter empty strings", () => {
    expect(parseRoles(",user,,editor,")).toEqual(["user", "editor"]);
  });

  it("should return empty array for empty string", () => {
    expect(parseRoles("")).toEqual([]);
  });
});

describe("resolvePermissions — legacy format", () => {
  it("should resolve basic role permissions", () => {
    const perms = resolvePermissions("user", legacyConfig);
    expect(perms).toEqual(["post:read", "comment:create"]);
  });

  it("should resolve editor role permissions", () => {
    const perms = resolvePermissions("editor", legacyConfig);
    expect(perms).toEqual([
      "post:create", "post:read", "post:update",
      "comment:create", "comment:delete",
    ]);
  });

  it("should expand wildcard admin to all permissions", () => {
    const perms = resolvePermissions("admin", legacyConfig);
    expect(perms).toEqual([
      "post:create", "post:read", "post:update", "post:delete",
      "user:list", "user:ban", "user:set-role",
      "comment:create", "comment:delete",
    ]);
  });

  it("should return empty array for unknown role", () => {
    const perms = resolvePermissions("unknown", legacyConfig);
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

describe("resolvePermissions — multi-role", () => {
  it("should union permissions from multiple roles", () => {
    const perms = resolvePermissions("user,editor", legacyConfig);
    expect(perms).toContain("post:read");
    expect(perms).toContain("post:create");
    expect(perms).toContain("post:update");
    expect(perms).toContain("comment:create");
    expect(perms).toContain("comment:delete");
  });

  it("should deduplicate overlapping permissions", () => {
    const perms = resolvePermissions("user,editor", legacyConfig);
    const readCount = perms.filter((p) => p === "post:read").length;
    expect(readCount).toBe(1);
  });

  it("should handle unknown role in multi-role gracefully", () => {
    const perms = resolvePermissions("user,nonexistent", legacyConfig);
    expect(perms).toEqual(["post:read", "comment:create"]);
  });
});

describe("resolvePermissions — inheritance", () => {
  it("should inherit permissions from parent role", () => {
    const perms = resolvePermissions("editor", fullConfig);
    // editor allows post:create,read,update and inherits viewer (post:read)
    expect(perms).toContain("post:create");
    expect(perms).toContain("post:read");
    expect(perms).toContain("post:update");
  });

  it("should chain inheritance (moderator → editor → viewer)", () => {
    const perms = resolvePermissions("moderator", fullConfig);
    // From moderator's own allow
    expect(perms).toContain("post:delete");
    expect(perms).toContain("user:list");
    expect(perms).toContain("user:ban");
    // From editor inheritance
    expect(perms).toContain("post:create");
    // From viewer inheritance via editor
    expect(perms).toContain("post:read");
  });

  it("should not include denied permissions even from inherited roles", () => {
    const perms = resolvePermissions("moderator", fullConfig);
    expect(perms).not.toContain("user:set-role");
  });
});

describe("resolvePermissions — deny rules", () => {
  it("should remove denied permissions from allow set", () => {
    const perms = resolvePermissions("moderator", fullConfig);
    expect(perms).not.toContain("user:set-role");
    expect(perms).toContain("user:ban"); // allowed, not denied
  });

  it("should deny from wildcard allow", () => {
    const perms = resolvePermissions("admin", fullConfig);
    // admin has allow: "*" but deny: { billing: ["manage"] }
    expect(perms).toContain("billing:view");
    expect(perms).not.toContain("billing:manage");
    expect(perms).toContain("user:set-role");
  });

  it("superadmin wildcard has no deny — gets everything", () => {
    const perms = resolvePermissions("superadmin", fullConfig);
    expect(perms).toContain("billing:manage");
    expect(perms).toContain("user:set-role");
    expect(perms.length).toBe(
      Object.entries(fullConfig.statements).reduce((sum, [, a]) => sum + a.length, 0)
    );
  });
});

describe("resolvePermissions — cycle protection", () => {
  it("should not infinite loop on circular inheritance", () => {
    const cyclicConfig: RbacConfig = {
      statements: { post: ["read"] },
      roles: {
        a: { allow: { post: ["read"] }, inherits: ["b"] },
        b: { allow: {}, inherits: ["a"] },
      },
    };
    const perms = resolvePermissions("a", cyclicConfig);
    expect(perms).toEqual(["post:read"]);
  });

  it("should not infinite loop on self-inheritance", () => {
    const selfConfig: RbacConfig = {
      statements: { post: ["read"] },
      roles: {
        a: { allow: { post: ["read"] }, inherits: ["a"] },
      },
    };
    const perms = resolvePermissions("a", selfConfig);
    expect(perms).toEqual(["post:read"]);
  });
});

describe("resolvePermissions — mixed legacy + new in same config", () => {
  it("should handle legacy and new role definitions together", () => {
    const mixedConfig: RbacConfig = {
      statements: {
        post: ["read", "write"],
        admin: ["access"],
      },
      roles: {
        // Legacy format
        viewer: { post: ["read"] },
        // New format
        writer: {
          allow: { post: ["read", "write"] },
          inherits: ["viewer"],
        },
        // Wildcard
        superadmin: "*",
      },
    };

    expect(resolvePermissions("viewer", mixedConfig)).toEqual(["post:read"]);
    expect(resolvePermissions("writer", mixedConfig)).toContain("post:write");
    expect(resolvePermissions("superadmin", mixedConfig)).toContain("admin:access");
  });
});
