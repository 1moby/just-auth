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
    expect(db.tables.get("accounts")).toHaveLength(0);
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

  it("provides existingUserId to callback when user already exists (account match)", async () => {
    // Pre-populate: user + account already in DB (returning-user scenario)
    db.tables.set("users", [
      { id: "existing-u1", email: "user@example.com", name: "Test", avatar_url: null },
    ]);
    db.tables.set("accounts", [
      { id: "existing-a1", user_id: "existing-u1", provider_id: "github", provider_user_id: "p-123", access_token: null, refresh_token: null, expires_at: null },
    ]);

    let captured: SignInCallbackContext | null = null;
    const handlers = buildHandlers(db, {
      signIn: async (ctx) => {
        captured = ctx;
        return { allow: true, userOverrides: { org_id: "should-be-ignored" } };
      },
    });

    const req = new Request(
      "http://localhost/api/auth/callback/github?code=c&state=s",
      { headers: { cookie: "oauth_state=s" } }
    );
    const res = await handlers.handleRequest(req);
    expect(res!.status).toBe(200);
    expect(captured).not.toBeNull();
    expect(captured!.existingUserId).toBe("existing-u1");

    // userOverrides must be ignored for existing users
    const users = db.tables.get("users")!;
    expect(users).toHaveLength(1); // no duplicate user created
    expect("org_id" in users[0]!).toBe(false);
  });

  it("provides existingUserId via email-link path and ignores userOverrides", async () => {
    // Pre-populate: user with matching email but no account for this provider (email-link scenario)
    db.tables.set("users", [
      { id: "linked-u1", email: "user@example.com", name: "Test", avatar_url: null },
    ]);

    const cookieConfig = resolveCookieConfig({ secure: false });
    const queries = createQueries(db);
    const sessionManager = createSessionManager(queries);

    let captured: SignInCallbackContext | null = null;
    const handlers = createHandlers({
      providers: new Map([["github", createMockProvider("github")]]),
      sessionManager,
      cookieConfig,
      queries,
      basePath: "/api/auth",
      sessionMaxAge: 30 * 86400,
      oauthAutoCreateAccount: true,
      allowDangerousEmailAccountLinking: true,
      callbacks: {
        signIn: async (ctx) => {
          captured = ctx;
          return { allow: true, userOverrides: { org_id: "should-be-ignored" } };
        },
      },
    });

    const req = new Request(
      "http://localhost/api/auth/callback/github?code=c&state=s",
      { headers: { cookie: "oauth_state=s" } }
    );
    const res = await handlers.handleRequest(req);
    expect(res!.status).toBe(200);
    expect(captured).not.toBeNull();
    expect(captured!.existingUserId).toBe("linked-u1");

    // New account row should be created linking the existing user
    const accounts = db.tables.get("accounts")!;
    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.user_id).toBe("linked-u1");

    // userOverrides must be ignored — no duplicate user and no org_id on existing user
    const users = db.tables.get("users")!;
    expect(users).toHaveLength(1);
    expect("org_id" in users[0]!).toBe(false);
  });

  it("preserves extra provider-specific fields on profile in the callback context", async () => {
    // Swap in a provider that returns an extra field
    const cookieConfig = resolveCookieConfig({ secure: false });
    const queries = createQueries(db);
    const sessionManager = createSessionManager(queries);

    const customProvider: OAuthProvider = {
      id: "google",
      createAuthorizationURL(state: string): URL {
        return new URL(`https://p.example.com/auth?state=${state}`);
      },
      async validateAuthorizationCode(_code: string): Promise<OAuthTokens> {
        return { accessToken: "tok" };
      },
      async getUserProfile(_t: string): Promise<OAuthUserProfile> {
        // Cast allows returning an extra field beyond the typed shape
        return {
          id: "g-42",
          email: "u@1moby.com",
          name: "U",
          avatarUrl: null,
          // @ts-expect-error provider-specific extra
          hd: "1moby.com",
        };
      },
    };

    let captured: SignInCallbackContext | null = null;
    const handlers = createHandlers({
      providers: new Map([["google", customProvider]]),
      sessionManager,
      cookieConfig,
      queries,
      basePath: "/api/auth",
      sessionMaxAge: 30 * 86400,
      oauthAutoCreateAccount: true,
      callbacks: {
        signIn: async (ctx) => { captured = ctx; return { allow: true }; },
      },
    });

    const req = new Request(
      "http://localhost/api/auth/callback/google?code=c&state=s",
      { headers: { cookie: "oauth_state=s" } }
    );
    const res = await handlers.handleRequest(req);
    expect(res!.status).toBe(200);
    expect(captured).not.toBeNull();
    expect(captured!.profile.hd).toBe("1moby.com");
  });
});

