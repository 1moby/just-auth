import { describe, it, expect, beforeEach } from "bun:test";
import { createReactAuth } from "../src/index.ts";
import { createMockDatabase } from "./helpers/mock-db.ts";
import type { OAuthProvider, OAuthTokens, OAuthUserProfile } from "../src/types.ts";

function createMockProvider(id: string): OAuthProvider {
  return {
    id,
    createAuthorizationURL(state: string): URL {
      return new URL(`https://auth.example.com/?state=${state}`);
    },
    async validateAuthorizationCode(_code: string): Promise<OAuthTokens> {
      return { accessToken: "token" };
    },
    async getUserProfile(_accessToken: string): Promise<OAuthUserProfile> {
      return { id: "p1", email: "test@test.com", name: "Test", avatarUrl: null };
    },
  };
}

describe("createReactAuth", () => {
  let db: ReturnType<typeof createMockDatabase>;

  beforeEach(() => {
    db = createMockDatabase();
    db.tables.set("users", []);
    db.tables.set("accounts", []);
    db.tables.set("sessions", []);
  });

  it("should create an auth instance with all required methods", () => {
    const auth = createReactAuth({
      providers: [createMockProvider("github")],
      database: db,
    });

    expect(typeof auth.auth).toBe("function");
    expect(typeof auth.handleRequest).toBe("function");
    expect(auth.providers).toBeInstanceOf(Map);
    expect(auth.sessionManager).toBeDefined();
  });

  it("should register providers correctly", () => {
    const auth = createReactAuth({
      providers: [createMockProvider("github"), createMockProvider("google")],
      database: db,
    });

    expect(auth.providers.size).toBe(2);
    expect(auth.providers.has("github")).toBe(true);
    expect(auth.providers.has("google")).toBe(true);
  });

  describe("auth() function", () => {
    it("should return null for unauthenticated request", async () => {
      const authInstance = createReactAuth({
        providers: [createMockProvider("github")],
        database: db,
      });

      const req = new Request("http://localhost/");
      const result = await authInstance.auth(req);
      expect(result).toBeNull();
    });

    it("should return session data for authenticated request", async () => {
      const authInstance = createReactAuth({
        providers: [createMockProvider("github")],
        database: db,
      });

      // Seed user and create session
      db.tables.set("users", [
        { id: "u1", email: "test@example.com", name: "Test", avatar_url: null },
      ]);
      const { token } = await authInstance.sessionManager.createSession("u1");

      const req = new Request("http://localhost/", {
        headers: { cookie: `auth_session=${token}` },
      });
      const result = await authInstance.auth(req);
      expect(result).not.toBeNull();
      expect(result!.user.id).toBe("u1");
      expect(result!.user.email).toBe("test@example.com");
    });

    it("should return null for invalid session token", async () => {
      const authInstance = createReactAuth({
        providers: [createMockProvider("github")],
        database: db,
      });

      const req = new Request("http://localhost/", {
        headers: { cookie: "auth_session=bad-token" },
      });
      const result = await authInstance.auth(req);
      expect(result).toBeNull();
    });
  });

  describe("handleRequest()", () => {
    it("should return null for non-auth routes", async () => {
      const authInstance = createReactAuth({
        providers: [createMockProvider("github")],
        database: db,
      });

      const req = new Request("http://localhost/page");
      const res = await authInstance.handleRequest(req);
      expect(res).toBeNull();
    });

    it("should handle session endpoint", async () => {
      const authInstance = createReactAuth({
        providers: [createMockProvider("github")],
        database: db,
      });

      const req = new Request("http://localhost/api/auth/session");
      const res = await authInstance.handleRequest(req);
      expect(res).not.toBeNull();
      expect(res!.status).toBe(200);
    });

    it("should use custom basePath", async () => {
      const authInstance = createReactAuth({
        providers: [createMockProvider("github")],
        database: db,
        basePath: "/auth",
      });

      // Default path should not match
      const req1 = new Request("http://localhost/api/auth/session");
      const res1 = await authInstance.handleRequest(req1);
      expect(res1).toBeNull();

      // Custom path should match
      const req2 = new Request("http://localhost/auth/session");
      const res2 = await authInstance.handleRequest(req2);
      expect(res2).not.toBeNull();
    });
  });

  describe("Full OAuth flow integration", () => {
    it("should complete login → callback → session → logout flow", async () => {
      const authInstance = createReactAuth({
        providers: [createMockProvider("github")],
        database: db,
        cookie: { secure: false },
        oauthAutoCreateAccount: true,
      });

      // Step 1: Login redirect
      const loginReq = new Request("http://localhost/api/auth/login/github");
      const loginRes = await authInstance.handleRequest(loginReq);
      expect(loginRes!.status).toBe(302);
      const location = loginRes!.headers.get("location");
      expect(location).toContain("auth.example.com");

      // Extract state from cookie
      const stateCookies = loginRes!.headers.getSetCookie();
      const stateCookie = stateCookies.find((c) => c.startsWith("oauth_state="));
      const stateValue = stateCookie!.split("=")[1]!.split(";")[0]!;

      // Step 2: Callback with code and state
      const callbackReq = new Request(
        `http://localhost/api/auth/callback/github?code=auth-code&state=${stateValue}`,
        { headers: { cookie: `oauth_state=${stateValue}` } }
      );
      const callbackRes = await authInstance.handleRequest(callbackReq);
      expect(callbackRes!.status).toBe(302);

      // Extract session cookie
      const sessionCookies = callbackRes!.headers.getSetCookie();
      const sessionCookie = sessionCookies.find((c) => c.startsWith("auth_session="));
      expect(sessionCookie).toBeTruthy();
      const sessionToken = sessionCookie!.split("=")[1]!.split(";")[0]!;

      // Step 3: Session check
      const sessionReq = new Request("http://localhost/api/auth/session", {
        headers: { cookie: `auth_session=${sessionToken}` },
      });
      const sessionRes = await authInstance.handleRequest(sessionReq);
      const sessionData = await sessionRes!.json();
      expect(sessionData.user.email).toBe("test@test.com");
      expect(sessionData.user.name).toBe("Test");

      // Step 4: auth() function
      const authReq = new Request("http://localhost/protected", {
        headers: { cookie: `auth_session=${sessionToken}` },
      });
      const authResult = await authInstance.auth(authReq);
      expect(authResult).not.toBeNull();
      expect(authResult!.user.email).toBe("test@test.com");

      // Step 5: Logout
      const logoutReq = new Request("http://localhost/api/auth/logout", {
        headers: { cookie: `auth_session=${sessionToken}` },
      });
      const logoutRes = await authInstance.handleRequest(logoutReq);
      expect(logoutRes!.status).toBe(302);

      // Step 6: Session should be invalid after logout
      const postLogoutReq = new Request("http://localhost/api/auth/session", {
        headers: { cookie: `auth_session=${sessionToken}` },
      });
      const postLogoutRes = await authInstance.handleRequest(postLogoutReq);
      const postLogoutData = await postLogoutRes!.json();
      expect(postLogoutData).toBeNull();
    });
  });
});
