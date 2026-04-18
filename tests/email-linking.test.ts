import { describe, it, expect, beforeEach } from "bun:test";
import { createHandlers } from "../src/server/handlers.ts";
import { createSessionManager } from "../src/core/session.ts";
import { resolveCookieConfig } from "../src/core/cookie.ts";
import { createMockDatabase } from "./helpers/mock-db.ts";
import { createQueries } from "../src/db/queries.ts";
import type { OAuthProvider, OAuthTokens, OAuthUserProfile, SignInCallbackContext } from "../src/types.ts";

function createMockProvider(id: string): OAuthProvider {
  return {
    id,
    createAuthorizationURL(state: string): URL {
      return new URL(`https://p.example.com/auth?state=${state}`);
    },
    async validateAuthorizationCode(_code: string): Promise<OAuthTokens> {
      return { accessToken: "mock-token" };
    },
    async getUserProfile(_t: string): Promise<OAuthUserProfile> {
      return { id: "provider-user-1", email: "alice@example.com", name: "Alice", avatarUrl: null };
    },
  };
}

function buildHandlers(
  db: ReturnType<typeof createMockDatabase>,
  opts: {
    allowEmailAccountLinking?: boolean;
    allowDangerousEmailAccountLinking?: boolean;
    signIn?: (ctx: SignInCallbackContext) => Promise<{ allow: boolean }> | { allow: boolean };
  } = {}
) {
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
    allowEmailAccountLinking: opts.allowEmailAccountLinking,
    allowDangerousEmailAccountLinking: opts.allowDangerousEmailAccountLinking,
    callbacks: opts.signIn ? { signIn: opts.signIn } : undefined,
  });
}

describe("email-based account linking", () => {
  let db: ReturnType<typeof createMockDatabase>;
  beforeEach(() => {
    db = createMockDatabase();
    db.tables.set("users", [
      { id: "u-existing", email: "alice@example.com", name: "Alice (original)", avatar_url: null },
    ]);
    db.tables.set("accounts", []);
    db.tables.set("sessions", []);
  });

  it("rejects with OAuthAccountNotLinked when neither flag is set (default)", async () => {
    const handlers = buildHandlers(db);
    const req = new Request(
      "http://localhost/api/auth/callback/github?code=c&state=s",
      { headers: { cookie: "oauth_state=s" } }
    );
    const res = await handlers.handleRequest(req);
    expect(res!.status).toBe(403);
    const body = await res!.json();
    expect(body.error).toBe("OAuthAccountNotLinked");

    expect(db.tables.get("accounts")).toHaveLength(0);
    expect(db.tables.get("sessions")).toHaveLength(0);
  });

  it("links the account when allowEmailAccountLinking is true", async () => {
    const handlers = buildHandlers(db, { allowEmailAccountLinking: true });
    const req = new Request(
      "http://localhost/api/auth/callback/github?code=c&state=s",
      { headers: { cookie: "oauth_state=s" } }
    );
    const res = await handlers.handleRequest(req);
    expect(res!.status).toBe(200);

    const users = db.tables.get("users")!;
    expect(users).toHaveLength(1);
    expect(users[0]!.id).toBe("u-existing");

    const accounts = db.tables.get("accounts")!;
    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.user_id).toBe("u-existing");
    expect(accounts[0]!.provider_id).toBe("github");

    const sessions = db.tables.get("sessions")!;
    expect(sessions).toHaveLength(1);
  });

  it("still links when only the deprecated allowDangerousEmailAccountLinking is true", async () => {
    const handlers = buildHandlers(db, { allowDangerousEmailAccountLinking: true });
    const req = new Request(
      "http://localhost/api/auth/callback/github?code=c&state=s",
      { headers: { cookie: "oauth_state=s" } }
    );
    const res = await handlers.handleRequest(req);
    expect(res!.status).toBe(200);
    expect(db.tables.get("accounts")!).toHaveLength(1);
    expect(db.tables.get("sessions")!).toHaveLength(1);
  });

  it("passes emailLinked: true and existingUserId to signIn when linking occurs", async () => {
    let captured: SignInCallbackContext | null = null;
    const handlers = buildHandlers(db, {
      allowEmailAccountLinking: true,
      signIn: async (ctx) => { captured = ctx; return { allow: true }; },
    });
    const req = new Request(
      "http://localhost/api/auth/callback/github?code=c&state=s",
      { headers: { cookie: "oauth_state=s" } }
    );
    await handlers.handleRequest(req);

    expect(captured).not.toBeNull();
    expect(captured!.existingUserId).toBe("u-existing");
    expect(captured!.emailLinked).toBe(true);
  });

  it("passes emailLinked: false when signing in a returning user (account already linked)", async () => {
    db.tables.set("accounts", [
      { id: "a-existing", user_id: "u-existing", provider_id: "github", provider_user_id: "provider-user-1", access_token: null, refresh_token: null, expires_at: null },
    ]);
    let captured: SignInCallbackContext | null = null;
    const handlers = buildHandlers(db, {
      signIn: async (ctx) => { captured = ctx; return { allow: true }; },
    });
    const req = new Request(
      "http://localhost/api/auth/callback/github?code=c&state=s",
      { headers: { cookie: "oauth_state=s" } }
    );
    await handlers.handleRequest(req);

    expect(captured).not.toBeNull();
    expect(captured!.existingUserId).toBe("u-existing");
    expect(captured!.emailLinked).toBe(false);
  });

  it("passes emailLinked: false on brand-new user flow", async () => {
    db.tables.set("users", []);
    let captured: SignInCallbackContext | null = null;
    const handlers = buildHandlers(db, {
      allowEmailAccountLinking: true,
      signIn: async (ctx) => { captured = ctx; return { allow: true }; },
    });
    const req = new Request(
      "http://localhost/api/auth/callback/github?code=c&state=s",
      { headers: { cookie: "oauth_state=s" } }
    );
    await handlers.handleRequest(req);

    expect(captured).not.toBeNull();
    expect(captured!.existingUserId).toBeNull();
    expect(captured!.emailLinked).toBe(false);
  });
});