describe("callbacks.session", () => {
  let db: ReturnType<typeof createMockDatabase>;
  beforeEach(() => {
    db = createMockDatabase();
    db.tables.set("users", []);
    db.tables.set("accounts", []);
    db.tables.set("sessions", []);
  });

  it("returns the callback's output in place of the default session body", async () => {
    db.tables.set("users", [
      { id: "u1", email: "alice@example.com", name: "Alice", avatar_url: null },
    ]);
    const cookieConfig = resolveCookieConfig({ secure: false });
    const queries = createQueries(db);
    const sessionManager = createSessionManager(queries);
    const { token } = await sessionManager.createSession("u1");

    const handlers = createHandlers({
      providers: new Map(),
      sessionManager,
      cookieConfig,
      queries,
      basePath: "/api/auth",
      sessionMaxAge: 30 * 86400,
      callbacks: {
        session: async ({ user, session }) => ({
          user,
          custom: "hello",
          sessionId: session.id,
        }),
      },
    });

    const req = new Request("http://localhost/api/auth/session", {
      headers: { cookie: `__Host-auth_session=${token}` },
    });
    const res = await handlers.handleRequest(req);
    expect(res!.status).toBe(200);
    const body = await res!.json();
    expect(body.custom).toBe("hello");
    expect(body.user.id).toBe("u1");
    expect(body.sessionId).toBeTruthy();
    expect("accounts" in body).toBe(false);
    expect("permissions" in body).toBe(false);
  });

  it("receives session with expiresAt as a number (unix ms)", async () => {
    db.tables.set("users", [
      { id: "u1", email: "alice@example.com", name: "Alice", avatar_url: null },
    ]);
    const cookieConfig = resolveCookieConfig({ secure: false });
    const queries = createQueries(db);
    const sessionManager = createSessionManager(queries);
    const { token } = await sessionManager.createSession("u1");

    let capturedExpiresAt: unknown = null;
    const handlers = createHandlers({
      providers: new Map(),
      sessionManager,
      cookieConfig,
      queries,
      basePath: "/api/auth",
      sessionMaxAge: 30 * 86400,
      callbacks: {
        session: async ({ session }) => {
          capturedExpiresAt = session.expiresAt;
          return { ok: true };
        },
      },
    });

    const req = new Request("http://localhost/api/auth/session", {
      headers: { cookie: `__Host-auth_session=${token}` },
    });
    await handlers.handleRequest(req);
    expect(typeof capturedExpiresAt).toBe("number");
  });
});

describe("no callbacks = 0.1.x behavior", () => {
  let db: ReturnType<typeof createMockDatabase>;
  beforeEach(() => {
    db = createMockDatabase();
    db.tables.set("users", []);
    db.tables.set("accounts", []);
    db.tables.set("sessions", []);
  });

  it("OAuth callback creates user + session with default columns only", async () => {
    const handlers = buildHandlers(db); // no callbacks
    const req = new Request(
      "http://localhost/api/auth/callback/github?code=c&state=s",
      { headers: { cookie: "oauth_state=s" } }
    );
    const res = await handlers.handleRequest(req);
    expect(res!.status).toBe(200);
    const users = db.tables.get("users")!;
    expect(users).toHaveLength(1);
    expect(Object.keys(users[0]!).sort()).toEqual(
      ["avatar_url", "email", "id", "name"].sort()
    );
  });

  it("GET /session returns default shape (user, session, accounts)", async () => {
    db.tables.set("users", [
      { id: "u1", email: "alice@example.com", name: "Alice", avatar_url: null },
    ]);
    const cookieConfig = resolveCookieConfig({ secure: false });
    const queries = createQueries(db);
    const sessionManager = createSessionManager(queries);
    const { token } = await sessionManager.createSession("u1");

    const handlers = createHandlers({
      providers: new Map(),
      sessionManager,
      cookieConfig,
      queries,
      basePath: "/api/auth",
      sessionMaxAge: 30 * 86400,
    });

    const req = new Request("http://localhost/api/auth/session", {
      headers: { cookie: `__Host-auth_session=${token}` },
    });
    const res = await handlers.handleRequest(req);
    const body = await res!.json();
    expect(body.user.id).toBe("u1");
    expect(body.session).toBeTruthy();
    expect(Array.isArray(body.accounts)).toBe(true);
  });
});
