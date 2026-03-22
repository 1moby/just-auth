import { describe, it, expect } from "bun:test";
import { createAuthMiddleware } from "../src/middleware/index.ts";
import type { AuthInstance, SessionValidationResult } from "../src/types.ts";

function createMockAuth(options: {
  session?: SessionValidationResult | null;
  permissions?: string[];
}): AuthInstance {
  return {
    async auth() {
      return options.session ?? null;
    },
    async handleRequest() {
      return null;
    },
    providers: new Map(),
    sessionManager: {} as AuthInstance["sessionManager"],
    async hasPermission(_req: Request, permission: string) {
      return options.permissions?.includes(permission) ?? false;
    },
    async hasRole(_req: Request, role: string) {
      return options.session?.user.role === role;
    },
  };
}

const mockSession: SessionValidationResult = {
  session: { id: "s1", userId: "u1", expiresAt: new Date(Date.now() + 86400000) },
  user: { id: "u1", email: "user@test.com", name: "Test", avatarUrl: null, role: "user" },
};

describe("createAuthMiddleware", () => {
  it("should skip static files", async () => {
    const auth = createMockAuth({ session: null });
    const { handle } = createAuthMiddleware(auth);

    const res = await handle(new Request("http://localhost/app.js"));
    expect(res).toBeNull();
  });

  it("should skip public paths", async () => {
    const auth = createMockAuth({ session: null });
    const { handle } = createAuthMiddleware(auth, {
      publicPaths: ["/login", "/about"],
    });

    expect(await handle(new Request("http://localhost/login"))).toBeNull();
    expect(await handle(new Request("http://localhost/about"))).toBeNull();
  });

  it("should skip public paths with wildcard", async () => {
    const auth = createMockAuth({ session: null });
    const { handle } = createAuthMiddleware(auth, {
      publicPaths: ["/public/*"],
    });

    expect(await handle(new Request("http://localhost/public/page"))).toBeNull();
    expect(await handle(new Request("http://localhost/public/nested/deep"))).toBeNull();
  });

  it("should redirect unauthenticated users to login", async () => {
    const auth = createMockAuth({ session: null });
    const { handle } = createAuthMiddleware(auth, {
      loginRedirect: "/signin",
    });

    const res = await handle(new Request("http://localhost/dashboard"));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(302);
    expect(res!.headers.get("Location")).toBe("/signin");
  });

  it("should default loginRedirect to /login", async () => {
    const auth = createMockAuth({ session: null });
    const { handle } = createAuthMiddleware(auth);

    const res = await handle(new Request("http://localhost/dashboard"));
    expect(res!.headers.get("Location")).toBe("/login");
  });

  it("should allow authenticated users without route permissions", async () => {
    const auth = createMockAuth({ session: mockSession });
    const { handle } = createAuthMiddleware(auth);

    const res = await handle(new Request("http://localhost/dashboard"));
    expect(res).toBeNull();
  });

  it("should check route permissions and allow if authorized", async () => {
    const auth = createMockAuth({
      session: mockSession,
      permissions: ["admin:access"],
    });
    const { handle } = createAuthMiddleware(auth, {
      routePermissions: { "/admin/*": "admin:access" },
    });

    const res = await handle(new Request("http://localhost/admin/users"));
    expect(res).toBeNull();
  });

  it("should deny access when missing required permission", async () => {
    const auth = createMockAuth({
      session: mockSession,
      permissions: [],
    });
    const { handle } = createAuthMiddleware(auth, {
      routePermissions: { "/admin/*": "admin:access" },
    });

    const res = await handle(new Request("http://localhost/admin/users"));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
    const body = await res!.json() as { error: string };
    expect(body.error).toBe("Forbidden");
  });

  it("should use custom onForbidden handler", async () => {
    const auth = createMockAuth({
      session: mockSession,
      permissions: [],
    });
    const { handle } = createAuthMiddleware(auth, {
      routePermissions: { "/admin/*": "admin:access" },
      onForbidden: () => new Response("No way", { status: 403 }),
    });

    const res = await handle(new Request("http://localhost/admin/settings"));
    expect(res!.status).toBe(403);
    expect(await res!.text()).toBe("No way");
  });

  it("should match exact route permissions", async () => {
    const auth = createMockAuth({
      session: mockSession,
      permissions: [],
    });
    const { handle } = createAuthMiddleware(auth, {
      routePermissions: { "/admin": "admin:access" },
    });

    // Exact match should be denied
    const res1 = await handle(new Request("http://localhost/admin"));
    expect(res1!.status).toBe(403);

    // Non-matching path should pass
    const res2 = await handle(new Request("http://localhost/admin/other"));
    expect(res2).toBeNull();
  });

  it("should handle multiple route permission patterns", async () => {
    const auth = createMockAuth({
      session: mockSession,
      permissions: ["dashboard:view"],
    });
    const { handle } = createAuthMiddleware(auth, {
      routePermissions: {
        "/admin/*": "admin:access",
        "/dashboard/*": "dashboard:view",
      },
    });

    // Has dashboard:view but not admin:access
    const res1 = await handle(new Request("http://localhost/dashboard/stats"));
    expect(res1).toBeNull();

    const res2 = await handle(new Request("http://localhost/admin/users"));
    expect(res2!.status).toBe(403);
  });
});
