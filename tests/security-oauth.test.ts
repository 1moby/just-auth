import { describe, it, expect, beforeEach } from "bun:test";
import { createHandlers, type HandlersConfig } from "../src/server/handlers.ts";
import { createSessionManager } from "../src/core/session.ts";
import { resolveCookieConfig } from "../src/core/cookie.ts";
import { createMockDatabase } from "./helpers/mock-db.ts";
import { createQueries } from "../src/db/queries.ts";
import { generateState, generateCodeVerifier, createS256CodeChallenge } from "../src/core/oauth.ts";
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

describe("Security: OAuth", () => {
  let db: ReturnType<typeof createMockDatabase>;
  let cookieConfig: ReturnType<typeof resolveCookieConfig>;
  let sessionManager: ReturnType<typeof createSessionManager>;

  function makeHandlers(overrides?: Partial<HandlersConfig>) {
    return createHandlers({
      providers: new Map([["github", createMockProvider("github")]]),
      sessionManager,
      cookieConfig,
      queries: createQueries(db),
      basePath: "/api/auth",
      sessionMaxAge: 30 * 86400,
      oauthAutoCreateAccount: true,
      ...overrides,
    });
  }

  beforeEach(() => {
    db = createMockDatabase();
    db.tables.set("users", []);
    db.tables.set("accounts", []);
    db.tables.set("sessions", []);
    cookieConfig = resolveCookieConfig({ secure: false });
    sessionManager = createSessionManager(createQueries(db));
  });

  // ── Open Redirect Prevention ──────────────────────────────────────

  describe("Open redirect prevention via onAuthSuccess", () => {
    const maliciousUrls = [
      "https://evil.com",
      "https://evil.com/steal",
      "//evil.com",
      "//evil.com/path",
      "https://legit.com.evil.com",
      "https://legit.com.evil.com/phish",
      "javascript:alert(document.cookie)",
      "javascript:alert(1)//",
      "data:text/html,<script>alert(1)</script>",
      "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
      "https://evil.com%00@localhost",
      " https://evil.com",
      "\thttps://evil.com",
      "https://evil.com\\@localhost",
    ];

    for (const url of maliciousUrls) {
      it(`should reject malicious redirect: ${JSON.stringify(url)}`, async () => {
        const handlers = makeHandlers({
          onAuthSuccess: () => url,
        });

        const req = new Request(
          "http://localhost/api/auth/callback/github?code=abc&state=s1",
          { headers: { cookie: "oauth_state=s1" } }
        );
        const res = await handlers.handleRequest(req);
        const html = await res!.text();
        // Should fall back to "/" — must not contain the malicious domain
        expect(html).not.toContain("evil.com");
      });
    }

    it("should allow safe relative path redirect", async () => {
      const handlers = makeHandlers({
        onAuthSuccess: () => "/dashboard",
      });

      const req = new Request(
        "http://localhost/api/auth/callback/github?code=abc&state=s1",
        { headers: { cookie: "oauth_state=s1" } }
      );
      const res = await handlers.handleRequest(req);
      const html = await res!.text();
      expect(html).toContain("/dashboard");
    });

    it("should allow same-origin absolute redirect", async () => {
      const handlers = makeHandlers({
        onAuthSuccess: () => "http://localhost/dashboard",
      });

      const req = new Request(
        "http://localhost/api/auth/callback/github?code=abc&state=s1",
        { headers: { cookie: "oauth_state=s1" } }
      );
      const res = await handlers.handleRequest(req);
      const html = await res!.text();
      expect(html).toContain("http://localhost/dashboard");
    });
  });

  // ── OAuth State Parameter ─────────────────────────────────────────

  describe("OAuth state parameter", () => {
    it("should generate cryptographically random state (32 bytes, base64url)", () => {
      const state = generateState();
      // 32 bytes → 43 base64url chars (without padding)
      expect(state.length).toBe(43);
      expect(state).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it("should generate unique state per call", () => {
      const states = new Set(Array.from({ length: 100 }, () => generateState()));
      expect(states.size).toBe(100);
    });

    it("should reject callback when state is missing from query", async () => {
      const handlers = makeHandlers();

      const res = await handlers.handleRequest(new Request(
        "http://localhost/api/auth/callback/github?code=abc",
        { headers: { cookie: "oauth_state=some-state" } }
      ));
      expect(res!.status).toBe(400);
      const body = await res!.json() as { error: string };
      expect(body.error).toContain("state");
    });

    it("should reject callback when state cookie is missing", async () => {
      const handlers = makeHandlers();

      const res = await handlers.handleRequest(new Request(
        "http://localhost/api/auth/callback/github?code=abc&state=some-state"
      ));
      expect(res!.status).toBe(400);
    });

    it("should reject callback when state is tampered", async () => {
      const handlers = makeHandlers();

      const res = await handlers.handleRequest(new Request(
        "http://localhost/api/auth/callback/github?code=abc&state=tampered-value",
        { headers: { cookie: "oauth_state=original-value" } }
      ));
      expect(res!.status).toBe(400);
    });

    it("should reject callback when code is missing", async () => {
      const handlers = makeHandlers();

      const res = await handlers.handleRequest(new Request(
        "http://localhost/api/auth/callback/github?state=s1",
        { headers: { cookie: "oauth_state=s1" } }
      ));
      expect(res!.status).toBe(400);
    });

    it("should set state cookie as HttpOnly on login", async () => {
      const handlers = makeHandlers();

      const req = new Request("http://localhost/api/auth/login/github");
      const res = await handlers.handleRequest(req);
      const cookies = res!.headers.getSetCookie();
      const stateCookie = cookies.find((c) => c.startsWith("oauth_state="));
      expect(stateCookie).toBeTruthy();
      expect(stateCookie).toContain("HttpOnly");
    });

    it("should set state cookie with short TTL (10 minutes)", async () => {
      const handlers = makeHandlers();

      const req = new Request("http://localhost/api/auth/login/github");
      const res = await handlers.handleRequest(req);
      const cookies = res!.headers.getSetCookie();
      const stateCookie = cookies.find((c) => c.startsWith("oauth_state="));
      expect(stateCookie).toContain("Max-Age=600");
    });
  });

  // ── PKCE ──────────────────────────────────────────────────────────

  describe("PKCE (Proof Key for Code Exchange)", () => {
    it("should generate code verifier as base64url (32 bytes)", () => {
      const verifier = generateCodeVerifier();
      expect(verifier.length).toBe(43);
      expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it("should create S256 code challenge from verifier", async () => {
      const verifier = generateCodeVerifier();
      const challenge = await createS256CodeChallenge(verifier);
      expect(challenge).toBeTruthy();
      expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
      // Challenge must differ from verifier (it's a hash)
      expect(challenge).not.toBe(verifier);
    });

    it("should produce consistent challenge for same verifier", async () => {
      const verifier = "test-verifier-value-for-consistency";
      const c1 = await createS256CodeChallenge(verifier);
      const c2 = await createS256CodeChallenge(verifier);
      expect(c1).toBe(c2);
    });

    it("should produce different challenges for different verifiers", async () => {
      const v1 = generateCodeVerifier();
      const v2 = generateCodeVerifier();
      const c1 = await createS256CodeChallenge(v1);
      const c2 = await createS256CodeChallenge(v2);
      expect(c1).not.toBe(c2);
    });

    it("GitHub provider should include PKCE params in authorization URL", async () => {
      const { createGitHubProvider } = await import("../src/providers/github.ts");
      const provider = createGitHubProvider({
        clientId: "test-id",
        clientSecret: "test-secret",
        redirectURI: "http://localhost:3000/callback",
      });

      const url = await provider.createAuthorizationURL("test-state");
      expect(url.searchParams.get("code_challenge")).toBeTruthy();
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      expect(provider.codeVerifier).toBeTruthy();
      expect(provider.codeVerifier.length).toBe(43);
    });

    it("Google provider should include PKCE params in authorization URL", async () => {
      const { createGoogleProvider } = await import("../src/providers/google.ts");
      const provider = createGoogleProvider({
        clientId: "test-id",
        clientSecret: "test-secret",
        redirectURI: "http://localhost:3000/callback",
      });

      const url = await provider.createAuthorizationURL("test-state");
      expect(url.searchParams.get("code_challenge")).toBeTruthy();
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      expect(provider.codeVerifier).toBeTruthy();
    });

    it("should store code_verifier cookie on login for PKCE providers", async () => {
      const { createGitHubProvider } = await import("../src/providers/github.ts");
      const provider = createGitHubProvider({
        clientId: "test-id",
        clientSecret: "test-secret",
        redirectURI: "http://localhost:3000/callback",
      });

      const handlers = createHandlers({
        providers: new Map([["github", provider]]),
        sessionManager,
        cookieConfig,
        queries: createQueries(db),
        basePath: "/api/auth",
        sessionMaxAge: 30 * 86400,
        oauthAutoCreateAccount: true,
      });

      const res = await handlers.handleRequest(
        new Request("http://localhost/api/auth/login/github")
      );
      const cookies = res!.headers.getSetCookie();
      const verifierCookie = cookies.find((c) => c.startsWith("code_verifier="));
      expect(verifierCookie).toBeTruthy();
      expect(verifierCookie).toContain("HttpOnly");
    });

    it("should generate fresh code verifier per authorization request", async () => {
      const { createGitHubProvider } = await import("../src/providers/github.ts");
      const provider = createGitHubProvider({
        clientId: "test-id",
        clientSecret: "test-secret",
        redirectURI: "http://localhost:3000/callback",
      });

      await provider.createAuthorizationURL("state1");
      const v1 = provider.codeVerifier;
      await provider.createAuthorizationURL("state2");
      const v2 = provider.codeVerifier;
      expect(v1).not.toBe(v2);
    });
  });
});
