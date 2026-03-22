import { describe, it, expect, beforeEach } from "bun:test";
import { createHandlers, type HandlersConfig } from "../src/server/handlers.ts";
import { createSessionManager } from "../src/core/session.ts";
import { resolveCookieConfig, serializeSessionCookie } from "../src/core/cookie.ts";
import { createMockDatabase } from "./helpers/mock-db.ts";
import { createQueries } from "../src/db/queries.ts";
import type { OAuthProvider, OAuthTokens, OAuthUserProfile } from "../src/types.ts";

function createMockProvider(id: string): OAuthProvider {
  return {
    id,
    createAuthorizationURL(state: string): URL {
      return new URL(`https://provider.example.com/auth?state=${state}&client_id=test`);
    },
    async validateAuthorizationCode(_code: string): Promise<OAuthTokens> {
      return { accessToken: "mock-access-token" };
    },
    async getUserProfile(_accessToken: string): Promise<OAuthUserProfile> {
      return {
        id: "provider-user-123",
        email: "user@example.com",
        name: "Test User",
        avatarUrl: "https://example.com/avatar.png",
      };
    },
  };
}

describe("Route Handlers", () => {
  let db: ReturnType<typeof createMockDatabase>;
  let handlers: ReturnType<typeof createHandlers>;
  let cookieConfig: ReturnType<typeof resolveCookieConfig>;
  let sessionManager: ReturnType<typeof createSessionManager>;

  beforeEach(() => {
    db = createMockDatabase();
    db.tables.set("users", []);
    db.tables.set("accounts", []);
    db.tables.set("sessions", []);

    cookieConfig = resolveCookieConfig({ secure: false });
    const queries = createQueries(db);
    sessionManager = createSessionManager(queries);

    const providers = new Map<string, OAuthProvider>();
    providers.set("github", createMockProvider("github"));

    handlers = createHandlers({
      providers,
      sessionManager,
      cookieConfig,
      queries,
      basePath: "/api/auth",
      sessionMaxAge: 30 * 86400,
      oauthAutoCreateAccount: true,
    });
  });

  describe("handleRequest routing", () => {
    it("should return null for non-auth paths", async () => {
      const req = new Request("http://localhost/other/path");
      const res = await handlers.handleRequest(req);
      expect(res).toBeNull();
    });

    it("should handle /api/auth/session", async () => {
      const req = new Request("http://localhost/api/auth/session");
      const res = await handlers.handleRequest(req);
      expect(res).not.toBeNull();
      expect(res!.status).toBe(200);
    });

    it("should handle /api/auth/login/:provider", async () => {
      const req = new Request("http://localhost/api/auth/login/github");
      const res = await handlers.handleRequest(req);
      expect(res).not.toBeNull();
      expect(res!.status).toBe(302);
    });

    it("should handle /api/auth/logout", async () => {
      const req = new Request("http://localhost/api/auth/logout");
      const res = await handlers.handleRequest(req);
      expect(res).not.toBeNull();
      expect(res!.status).toBe(302);
    });
  });

  describe("Login handler", () => {
    it("should redirect to provider authorization URL", async () => {
      const req = new Request("http://localhost/api/auth/login/github");
      const res = await handlers.handleRequest(req);
      expect(res!.status).toBe(302);
      const location = res!.headers.get("location");
      expect(location).toContain("provider.example.com/auth");
    });

    it("should set oauth_state cookie", async () => {
      const req = new Request("http://localhost/api/auth/login/github");
      const res = await handlers.handleRequest(req);
      const cookies = res!.headers.getSetCookie();
      const stateCookie = cookies.find((c) => c.startsWith("oauth_state="));
      expect(stateCookie).toBeTruthy();
      expect(stateCookie).toContain("HttpOnly");
      expect(stateCookie).toContain("Max-Age=600");
    });

    it("should return 404 for unknown provider", async () => {
      const req = new Request("http://localhost/api/auth/login/unknown");
      const res = await handlers.handleRequest(req);
      expect(res!.status).toBe(404);
    });
  });

  describe("Callback handler", () => {
    it("should reject callback without state", async () => {
      const req = new Request(
        "http://localhost/api/auth/callback/github?code=abc"
      );
      const res = await handlers.handleRequest(req);
      expect(res!.status).toBe(400);
    });

    it("should reject callback with mismatched state", async () => {
      const req = new Request(
        "http://localhost/api/auth/callback/github?code=abc&state=wrong",
        { headers: { cookie: "oauth_state=correct" } }
      );
      const res = await handlers.handleRequest(req);
      expect(res!.status).toBe(400);
    });

    it("should successfully handle a valid callback", async () => {
      const req = new Request(
        "http://localhost/api/auth/callback/github?code=valid-code&state=test-state",
        { headers: { cookie: "oauth_state=test-state" } }
      );
      const res = await handlers.handleRequest(req);
      expect(res!.status).toBe(302);
      expect(res!.headers.get("location")).toBe("/");

      // Should have created a user
      const users = db.tables.get("users");
      expect(users).toHaveLength(1);
      expect(users![0]!.email).toBe("user@example.com");

      // Should have created an account
      const accounts = db.tables.get("accounts");
      expect(accounts).toHaveLength(1);
      expect(accounts![0]!.provider_id).toBe("github");

      // Should have created a session
      const sessions = db.tables.get("sessions");
      expect(sessions).toHaveLength(1);

      // Should set session cookie
      const cookies = res!.headers.getSetCookie();
      const sessionCookie = cookies.find((c) => c.startsWith("auth_session="));
      expect(sessionCookie).toBeTruthy();
    });

    it("should reuse existing user on repeat login", async () => {
      // First login
      const req1 = new Request(
        "http://localhost/api/auth/callback/github?code=code1&state=state1",
        { headers: { cookie: "oauth_state=state1" } }
      );
      await handlers.handleRequest(req1);

      // Second login
      const req2 = new Request(
        "http://localhost/api/auth/callback/github?code=code2&state=state2",
        { headers: { cookie: "oauth_state=state2" } }
      );
      await handlers.handleRequest(req2);

      // Should still only have one user
      const users = db.tables.get("users");
      expect(users).toHaveLength(1);

      // But two sessions
      const sessions = db.tables.get("sessions");
      expect(sessions).toHaveLength(2);
    });
  });

  describe("Session handler", () => {
    it("should return null for unauthenticated request", async () => {
      const req = new Request("http://localhost/api/auth/session");
      const res = await handlers.handleRequest(req);
      const body = await res!.json();
      expect(body).toBeNull();
    });

    it("should return user data for authenticated request", async () => {
      // Create user and session
      db.tables.set("users", [
        { id: "u1", email: "alice@example.com", name: "Alice", avatar_url: null },
      ]);
      const { token } = await sessionManager.createSession("u1");

      const req = new Request("http://localhost/api/auth/session", {
        headers: { cookie: `auth_session=${token}` },
      });
      const res = await handlers.handleRequest(req);
      const body = await res!.json();
      expect(body.user.id).toBe("u1");
      expect(body.user.email).toBe("alice@example.com");
    });

    it("should include linked accounts in session response", async () => {
      db.tables.set("users", [
        { id: "u1", email: "alice@example.com", name: "Alice", avatar_url: null },
      ]);
      db.tables.set("accounts", [
        { id: "a1", user_id: "u1", provider_id: "github", provider_user_id: "gh-1", access_token: "t", refresh_token: null, expires_at: null },
        { id: "a2", user_id: "u1", provider_id: "google", provider_user_id: "go-1", access_token: "t", refresh_token: null, expires_at: null },
      ]);
      const { token } = await sessionManager.createSession("u1");

      const req = new Request("http://localhost/api/auth/session", {
        headers: { cookie: `auth_session=${token}` },
      });
      const res = await handlers.handleRequest(req);
      const body = await res!.json();
      expect(body.accounts).toHaveLength(2);
      expect(body.accounts[0].providerId).toBe("github");
      expect(body.accounts[1].providerId).toBe("google");
    });

    it("should clear cookie for expired/invalid session", async () => {
      const req = new Request("http://localhost/api/auth/session", {
        headers: { cookie: "auth_session=invalid-token" },
      });
      const res = await handlers.handleRequest(req);
      const body = await res!.json();
      expect(body).toBeNull();
      const cookies = res!.headers.getSetCookie();
      const clearCookie = cookies.find((c) =>
        c.includes("auth_session=") && c.includes("Max-Age=0")
      );
      expect(clearCookie).toBeTruthy();
    });
  });

  describe("Credentials register", () => {
    it("should register a new user with email+password", async () => {
      const credHandlers = createHandlers({
        providers: new Map([["github", createMockProvider("github")]]),
        sessionManager,
        cookieConfig,
        queries: createQueries(db),
        basePath: "/api/auth",
        sessionMaxAge: 30 * 86400,
        credentials: true,
      });

      const req = new Request("http://localhost/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "new@test.com", password: "secret123", name: "New User" }),
      });
      const res = await credHandlers.handleRequest(req);
      expect(res!.status).toBe(200);
      const body = await res!.json();
      expect(body.user.email).toBe("new@test.com");
      expect(body.user.name).toBe("New User");

      const cookies = res!.headers.getSetCookie();
      expect(cookies.some(c => c.startsWith("auth_session="))).toBe(true);

      expect(db.tables.get("users")).toHaveLength(1);
      const accounts = db.tables.get("accounts")!;
      expect(accounts).toHaveLength(1);
      expect(accounts[0]!.provider_id).toBe("credentials");
    });

    it("should reject registration with existing email", async () => {
      const credHandlers = createHandlers({
        providers: new Map(),
        sessionManager,
        cookieConfig,
        queries: createQueries(db),
        basePath: "/api/auth",
        sessionMaxAge: 30 * 86400,
        credentials: true,
      });

      await credHandlers.handleRequest(new Request("http://localhost/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "dup@test.com", password: "password1" }),
      }));

      const res = await credHandlers.handleRequest(new Request("http://localhost/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "dup@test.com", password: "password2" }),
      }));
      // Generic error to prevent email enumeration (no 409 status)
      expect(res!.status).toBe(400);
    });

    it("should reject registration with invalid email format", async () => {
      const credHandlers = createHandlers({
        providers: new Map(),
        sessionManager,
        cookieConfig,
        queries: createQueries(db),
        basePath: "/api/auth",
        sessionMaxAge: 30 * 86400,
        credentials: true,
      });

      const res = await credHandlers.handleRequest(new Request("http://localhost/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "not-an-email", password: "password123" }),
      }));
      expect(res!.status).toBe(400);
      const body = await res!.json() as { error: string };
      expect(body.error).toBe("Invalid email format");
    });

    it("should not handle register when credentials disabled", async () => {
      const req = new Request("http://localhost/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "a@b.com", password: "password" }),
      });
      const res = await handlers.handleRequest(req);
      expect(res).toBeNull();
    });
  });

  describe("Credentials login", () => {
    it("should login with correct email+password", async () => {
      const credHandlers = createHandlers({
        providers: new Map(),
        sessionManager,
        cookieConfig,
        queries: createQueries(db),
        basePath: "/api/auth",
        sessionMaxAge: 30 * 86400,
        credentials: true,
      });

      await credHandlers.handleRequest(new Request("http://localhost/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "login@test.com", password: "mypassword" }),
      }));

      const res = await credHandlers.handleRequest(new Request("http://localhost/api/auth/callback/credentials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "login@test.com", password: "mypassword" }),
      }));
      expect(res!.status).toBe(200);
      const body = await res!.json();
      expect(body.user.email).toBe("login@test.com");
    });

    it("should reject wrong password", async () => {
      const credHandlers = createHandlers({
        providers: new Map(),
        sessionManager,
        cookieConfig,
        queries: createQueries(db),
        basePath: "/api/auth",
        sessionMaxAge: 30 * 86400,
        credentials: true,
      });

      await credHandlers.handleRequest(new Request("http://localhost/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "user@test.com", password: "correctpassword" }),
      }));

      const res = await credHandlers.handleRequest(new Request("http://localhost/api/auth/callback/credentials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "user@test.com", password: "wrongpassword" }),
      }));
      expect(res!.status).toBe(401);
    });

    it("should reject login for non-existent email", async () => {
      const credHandlers = createHandlers({
        providers: new Map(),
        sessionManager,
        cookieConfig,
        queries: createQueries(db),
        basePath: "/api/auth",
        sessionMaxAge: 30 * 86400,
        credentials: true,
      });

      const res = await credHandlers.handleRequest(new Request("http://localhost/api/auth/callback/credentials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "noone@test.com", password: "password" }),
      }));
      expect(res!.status).toBe(401);
    });
  });

  describe("Account linking by email", () => {
    it("should link OAuth account to existing user with same email when enabled", async () => {
      const providers = new Map([["github", createMockProvider("github")]]);
      const linkingHandlers = createHandlers({
        providers,
        sessionManager,
        cookieConfig,
        queries: createQueries(db),
        basePath: "/api/auth",
        sessionMaxAge: 30 * 86400,
        credentials: true,
        oauthAutoCreateAccount: true,
        allowDangerousEmailAccountLinking: true,
      });

      // Register user with same email that mock provider returns (user@example.com)
      await linkingHandlers.handleRequest(new Request("http://localhost/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "user@example.com", password: "password123" }),
      }));

      // OAuth login with same email
      const res = await linkingHandlers.handleRequest(new Request(
        "http://localhost/api/auth/callback/github?code=abc&state=s1",
        { headers: { cookie: "oauth_state=s1" } }
      ));
      expect(res!.status).toBe(302);

      expect(db.tables.get("users")).toHaveLength(1);
      expect(db.tables.get("accounts")).toHaveLength(2);
    });

    it("should return error when same email exists and linking disabled", async () => {
      const providers = new Map([["github", createMockProvider("github")]]);
      const noLinkHandlers = createHandlers({
        providers,
        sessionManager,
        cookieConfig,
        queries: createQueries(db),
        basePath: "/api/auth",
        sessionMaxAge: 30 * 86400,
        credentials: true,
        oauthAutoCreateAccount: true,
        allowDangerousEmailAccountLinking: false,
      });

      await noLinkHandlers.handleRequest(new Request("http://localhost/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "user@example.com", password: "password123" }),
      }));

      const res = await noLinkHandlers.handleRequest(new Request(
        "http://localhost/api/auth/callback/github?code=abc&state=s1",
        { headers: { cookie: "oauth_state=s1" } }
      ));
      expect(res!.status).toBe(403);
      const body = await res!.json();
      expect(body.error).toContain("OAuthAccountNotLinked");
    });
  });

  describe("Logout handler", () => {
    it("should redirect to / and clear cookie", async () => {
      const req = new Request("http://localhost/api/auth/logout");
      const res = await handlers.handleRequest(req);
      expect(res!.status).toBe(302);
      expect(res!.headers.get("location")).toBe("/");
      const cookies = res!.headers.getSetCookie();
      const clearCookie = cookies.find((c) =>
        c.includes("auth_session=") && c.includes("Max-Age=0")
      );
      expect(clearCookie).toBeTruthy();
    });

    it("should invalidate session on logout", async () => {
      db.tables.set("users", [
        { id: "u1", email: "a@b.com", name: "A", avatar_url: null },
      ]);
      const { token } = await sessionManager.createSession("u1");

      const req = new Request("http://localhost/api/auth/logout", {
        headers: { cookie: `auth_session=${token}` },
      });
      await handlers.handleRequest(req);

      // Session should be gone
      const result = await sessionManager.validateSession(token);
      expect(result).toBeNull();
    });
  });

  describe("RBAC", () => {
    let rbacHandlers: ReturnType<typeof createHandlers>;

    beforeEach(() => {
      const providers = new Map<string, OAuthProvider>();
      providers.set("github", createMockProvider("github"));

      rbacHandlers = createHandlers({
        providers,
        sessionManager,
        cookieConfig,
        queries: createQueries(db),
        basePath: "/api/auth",
        sessionMaxAge: 86400,
        credentials: true,
        oauthAutoCreateAccount: true,
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

  describe("allowedEmails", () => {
    it("should reject OAuth callback when email domain is not allowed", async () => {
      const queries = createQueries(db);
      const providers = new Map<string, OAuthProvider>();
      providers.set("github", createMockProvider("github")); // returns user@example.com

      const restricted = createHandlers({
        providers,
        sessionManager,
        cookieConfig,
        queries,
        basePath: "/api/auth",
        sessionMaxAge: 30 * 86400,
        oauthAutoCreateAccount: true,
        allowedEmails: ["@allowed.com"],
      });

      // Simulate OAuth callback with valid state
      const loginRes = await restricted.handleRequest(
        new Request("http://localhost/api/auth/login/github")
      );
      const stateCookie = loginRes!.headers.get("set-cookie")!;
      const state = stateCookie.match(/oauth_state=([^;]+)/)?.[1];

      const callbackRes = await restricted.handleRequest(
        new Request(`http://localhost/api/auth/callback/github?code=test&state=${state}`, {
          headers: { cookie: `oauth_state=${state}` },
        })
      );
      expect(callbackRes!.status).toBe(403);
      const body = await callbackRes!.json() as { error: string };
      expect(body.error).toBe("EmailNotAllowed");
    });

    it("should allow OAuth callback when email domain matches", async () => {
      const queries = createQueries(db);
      const providers = new Map<string, OAuthProvider>();
      providers.set("github", createMockProvider("github")); // returns user@example.com

      const restricted = createHandlers({
        providers,
        sessionManager,
        cookieConfig,
        queries,
        basePath: "/api/auth",
        sessionMaxAge: 30 * 86400,
        oauthAutoCreateAccount: true,
        allowedEmails: ["@example.com"],
      });

      const loginRes = await restricted.handleRequest(
        new Request("http://localhost/api/auth/login/github")
      );
      const stateCookie = loginRes!.headers.get("set-cookie")!;
      const state = stateCookie.match(/oauth_state=([^;]+)/)?.[1];

      const callbackRes = await restricted.handleRequest(
        new Request(`http://localhost/api/auth/callback/github?code=test&state=${state}`, {
          headers: { cookie: `oauth_state=${state}` },
        })
      );
      expect(callbackRes!.status).toBe(302); // redirect = success
    });

    it("should reject registration when email domain is not allowed", async () => {
      const queries = createQueries(db);
      const restricted = createHandlers({
        providers: new Map(),
        sessionManager,
        cookieConfig,
        queries,
        basePath: "/api/auth",
        sessionMaxAge: 30 * 86400,
        credentials: true,
        allowedEmails: ["@allowed.com"],
      });

      const res = await restricted.handleRequest(new Request("http://localhost/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "user@example.com", password: "password123" }),
      }));
      expect(res!.status).toBe(403);
      const body = await res!.json() as { error: string };
      expect(body.error).toBe("EmailNotAllowed");
    });

    it("should support function-based email validation", async () => {
      const queries = createQueries(db);
      const restricted = createHandlers({
        providers: new Map(),
        sessionManager,
        cookieConfig,
        queries,
        basePath: "/api/auth",
        sessionMaxAge: 30 * 86400,
        credentials: true,
        allowedEmails: (email) => email.endsWith("@1moby.com"),
      });

      const res = await restricted.handleRequest(new Request("http://localhost/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "user@other.com", password: "password123" }),
      }));
      expect(res!.status).toBe(403);
    });
  });
});
