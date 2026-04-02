import { describe, it, expect, beforeEach } from "bun:test";
import { createHandlers, type HandlersConfig } from "../src/server/handlers.ts";
import { createSessionManager } from "../src/core/session.ts";
import { resolveCookieConfig } from "../src/core/cookie.ts";
import { createMockDatabase } from "./helpers/mock-db.ts";
import { createQueries } from "../src/db/queries.ts";
import { verifyPassword } from "../src/core/password.ts";
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

// Provider that throws to test error leaks
function createFailingProvider(id: string): OAuthProvider {
  return {
    id,
    createAuthorizationURL(state: string): URL {
      return new URL(`https://provider.example.com/auth?state=${state}`);
    },
    async validateAuthorizationCode(_code: string): Promise<OAuthTokens> {
      throw new Error("Secret internal token endpoint: https://internal.corp/oauth/token returned 503");
    },
    async getUserProfile(_accessToken: string): Promise<OAuthUserProfile> {
      throw new Error("should not reach here");
    },
  };
}

describe("Security", () => {
  let db: ReturnType<typeof createMockDatabase>;
  let cookieConfig: ReturnType<typeof resolveCookieConfig>;
  let sessionManager: ReturnType<typeof createSessionManager>;

  beforeEach(() => {
    db = createMockDatabase();
    db.tables.set("users", []);
    db.tables.set("accounts", []);
    db.tables.set("sessions", []);
    cookieConfig = resolveCookieConfig({ secure: false });
    sessionManager = createSessionManager(createQueries(db));
  });

  describe("XSS prevention in HTML redirect", () => {
    it("should HTML-escape URLs in redirect page attributes", async () => {
      const handlers = createHandlers({
        providers: new Map([["github", createMockProvider("github")]]),
        sessionManager,
        cookieConfig,
        queries: createQueries(db),
        basePath: "/api/auth",
        sessionMaxAge: 30 * 86400,
        oauthAutoCreateAccount: true,
      });

      const req = new Request("http://localhost/api/auth/login/github");
      const res = await handlers.handleRequest(req);
      const html = await res!.text();

      // Verify that the HTML contains escaped attributes (no raw unescaped special chars in href/content)
      // The URL should be escaped in HTML attribute contexts
      expect(html).toContain("&amp;"); // & in URL params should be escaped in HTML attributes
    });

    it("should include security headers on HTML redirect responses", async () => {
      const handlers = createHandlers({
        providers: new Map([["github", createMockProvider("github")]]),
        sessionManager,
        cookieConfig,
        queries: createQueries(db),
        basePath: "/api/auth",
        sessionMaxAge: 30 * 86400,
        oauthAutoCreateAccount: true,
      });

      const req = new Request("http://localhost/api/auth/login/github");
      const res = await handlers.handleRequest(req);

      expect(res!.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(res!.headers.get("X-Frame-Options")).toBe("DENY");
      expect(res!.headers.get("Referrer-Policy")).toBe("no-referrer");
      expect(res!.headers.get("Cache-Control")).toBe("no-store, no-cache, must-revalidate");
    });

    it("should also include security headers on OAuth callback redirect", async () => {
      const handlers = createHandlers({
        providers: new Map([["github", createMockProvider("github")]]),
        sessionManager,
        cookieConfig,
        queries: createQueries(db),
        basePath: "/api/auth",
        sessionMaxAge: 30 * 86400,
        oauthAutoCreateAccount: true,
      });

      const req = new Request(
        "http://localhost/api/auth/callback/github?code=valid&state=s1",
        { headers: { cookie: "oauth_state=s1" } }
      );
      const res = await handlers.handleRequest(req);

      expect(res!.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(res!.headers.get("X-Frame-Options")).toBe("DENY");
      expect(res!.headers.get("Referrer-Policy")).toBe("no-referrer");
    });
  });

  describe("Timing oracle prevention on credential login", () => {
    it("should still reject non-existent user (runs dummy PBKDF2)", async () => {
      const handlers = createHandlers({
        providers: new Map(),
        sessionManager,
        cookieConfig,
        queries: createQueries(db),
        basePath: "/api/auth",
        sessionMaxAge: 30 * 86400,
        credentials: true,
      });

      const res = await handlers.handleRequest(new Request("http://localhost/api/auth/callback/credentials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "noone@test.com", password: "password123" }),
      }));
      expect(res!.status).toBe(401);
      const body = await res!.json() as { error: string };
      expect(body.error).toBe("Invalid email or password");
    });

    it("should reject wrong password with same error message", async () => {
      const handlers = createHandlers({
        providers: new Map(),
        sessionManager,
        cookieConfig,
        queries: createQueries(db),
        basePath: "/api/auth",
        sessionMaxAge: 30 * 86400,
        credentials: true,
      });

      // Register first
      await handlers.handleRequest(new Request("http://localhost/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "user@test.com", password: "correctpass" }),
      }));

      const res = await handlers.handleRequest(new Request("http://localhost/api/auth/callback/credentials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "user@test.com", password: "wrongpass1" }),
      }));
      expect(res!.status).toBe(401);
      const body = await res!.json() as { error: string };
      expect(body.error).toBe("Invalid email or password");
    });

    it("should verify dummy hash returns false without throwing", async () => {
      // Ensure verifyPassword works with the dummy hash format
      const result = await verifyPassword("anything", "00000000000000000000000000000000:0000000000000000000000000000000000000000000000000000000000000000");
      expect(result).toBe(false);
    });
  });

  describe("Error message information leak prevention", () => {
    it("should not leak internal error details in OAuth callback failure", async () => {
      const handlers = createHandlers({
        providers: new Map([["failing", createFailingProvider("failing")]]),
        sessionManager,
        cookieConfig,
        queries: createQueries(db),
        basePath: "/api/auth",
        sessionMaxAge: 30 * 86400,
        oauthAutoCreateAccount: true,
      });

      const req = new Request(
        "http://localhost/api/auth/callback/failing?code=abc&state=s1",
        { headers: { cookie: "oauth_state=s1" } }
      );
      const res = await handlers.handleRequest(req);
      expect(res!.status).toBe(500);
      const body = await res!.json() as { error: string };
      // Must NOT contain the internal URL or detailed error
      expect(body.error).toBe("Authentication failed");
      expect(body.error).not.toContain("internal.corp");
      expect(body.error).not.toContain("token endpoint");
    });
  });

  describe("OAuth state constant-time comparison", () => {
    it("should reject mismatched state regardless of prefix overlap", async () => {
      const handlers = createHandlers({
        providers: new Map([["github", createMockProvider("github")]]),
        sessionManager,
        cookieConfig,
        queries: createQueries(db),
        basePath: "/api/auth",
        sessionMaxAge: 30 * 86400,
        oauthAutoCreateAccount: true,
      });

      // State values that share a common prefix
      const res = await handlers.handleRequest(new Request(
        "http://localhost/api/auth/callback/github?code=abc&state=AAAA",
        { headers: { cookie: "oauth_state=AAAB" } }
      ));
      expect(res!.status).toBe(400);
    });

    it("should reject when state lengths differ", async () => {
      const handlers = createHandlers({
        providers: new Map([["github", createMockProvider("github")]]),
        sessionManager,
        cookieConfig,
        queries: createQueries(db),
        basePath: "/api/auth",
        sessionMaxAge: 30 * 86400,
        oauthAutoCreateAccount: true,
      });

      const res = await handlers.handleRequest(new Request(
        "http://localhost/api/auth/callback/github?code=abc&state=short",
        { headers: { cookie: "oauth_state=muchlongervalue" } }
      ));
      expect(res!.status).toBe(400);
    });

    it("should accept matching state values", async () => {
      const handlers = createHandlers({
        providers: new Map([["github", createMockProvider("github")]]),
        sessionManager,
        cookieConfig,
        queries: createQueries(db),
        basePath: "/api/auth",
        sessionMaxAge: 30 * 86400,
        oauthAutoCreateAccount: true,
      });

      const res = await handlers.handleRequest(new Request(
        "http://localhost/api/auth/callback/github?code=abc&state=matching",
        { headers: { cookie: "oauth_state=matching" } }
      ));
      // Should succeed (200 HTML redirect)
      expect(res!.status).toBe(200);
    });
  });

  describe("__Host- cookie prefix", () => {
    it("should default cookie name to __Host-auth_session", () => {
      const config = resolveCookieConfig();
      expect(config.name).toBe("__Host-auth_session");
    });

    it("should allow overriding cookie name", () => {
      const config = resolveCookieConfig({ name: "my_session" });
      expect(config.name).toBe("my_session");
    });
  });

  describe("GitHub provider PKCE", () => {
    it("should include PKCE code_challenge in GitHub authorization URL", async () => {
      const { createGitHubProvider } = await import("../src/providers/github.ts");
      const provider = createGitHubProvider({
        clientId: "test-id",
        clientSecret: "test-secret",
        redirectURI: "http://localhost:3000/callback",
      });

      const url = await provider.createAuthorizationURL("test-state");
      expect(url.searchParams.get("code_challenge")).toBeTruthy();
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    });

    it("should expose codeVerifier on GitHub provider", async () => {
      const { createGitHubProvider } = await import("../src/providers/github.ts");
      const provider = createGitHubProvider({
        clientId: "test-id",
        clientSecret: "test-secret",
        redirectURI: "http://localhost:3000/callback",
      });

      await provider.createAuthorizationURL("test-state");
      expect(provider.codeVerifier).toBeTruthy();
      expect(typeof provider.codeVerifier).toBe("string");
      expect(provider.codeVerifier.length).toBeGreaterThan(0);
    });
  });

  describe("Open redirect prevention", () => {
    it("should not redirect to external URL via onAuthSuccess", async () => {
      const handlers = createHandlers({
        providers: new Map([["github", createMockProvider("github")]]),
        sessionManager,
        cookieConfig,
        queries: createQueries(db),
        basePath: "/api/auth",
        sessionMaxAge: 30 * 86400,
        oauthAutoCreateAccount: true,
        onAuthSuccess: () => "https://evil.com/steal",
      });

      const req = new Request(
        "http://localhost/api/auth/callback/github?code=abc&state=s1",
        { headers: { cookie: "oauth_state=s1" } }
      );
      const res = await handlers.handleRequest(req);
      const html = await res!.text();
      // Should fall back to "/" not the evil URL
      expect(html).not.toContain("evil.com");
    });

    it("should reject protocol-relative URLs (//evil.com)", async () => {
      const handlers = createHandlers({
        providers: new Map([["github", createMockProvider("github")]]),
        sessionManager,
        cookieConfig,
        queries: createQueries(db),
        basePath: "/api/auth",
        sessionMaxAge: 30 * 86400,
        oauthAutoCreateAccount: true,
        onAuthSuccess: () => "//evil.com/path",
      });

      const req = new Request(
        "http://localhost/api/auth/callback/github?code=abc&state=s1",
        { headers: { cookie: "oauth_state=s1" } }
      );
      const res = await handlers.handleRequest(req);
      const html = await res!.text();
      expect(html).not.toContain("evil.com");
    });
  });

  describe("Password max length DoS prevention", () => {
    it("should reject passwords exceeding 128 characters", async () => {
      const handlers = createHandlers({
        providers: new Map(),
        sessionManager,
        cookieConfig,
        queries: createQueries(db),
        basePath: "/api/auth",
        sessionMaxAge: 30 * 86400,
        credentials: true,
      });

      const longPassword = "a".repeat(129);
      const res = await handlers.handleRequest(new Request("http://localhost/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "user@test.com", password: longPassword }),
      }));
      expect(res!.status).toBe(400);
      const body = await res!.json() as { error: string };
      expect(body.error).toContain("128");
    });
  });

  describe("Script injection prevention in HTML redirect", () => {
    it("should escape </script> sequences in redirect URLs", async () => {
      const handlers = createHandlers({
        providers: new Map([["github", createMockProvider("github")]]),
        sessionManager,
        cookieConfig,
        queries: createQueries(db),
        basePath: "/api/auth",
        sessionMaxAge: 30 * 86400,
        oauthAutoCreateAccount: true,
        onAuthSuccess: () => "/callback?x=</script><script>alert(1)</script>",
      });

      const req = new Request(
        "http://localhost/api/auth/callback/github?code=abc&state=s1",
        { headers: { cookie: "oauth_state=s1" } }
      );
      const res = await handlers.handleRequest(req);
      const html = await res!.text();
      // The raw </script> must NOT appear in the JS context
      expect(html).not.toContain("</script><script>");
      // The escaped form should be present
      expect(html).toContain("\\u003c");
    });
  });

  describe("CSRF Origin header verification", () => {
    it("should reject POST with cross-origin Origin header", async () => {
      const handlers = createHandlers({
        providers: new Map(),
        sessionManager,
        cookieConfig,
        queries: createQueries(db),
        basePath: "/api/auth",
        sessionMaxAge: 30 * 86400,
        credentials: true,
      });

      const res = await handlers.handleRequest(new Request("http://localhost/api/auth/logout", {
        method: "POST",
        headers: { "Origin": "https://evil.com" },
      }));
      expect(res!.status).toBe(403);
      const body = await res!.json() as { error: string };
      expect(body.error).toContain("CSRF");
    });

    it("should allow POST with same-origin Origin header", async () => {
      const handlers = createHandlers({
        providers: new Map(),
        sessionManager,
        cookieConfig,
        queries: createQueries(db),
        basePath: "/api/auth",
        sessionMaxAge: 30 * 86400,
      });

      const res = await handlers.handleRequest(new Request("http://localhost/api/auth/logout", {
        method: "POST",
        headers: { "Origin": "http://localhost" },
      }));
      expect(res!.status).toBe(200);
    });

    it("should allow POST without Origin header (non-browser client)", async () => {
      const handlers = createHandlers({
        providers: new Map(),
        sessionManager,
        cookieConfig,
        queries: createQueries(db),
        basePath: "/api/auth",
        sessionMaxAge: 30 * 86400,
      });

      const res = await handlers.handleRequest(new Request("http://localhost/api/auth/logout", {
        method: "POST",
      }));
      expect(res!.status).toBe(200);
    });

    it("should reject POST with cross-origin Referer when no Origin", async () => {
      const handlers = createHandlers({
        providers: new Map(),
        sessionManager,
        cookieConfig,
        queries: createQueries(db),
        basePath: "/api/auth",
        sessionMaxAge: 30 * 86400,
      });

      const res = await handlers.handleRequest(new Request("http://localhost/api/auth/logout", {
        method: "POST",
        headers: { "Referer": "https://evil.com/page" },
      }));
      expect(res!.status).toBe(403);
    });
  });

  describe("Content-Security-Policy on HTML redirects", () => {
    it("should include CSP header on login redirect", async () => {
      const handlers = createHandlers({
        providers: new Map([["github", createMockProvider("github")]]),
        sessionManager,
        cookieConfig,
        queries: createQueries(db),
        basePath: "/api/auth",
        sessionMaxAge: 30 * 86400,
        oauthAutoCreateAccount: true,
      });

      const req = new Request("http://localhost/api/auth/login/github");
      const res = await handlers.handleRequest(req);

      const csp = res!.headers.get("Content-Security-Policy");
      expect(csp).toBeTruthy();
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("frame-ancestors 'none'");
    });
  });

  describe("Error message leak prevention in role endpoint", () => {
    it("should not leak internal error details in set-role failure", async () => {
      const handlers = createHandlers({
        providers: new Map(),
        sessionManager,
        cookieConfig,
        queries: createQueries(db),
        basePath: "/api/auth",
        sessionMaxAge: 30 * 86400,
        rbac: {
          statements: { user: ["set-role"] },
          roles: { admin: "*", user: { user: ["set-role"] } },
          defaultRole: "user",
        },
      });

      // Create admin user
      db.tables.set("users", [
        { id: "admin1", email: "admin@test.com", name: "Admin", avatar_url: null, role: "admin" },
      ]);
      const { token } = await sessionManager.createSession("admin1");

      // Try to set role on non-existent user (will cause an internal error)
      const res = await handlers.handleRequest(new Request("http://localhost/api/auth/role", {
        method: "POST",
        headers: {
          cookie: `__Host-auth_session=${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ userId: "nonexistent", addRole: "user" }),
      }));
      // Should return 404 for not found, or 500 with generic message
      if (res!.status === 500) {
        const body = await res!.json() as { error: string };
        expect(body.error).toBe("Failed to set role");
        // Must NOT contain stack traces or internal details
        expect(body.error).not.toContain("TypeError");
        expect(body.error).not.toContain("Cannot read");
      }
    });
  });
});
