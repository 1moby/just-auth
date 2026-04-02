import { describe, it, expect, beforeEach } from "bun:test";
import { createHandlers } from "../src/server/handlers.ts";
import { createSessionManager, generateSessionToken, hashToken } from "../src/core/session.ts";
import { resolveCookieConfig, serializeSessionCookie, serializeStateCookie } from "../src/core/cookie.ts";
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
        avatarUrl: null,
      };
    },
  };
}

describe("Security: Session Management", () => {
  let db: ReturnType<typeof createMockDatabase>;

  beforeEach(() => {
    db = createMockDatabase();
    db.tables.set("users", []);
    db.tables.set("accounts", []);
    db.tables.set("sessions", []);
  });

  // ── Cookie Security Attributes ────────────────────────────────────

  describe("Cookie security attributes", () => {
    it("should set HttpOnly on session cookie", () => {
      const config = resolveCookieConfig({ secure: false });
      const cookie = serializeSessionCookie(config, "token123", 86400);
      expect(cookie).toContain("HttpOnly");
    });

    it("should set Secure flag when secure=true (production)", () => {
      const config = resolveCookieConfig({ secure: true });
      const cookie = serializeSessionCookie(config, "token123", 86400);
      expect(cookie).toContain("Secure");
    });

    it("should NOT set Secure flag when secure=false (development)", () => {
      const config = resolveCookieConfig({ secure: false });
      const cookie = serializeSessionCookie(config, "token123", 86400);
      expect(cookie).not.toContain("Secure");
    });

    it("should default to Secure=true", () => {
      const config = resolveCookieConfig();
      const cookie = serializeSessionCookie(config, "token123", 86400);
      expect(cookie).toContain("Secure");
    });

    it("should set SameSite=Lax by default", () => {
      const config = resolveCookieConfig();
      const cookie = serializeSessionCookie(config, "token123", 86400);
      expect(cookie).toContain("SameSite=Lax");
    });

    it("should support SameSite=Strict", () => {
      const config = resolveCookieConfig({ sameSite: "strict" });
      const cookie = serializeSessionCookie(config, "token123", 86400);
      expect(cookie).toContain("SameSite=Strict");
    });

    it("should use __Host- prefix by default for cookie binding", () => {
      const config = resolveCookieConfig();
      expect(config.name).toBe("__Host-auth_session");
      const cookie = serializeSessionCookie(config, "token123", 86400);
      expect(cookie).toStartWith("__Host-auth_session=");
    });

    it("should set HttpOnly on state cookies", () => {
      const config = resolveCookieConfig({ secure: false });
      const cookie = serializeStateCookie("oauth_state", "state-val", config);
      expect(cookie).toContain("HttpOnly");
    });

    it("should set Path=/ on session cookie", () => {
      const config = resolveCookieConfig();
      const cookie = serializeSessionCookie(config, "token123", 86400);
      expect(cookie).toContain("Path=/");
    });
  });

  // ── Session Token Generation ──────────────────────────────────────

  describe("Session token generation", () => {
    it("should generate 256-bit (32-byte) random tokens", () => {
      const token = generateSessionToken();
      // 32 bytes → 43 base64url chars
      expect(token.length).toBe(43);
      expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it("should generate unique tokens", () => {
      const tokens = new Set(Array.from({ length: 100 }, () => generateSessionToken()));
      expect(tokens.size).toBe(100);
    });

    it("should store SHA-256 hash of token, not the token itself", async () => {
      const queries = createQueries(db);
      const manager = createSessionManager(queries);
      const { session, token } = await manager.createSession("user-1");

      // The session ID in DB is a hash of the token
      const expectedHash = await hashToken(token);
      expect(session.id).toBe(expectedHash);

      // Token and session ID must be different (hash ≠ raw)
      expect(token).not.toBe(session.id);
    });
  });

  // ── Session ID Changes After Login ────────────────────────────────

  describe("Session ID rotation", () => {
    it("should issue new session token on each login", async () => {
      const cookieConfig = resolveCookieConfig({ secure: false });
      const queries = createQueries(db);
      const sessionManager = createSessionManager(queries);

      const handlers = createHandlers({
        providers: new Map(),
        sessionManager,
        cookieConfig,
        queries,
        basePath: "/api/auth",
        sessionMaxAge: 30 * 86400,
        credentials: true,
      });

      // Register
      await handlers.handleRequest(new Request("http://localhost/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "user@test.com", password: "password123" }),
      }));

      // Login twice and verify different tokens
      const login1 = await handlers.handleRequest(new Request("http://localhost/api/auth/callback/credentials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "user@test.com", password: "password123" }),
      }));

      const login2 = await handlers.handleRequest(new Request("http://localhost/api/auth/callback/credentials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "user@test.com", password: "password123" }),
      }));

      const getCookieToken = (res: Response) => {
        const cookie = res.headers.getSetCookie().find((c) => c.includes("auth_session="));
        return cookie?.match(/auth_session=([^;]+)/)?.[1];
      };

      const token1 = getCookieToken(login1!);
      const token2 = getCookieToken(login2!);
      expect(token1).toBeTruthy();
      expect(token2).toBeTruthy();
      expect(token1).not.toBe(token2);
    });
  });

  // ── Expired Session Rejection ─────────────────────────────────────

  describe("Expired session rejection", () => {
    it("should reject expired session even if cookie is present", async () => {
      const cookieConfig = resolveCookieConfig({ secure: false });
      const queries = createQueries(db);
      // Create session manager with very short maxAge (1 second)
      const sessionManager = createSessionManager(queries, { maxAge: 1, refreshThreshold: 0 });

      db.tables.set("users", [
        { id: "u1", email: "user@test.com", name: "Test", avatar_url: null, role: null },
      ]);

      const { token } = await sessionManager.createSession("u1");

      // Wait for session to expire
      await new Promise((resolve) => setTimeout(resolve, 1100));

      const handlers = createHandlers({
        providers: new Map(),
        sessionManager,
        cookieConfig,
        queries,
        basePath: "/api/auth",
        sessionMaxAge: 1,
      });

      const res = await handlers.handleRequest(new Request("http://localhost/api/auth/session", {
        headers: { cookie: `__Host-auth_session=${token}` },
      }));
      const body = await res!.json();
      expect(body).toBeNull();
    });

    it("should return valid session before expiry", async () => {
      const cookieConfig = resolveCookieConfig({ secure: false });
      const queries = createQueries(db);
      const sessionManager = createSessionManager(queries, { maxAge: 3600 });

      db.tables.set("users", [
        { id: "u1", email: "user@test.com", name: "Test", avatar_url: null, role: null },
      ]);

      const { token } = await sessionManager.createSession("u1");

      const handlers = createHandlers({
        providers: new Map(),
        sessionManager,
        cookieConfig,
        queries,
        basePath: "/api/auth",
        sessionMaxAge: 3600,
      });

      const res = await handlers.handleRequest(new Request("http://localhost/api/auth/session", {
        headers: { cookie: `__Host-auth_session=${token}` },
      }));
      const body = await res!.json() as { user: { id: string } };
      expect(body.user.id).toBe("u1");
    });
  });

  // ── Sliding Window ────────────────────────────────────────────────

  describe("Sliding window session extension", () => {
    it("should extend session when within refresh threshold", async () => {
      const queries = createQueries(db);
      // maxAge=30s, refreshThreshold=20s → extends if <20s remaining
      const sessionManager = createSessionManager(queries, { maxAge: 30, refreshThreshold: 20 });

      db.tables.set("users", [
        { id: "u1", email: "user@test.com", name: "Test", avatar_url: null, role: null },
      ]);

      const { session, token } = await sessionManager.createSession("u1");
      const originalExpiry = session.expiresAt.getTime();

      // Manually set session to expire in 10 seconds (within threshold)
      const sessionRow = db.tables.get("sessions")![0]!;
      sessionRow.expires_at = Date.now() + 10_000;

      const result = await sessionManager.validateSession(token);
      expect(result).toBeTruthy();
      // New expiry should be ~30s from now (extended)
      expect(result!.session.expiresAt.getTime()).toBeGreaterThan(Date.now() + 25_000);
    });
  });

  // ── Session Invalidation ──────────────────────────────────────────

  describe("Session invalidation on logout", () => {
    it("should invalidate session server-side on logout", async () => {
      const cookieConfig = resolveCookieConfig({ secure: false });
      const queries = createQueries(db);
      const sessionManager = createSessionManager(queries);

      db.tables.set("users", [
        { id: "u1", email: "user@test.com", name: "Test", avatar_url: null, role: null },
      ]);

      const { token } = await sessionManager.createSession("u1");

      const handlers = createHandlers({
        providers: new Map(),
        sessionManager,
        cookieConfig,
        queries,
        basePath: "/api/auth",
        sessionMaxAge: 30 * 86400,
      });

      // Logout
      await handlers.handleRequest(new Request("http://localhost/api/auth/logout", {
        method: "POST",
        headers: { cookie: `__Host-auth_session=${token}` },
      }));

      // Try to use the same token — should be invalid
      const res = await handlers.handleRequest(new Request("http://localhost/api/auth/session", {
        headers: { cookie: `__Host-auth_session=${token}` },
      }));
      const body = await res!.json();
      expect(body).toBeNull();
    });

    it("should clear session cookie on logout", async () => {
      const cookieConfig = resolveCookieConfig({ secure: false });
      const queries = createQueries(db);
      const sessionManager = createSessionManager(queries);

      const handlers = createHandlers({
        providers: new Map(),
        sessionManager,
        cookieConfig,
        queries,
        basePath: "/api/auth",
        sessionMaxAge: 30 * 86400,
      });

      const res = await handlers.handleRequest(new Request("http://localhost/api/auth/logout", {
        method: "POST",
      }));

      const cookies = res!.headers.getSetCookie();
      const clearCookie = cookies.find((c) => c.includes("auth_session="));
      expect(clearCookie).toBeTruthy();
      expect(clearCookie).toContain("Max-Age=0");
    });
  });
});
