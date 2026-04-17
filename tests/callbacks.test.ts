import { describe, it, expect, beforeEach } from "bun:test";
import { createHandlers } from "../src/server/handlers.ts";
import { createSessionManager } from "../src/core/session.ts";
import { resolveCookieConfig } from "../src/core/cookie.ts";
import { createMockDatabase } from "./helpers/mock-db.ts";
import { createQueries } from "../src/db/queries.ts";
import type { OAuthProvider, OAuthTokens, OAuthUserProfile, AuthCallbacks, SignInCallbackContext } from "../src/types.ts";

function createMockProvider(id: string): OAuthProvider {
  return {
    id,
    createAuthorizationURL(state: string): URL {
      return new URL(`https://p.example.com/auth?state=${state}`);
    },
    async validateAuthorizationCode(_code: string): Promise<OAuthTokens> {
      return { accessToken: "mock-token", refreshToken: "mock-refresh", expiresAt: 1234 };
    },
    async getUserProfile(_t: string): Promise<OAuthUserProfile> {
      return { id: "p-123", email: "user@example.com", name: "Test", avatarUrl: "https://example.com/a.png" };
    },
  };
}

function buildHandlers(db: ReturnType<typeof createMockDatabase>, callbacks?: AuthCallbacks, pages?: { error?: string }) {
  const cookieConfig = resolveCookieConfig({ secure: false });
  const queries = createQueries(db);
  const sessionManager = createSessionManager(queries);
  return createHandlers({
    providers: new Map([["github", createMockProvider("github")]]),
    sessionManager,
    cookieConfig,
    queries,
    basePath: "/api/auth",
    sessionMaxAge: 30 * 86400,
    oauthAutoCreateAccount: true,
    callbacks,
    pages,
  });
}

describe("callbacks.signIn", () => {
  let db: ReturnType<typeof createMockDatabase>;
  beforeEach(() => {
    db = createMockDatabase();
    db.tables.set("users", []);
    db.tables.set("accounts", []);
    db.tables.set("sessions", []);
  });

  it("is invoked with expected context on new-user flow", async () => {
    let captured: SignInCallbackContext | null = null;
    const handlers = buildHandlers(db, {
      signIn: async (ctx) => { captured = ctx; return { allow: true }; },
    });

    const req = new Request(
      "http://localhost/api/auth/callback/github?code=c&state=s",
      { headers: { cookie: "oauth_state=s" } }
    );
    const res = await handlers.handleRequest(req);
    expect(res!.status).toBe(200);
    expect(captured).not.toBeNull();
    expect(captured!.provider).toBe("github");
    expect(captured!.profile.email).toBe("user@example.com");
    expect(captured!.account.provider_user_id).toBe("p-123");
    expect(captured!.account.access_token).toBe("mock-token");
    expect(captured!.existingUserId).toBeNull();
    expect(captured!.request).toBeInstanceOf(Request);
  });

  it("redirects to pages.error with ?error=REASON when allow is false", async () => {
    const handlers = buildHandlers(
      db,
      { signIn: async () => ({ allow: false, reason: "DOMAIN_BLOCKED" }) },
      { error: "/auth/error" }
    );

    const req = new Request(
      "http://localhost/api/auth/callback/github?code=c&state=s",
      { headers: { cookie: "oauth_state=s" } }
    );
    const res = await handlers.handleRequest(req);
    expect(res!.status).toBe(200);
    const html = await res!.text();
    expect(html).toContain("/auth/error?error=DOMAIN_BLOCKED");

    expect(db.tables.get("users")).toHaveLength(0);
    expect(db.tables.get("sessions")).toHaveLength(0);
  });

  it("defaults to '/' and reason=SIGNIN_REJECTED when pages.error and reason are unset", async () => {
    const handlers = buildHandlers(db, { signIn: async () => ({ allow: false }) });

    const req = new Request(
      "http://localhost/api/auth/callback/github?code=c&state=s",
      { headers: { cookie: "oauth_state=s" } }
    );
    const res = await handlers.handleRequest(req);
    const html = await res!.text();
    expect(html).toContain("/?error=SIGNIN_REJECTED");
  });

  it("merges userOverrides into createUser INSERT columns", async () => {
    const handlers = buildHandlers(db, {
      signIn: async () => ({ allow: true, userOverrides: { org_id: "org-42" } }),
    });

    const req = new Request(
      "http://localhost/api/auth/callback/github?code=c&state=s",
      { headers: { cookie: "oauth_state=s" } }
    );
    const res = await handlers.handleRequest(req);
    expect(res!.status).toBe(200);

    const users = db.tables.get("users")!;
    expect(users).toHaveLength(1);
    expect(users[0]!.org_id).toBe("org-42");
    expect(users[0]!.email).toBe("user@example.com");
  });

  it("thrown exception inside signIn falls through to the generic 500 error path", async () => {
    const handlers = buildHandlers(db, {
      signIn: async () => { throw new Error("boom"); },
    });

    const req = new Request(
      "http://localhost/api/auth/callback/github?code=c&state=s",
      { headers: { cookie: "oauth_state=s" } }
    );
    const res = await handlers.handleRequest(req);
    expect(res!.status).toBe(500);
    expect(db.tables.get("users")).toHaveLength(0);
  });
});
