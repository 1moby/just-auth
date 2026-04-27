# Auth Callbacks (signIn / session) + Extensible createUser — 0.2.0

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add optional `signIn` and `session` callbacks to `AuthConfig`, allow `signIn` to inject extra user-table columns at OAuth user-creation time, and expose an `error` page config — all without breaking 0.1.x consumers.

**Architecture:** Extend `AuthConfig` with `callbacks?: AuthCallbacks` and `pages?: { error?: string }`. Thread both into `HandlersConfig`. In `handleCallback()`, after OAuth profile retrieval and existing-user lookups, invoke `signIn` and branch on its result (abort → redirect to `pages.error`, or allow with optional `userOverrides`). In `handleSession()`, after loading session+user, call `session` (if set) and return whatever it yields. Extend `createUser` to accept a whitelisted `extraColumns` map and compose the INSERT dynamically, with column names validated by regex (never concatenated from untrusted data).

**Tech Stack:** TypeScript, Bun test, Web Crypto API (existing), raw SQL via existing `DatabaseAdapter`. No new dependencies.

**Non-negotiables:**
- All new config fields are optional. With `callbacks` unset, behavior is byte-for-byte identical to 0.1.2.
- Column names in dynamic INSERTs are validated against `/^[a-zA-Z_][a-zA-Z0-9_]*$/` before being interpolated — values go through `?` placeholders.
- Release as `0.2.0` (minor bump because the public `AuthConfig` surface grows; no breaking changes).

**Note on file paths:** The external spec references `src/server/types.ts`, but this codebase keeps all types in `src/types.ts`. We follow the codebase convention — types go in `src/types.ts`, re-exported from `src/index.ts`.

---

## File Structure

Files to create:
- `tests/callbacks.test.ts` — all new behavioral tests for signIn/session hooks and extraColumns.

Files to modify:
- `src/types.ts` — add `AuthCallbacks`, `SignInCallbackContext`, `SignInCallbackResult`, `SessionCallbackContext`, `PagesConfig`; extend `AuthConfig`.
- `src/db/queries.ts` — `createUser(user, extraColumns?)` with safe dynamic column composition.
- `src/server/handlers.ts` — extend `HandlersConfig` with `callbacks` + `pages`; wire signIn into `handleCallback`; wire session into `handleSession`.
- `src/index.ts` — pass `callbacks` and `pages` from `AuthConfig` into `createHandlers`; re-export new types.
- `README.md` — add "Hooks" section.
- `package.json` — bump version to `0.2.0`.

---

## Task 1: Add callback types + `pages` config

**Files:**
- Modify: `src/types.ts` (append after existing `AuthConfig`)

- [ ] **Step 1: Add new type interfaces to `src/types.ts`**

Append to `src/types.ts` (after the existing `AuthConfig` interface):

```ts
export interface PagesConfig {
  /** Path (relative or absolute) to redirect to on signIn-callback rejection. Default: "/" */
  error?: string;
}

export interface SignInCallbackContext {
  /** Provider id, e.g. 'google'. */
  provider: string;
  /** Raw profile returned by provider.getUserProfile(). May carry provider-specific extra fields. */
  profile: {
    id: string;
    email: string | null;
    name: string | null;
    avatarUrl: string | null;
    [k: string]: unknown;
  };
  /** OAuth account info (provider, provider_user_id, tokens). */
  account: {
    provider_id: string;
    provider_user_id: string;
    access_token?: string;
    refresh_token?: string;
    expires_at?: number;
  };
  /** Id of an existing user matched by account or email. Null if a new user would be created. */
  existingUserId: string | null;
  /** Request context for IP/headers/audit callers. */
  request: Request;
}

export interface SignInCallbackResult {
  /** false → abort sign-in; the reason surfaces in the error-page query string. */
  allow: boolean;
  /** Extra columns to pass to createUser. Only applied when existingUserId is null. */
  userOverrides?: Record<string, unknown>;
  /** Reason code for rejection, URL-encoded into `?error=...`. Default: 'SIGNIN_REJECTED'. */
  reason?: string;
}

export interface SessionCallbackContext {
  session: { id: string; userId: string; expiresAt: number };
  user: { id: string; email: string | null; name: string | null; avatarUrl: string | null };
}

export interface AuthCallbacks {
  /** Fires after OAuth token exchange, before createUser. Return { allow: false, reason } to abort. */
  signIn?: (ctx: SignInCallbackContext) =>
    | Promise<SignInCallbackResult>
    | SignInCallbackResult;
  /** Fires inside GET /api/auth/session. Whatever you return replaces the default response body. */
  session?: (ctx: SessionCallbackContext) =>
    | Promise<Record<string, unknown>>
    | Record<string, unknown>;
}
```

- [ ] **Step 2: Extend `AuthConfig` with `callbacks` and `pages`**

In `src/types.ts`, modify the `AuthConfig` interface (currently lines 91-111) — add the two new optional fields at the bottom of the interface, before the closing `}`:

```ts
  /** Restrict allowed emails. Array of domain strings (e.g. ["@1moby.com"]) or a function returning boolean. */
  allowedEmails?: string[] | ((email: string) => boolean);
  /** Custom page paths (e.g. error redirect target). */
  pages?: PagesConfig;
  /** Lifecycle callbacks invoked during sign-in and session resolution. */
  callbacks?: AuthCallbacks;
}
```

- [ ] **Step 3: Typecheck**

Run: `bunx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/types.ts
git commit -m "feat(types): add AuthCallbacks, pages config, callback context types"
```

---

## Task 2: Re-export new types from `src/index.ts`

**Files:**
- Modify: `src/index.ts:63-83` (the `export type { ... } from "./types.ts"` block)

- [ ] **Step 1: Add new types to the re-export block**

In `src/index.ts`, find the existing `export type { ... } from "./types.ts"` block and append the new type names:

```ts
export type {
  AuthConfig,
  AuthInstance,
  User,
  Session,
  Account,
  SessionValidationResult,
  OAuthProvider,
  OAuthTokens,
  OAuthUserProfile,
  DatabaseAdapter,
  PreparedStatement,
  BoundStatement,
  CookieOptions,
  SessionOptions,
  SessionManager,
  SessionStatus,
  SessionContextValue,
  RbacConfig,
  RoleDefinition,
  AuthCallbacks,
  SignInCallbackContext,
  SignInCallbackResult,
  SessionCallbackContext,
  PagesConfig,
} from "./types.ts";
```

- [ ] **Step 2: Typecheck**

Run: `bunx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat(exports): re-export callback types from package root"
```

---

## Task 3: `createUser` accepts dynamic `extraColumns`

**Files:**
- Modify: `src/db/queries.ts` (interface line 100, implementation line 125)
- Test: `tests/queries.test.ts` (append new `describe` block)

- [ ] **Step 1: Write failing test for extraColumns**

Append to `tests/queries.test.ts` inside the top-level `describe("Database Queries", ...)` block (before its closing `});`):

```ts
  describe("createUser extraColumns", () => {
    it("accepts extra columns and writes them to the INSERT", async () => {
      await q.createUser(
        { id: "u1", email: "x@y.com", name: "X", avatarUrl: null },
        { org_id: "org-42", tenant: "acme" }
      );
      const rows = db.tables.get("users")!;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.org_id).toBe("org-42");
      expect(rows[0]!.tenant).toBe("acme");
      expect(rows[0]!.id).toBe("u1");
    });

    it("ignores undefined values in extraColumns", async () => {
      await q.createUser(
        { id: "u2", email: "a@b.com", name: null, avatarUrl: null },
        { org_id: "org-1", maybe: undefined }
      );
      const rows = db.tables.get("users")!;
      expect(rows[0]!.org_id).toBe("org-1");
      expect("maybe" in rows[0]!).toBe(false);
    });

    it("rejects invalid column names", async () => {
      await expect(
        q.createUser(
          { id: "u3", email: "c@d.com", name: null, avatarUrl: null },
          { "bad column": "x" }
        )
      ).rejects.toThrow(/invalid column name/i);
    });

    it("omitting extraColumns preserves existing behavior", async () => {
      const user = await q.createUser({
        id: "u4", email: "e@f.com", name: "E", avatarUrl: null,
      });
      expect(user.id).toBe("u4");
      const rows = db.tables.get("users")!;
      expect(rows[0]!.email).toBe("e@f.com");
    });
  });
```

- [ ] **Step 2: Run test to verify failure**

Run: `bun test tests/queries.test.ts`
Expected: the four new tests FAIL (createUser signature doesn't accept second arg, no validation, etc.).

- [ ] **Step 3: Update `Queries` interface**

In `src/db/queries.ts`, change the `createUser` signature (line 100):

```ts
  createUser(
    user: { id: string; email: string | null; name: string | null; avatarUrl: string | null; role?: string },
    extraColumns?: Record<string, unknown>
  ): Promise<User>;
```

- [ ] **Step 4: Implement dynamic INSERT in `createUser`**

Replace the existing `async createUser(user) { ... }` block (lines 125-138) with:

```ts
    async createUser(user, extraColumns) {
      const IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
      const base: Record<string, unknown> = {
        id: user.id,
        email: user.email,
        name: user.name,
        avatar_url: user.avatarUrl,
      };
      if (user.role !== undefined) base.role = user.role;
      const merged: Record<string, unknown> = { ...base, ...(extraColumns ?? {}) };

      const columns: string[] = [];
      const values: unknown[] = [];
      for (const [key, value] of Object.entries(merged)) {
        if (value === undefined) continue;
        if (!IDENT_RE.test(key)) {
          throw new Error(`[just-auth] Invalid column name "${key}" in createUser extraColumns`);
        }
        columns.push(key);
        values.push(value);
      }

      const placeholders = columns.map(() => "?").join(", ");
      await db
        .prepare(`INSERT INTO ${t.users} (${columns.join(", ")}) VALUES (${placeholders})`)
        .bind(...values)
        .run();

      return { id: user.id, email: user.email, name: user.name, avatarUrl: user.avatarUrl, role: user.role };
    },
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/queries.test.ts`
Expected: all query tests (existing + 4 new) PASS.

- [ ] **Step 6: Run full test suite to catch regressions**

Run: `bun test`
Expected: all existing tests still pass.

- [ ] **Step 7: Commit**

```bash
git add src/db/queries.ts tests/queries.test.ts
git commit -m "feat(db): createUser accepts whitelisted extraColumns for INSERT"
```

---

## Task 4: Thread `callbacks` + `pages` through `HandlersConfig`

**Files:**
- Modify: `src/server/handlers.ts` (HandlersConfig interface at line 133, destructure at line 188)
- Modify: `src/index.ts` (`createHandlers({...})` call at lines 12-26)

- [ ] **Step 1: Extend `HandlersConfig` interface**

In `src/server/handlers.ts`, add imports near the top:

```ts
import type {
  AuthConfig,
  AuthCallbacks,
  PagesConfig,
  OAuthProvider,
  SessionManager,
} from "../types.ts";
```

Then in the `HandlersConfig` interface (lines 133-148), add two optional fields before the closing `}`:

```ts
  onAuthSuccess?: (user: { id: string }, request: Request) => string | undefined;
  callbacks?: AuthCallbacks;
  pages?: PagesConfig;
}
```

- [ ] **Step 2: Pass `callbacks` and `pages` from `createReactAuth`**

In `src/index.ts`, modify the `createHandlers({ ... })` call (lines 12-26) by adding the two new keys:

```ts
  const { handleRequest } = createHandlers({
    providers: providerMap,
    sessionManager,
    cookieConfig,
    queries,
    basePath,
    sessionMaxAge,
    credentials: config.credentials,
    allowRegistration: config.allowRegistration,
    oauthAutoCreateAccount: config.oauthAutoCreateAccount,
    allowDangerousEmailAccountLinking: config.allowDangerousEmailAccountLinking,
    passwordMinLength: config.passwordMinLength,
    allowedEmails: config.allowedEmails,
    rbac: config.rbac,
    callbacks: config.callbacks,
    pages: config.pages,
  });
```

- [ ] **Step 3: Typecheck + full test suite**

Run: `bunx tsc --noEmit && bun test`
Expected: no type errors; all existing tests pass (no behavior change yet).

- [ ] **Step 4: Commit**

```bash
git add src/server/handlers.ts src/index.ts
git commit -m "feat(handlers): thread callbacks + pages config through HandlersConfig"
```

---

## Task 5: Wire `signIn` callback into `handleCallback`

**Files:**
- Modify: `src/server/handlers.ts` (inside `handleCallback()`, roughly lines 316-394)
- Test: `tests/callbacks.test.ts` (new file)

- [ ] **Step 1: Create `tests/callbacks.test.ts` with signIn invocation test**

Create `tests/callbacks.test.ts`:

```ts
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
});
```

- [ ] **Step 2: Run new test to confirm it fails**

Run: `bun test tests/callbacks.test.ts`
Expected: FAIL — `captured` remains null, or expectation on `captured` access throws because no signIn hook is wired yet.

- [ ] **Step 3: Implement signIn invocation in `handleCallback`**

In `src/server/handlers.ts`, find the existing logic in `handleCallback` that begins with `let user = await queries.getUserByAccount(...)` (around line 329). Replace the block from that line through the end of the user-creation `if (!user)` block (line 383) with the following. (Keep the surrounding try/catch and `sessionManager.createSession(...)` call intact — only this middle section changes.)

```ts
      // Look up existing user (by account, then by email)
      let user = await queries.getUserByAccount(providerId, profile.id);
      let existingUserByEmail = null as Awaited<ReturnType<typeof queries.getUserByEmail>> | null;

      if (!user && profile.email) {
        existingUserByEmail = await queries.getUserByEmail(profile.email);
      }

      const existingUserId: string | null =
        user?.id ?? (existingUserByEmail && config.allowDangerousEmailAccountLinking ? existingUserByEmail.id : null);

      // Reject email-collision before invoking signIn (preserves 0.1.x behavior).
      if (!user && existingUserByEmail && !config.allowDangerousEmailAccountLinking) {
        return new Response(
          JSON.stringify({ error: "OAuthAccountNotLinked", message: "Email already associated with another account" }),
          { status: 403, headers: { "Content-Type": "application/json" } }
        );
      }

      // Invoke signIn callback if configured.
      let userOverrides: Record<string, unknown> = {};
      if (config.callbacks?.signIn) {
        const ctx = {
          provider: providerId,
          profile: {
            id: profile.id,
            email: profile.email,
            name: profile.name,
            avatarUrl: profile.avatarUrl,
          },
          account: {
            provider_id: providerId,
            provider_user_id: profile.id,
            access_token: tokens.accessToken,
            refresh_token: tokens.refreshToken,
            expires_at: tokens.expiresAt,
          },
          existingUserId,
          request,
        };
        const result = await config.callbacks.signIn(ctx);
        if (!result.allow) {
          const errorPage = config.pages?.error ?? "/";
          const reason = encodeURIComponent(result.reason ?? "SIGNIN_REJECTED");
          const sep = errorPage.includes("?") ? "&" : "?";
          return htmlRedirectWithCookies(`${errorPage}${sep}error=${reason}`, request, [
            serializeStateCookie("oauth_state", "", { ...cookieConfig }).replace("Max-Age=600", "Max-Age=0"),
            serializeStateCookie("code_verifier", "", { ...cookieConfig }).replace("Max-Age=600", "Max-Age=0"),
          ]);
        }
        if (result.userOverrides) userOverrides = result.userOverrides;
      }

      // Link account to existing email-matched user (dangerous linking case).
      if (!user && existingUserByEmail && config.allowDangerousEmailAccountLinking) {
        user = existingUserByEmail;
        await queries.createAccount({
          id: generateId(),
          userId: existingUserByEmail.id,
          providerId,
          providerUserId: profile.id,
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken ?? null,
          expiresAt: tokens.expiresAt ?? null,
        });
      }

      // Create new user if still none matched.
      if (!user) {
        if (!config.oauthAutoCreateAccount) {
          return new Response(
            JSON.stringify({ error: "AccountNotFound", message: "No account found. Contact an administrator to create one." }),
            { status: 403, headers: { "Content-Type": "application/json" } }
          );
        }
        const userId = generateId();
        const defaultRole = config.rbac?.defaultRole;
        user = {
          id: userId,
          email: profile.email,
          name: profile.name,
          avatarUrl: profile.avatarUrl,
          role: defaultRole ?? undefined,
        };
        await queries.createUser(user, userOverrides);
        await queries.createAccount({
          id: generateId(),
          userId,
          providerId,
          providerUserId: profile.id,
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken ?? null,
          expiresAt: tokens.expiresAt ?? null,
        });
      }
```

- [ ] **Step 4: Run callbacks test — first signIn assertion**

Run: `bun test tests/callbacks.test.ts`
Expected: the first test passes.

- [ ] **Step 5: Add `allow: false` rejection test + userOverrides test + thrown-error test**

Append to `tests/callbacks.test.ts` inside `describe("callbacks.signIn", ...)`:

```ts
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
```

- [ ] **Step 6: Run new tests**

Run: `bun test tests/callbacks.test.ts`
Expected: all four signIn tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/server/handlers.ts tests/callbacks.test.ts
git commit -m "feat(handlers): invoke signIn callback before createUser; honor pages.error"
```

---

## Task 6: Wire `session` callback into `handleSession`

**Files:**
- Modify: `src/server/handlers.ts` (`handleSession` at line 404)
- Test: `tests/callbacks.test.ts` (append new `describe`)

- [ ] **Step 1: Write failing test for session callback**

Append to `tests/callbacks.test.ts` (after the `describe("callbacks.signIn", ...)` block, at top level):

```ts
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
```

- [ ] **Step 2: Run — expect failure**

Run: `bun test tests/callbacks.test.ts`
Expected: the two new tests FAIL (session callback is not wired; default body returned).

- [ ] **Step 3: Wire session callback in `handleSession`**

In `src/server/handlers.ts`, replace the existing `handleSession` function (currently lines 404-442) with:

```ts
  async function handleSession(request: Request): Promise<Response> {
    const cookieHeader = request.headers.get("cookie");
    const token = parseSessionCookie(cookieConfig, cookieHeader);

    if (!token) {
      return new Response(JSON.stringify(null), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    const result = await sessionManager.validateSession(token);

    if (!result) {
      return responseWithCookies(JSON.stringify(null), {
        status: 200,
        cookies: [clearSessionCookie(cookieConfig)],
        extraHeaders: { "Content-Type": "application/json" },
      });
    }

    // Session callback: if configured, its return value replaces the default body entirely.
    if (config.callbacks?.session) {
      const ctx = {
        session: {
          id: result.session.id,
          userId: result.session.userId,
          expiresAt: result.session.expiresAt.getTime(),
        },
        user: {
          id: result.user.id,
          email: result.user.email,
          name: result.user.name,
          avatarUrl: result.user.avatarUrl,
        },
      };
      const body = await config.callbacks.session(ctx);
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    const accounts = await queries.getAccountsByUserId(result.user.id);
    const accountList = accounts.map((a) => ({ providerId: a.providerId }));

    const responseData: Record<string, unknown> = {
      user: result.user,
      session: { expiresAt: result.session.expiresAt },
      accounts: accountList,
    };

    if (config.rbac && result.user.role) {
      responseData.permissions = resolvePermissions(result.user.role, config.rbac);
    }

    return new Response(JSON.stringify(responseData), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
```

- [ ] **Step 4: Run tests**

Run: `bun test tests/callbacks.test.ts`
Expected: all session callback tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/server/handlers.ts tests/callbacks.test.ts
git commit -m "feat(handlers): invoke session callback to customize /session response body"
```

---

## Task 7: Regression guard — no-callback behavior is unchanged

**Files:**
- Test: `tests/callbacks.test.ts` (append)

- [ ] **Step 1: Add regression test**

Append to `tests/callbacks.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the full test suite**

Run: `bun test`
Expected: 100% of existing + new tests pass.

- [ ] **Step 3: Commit**

```bash
git add tests/callbacks.test.ts
git commit -m "test(callbacks): regression guard for no-callbacks 0.1.x behavior"
```

---

## Task 8: Update README with Hooks section

**Files:**
- Modify: `README.md` (insert new section after the `## Configuration` block ending at line 205)

- [ ] **Step 1: Insert Hooks section**

In `README.md`, immediately before the `## RBAC` heading (currently line 207), insert:

```markdown
## Hooks

Two optional lifecycle callbacks let consumers intercept sign-in and customize the session response without forking the library. Both are plain async functions on `AuthConfig.callbacks`.

### `signIn` — gate OAuth sign-in, inject extra columns

Fires inside the OAuth callback handler, **after** token exchange and user lookup but **before** any user or account row is written. Return `{ allow: false, reason }` to abort (the user is redirected to `pages.error ?? "/"` with `?error=REASON`). Return `{ allow: true, userOverrides }` to continue; `userOverrides` is merged into the `users` INSERT as extra columns — only applied when a new user is being created.

```ts
import type { AuthConfig } from "@1moby/just-auth";

export const authConfig: AuthConfig = {
  // ... providers, database, etc.
  pages: { error: "/auth/error" },
  callbacks: {
    signIn: async (ctx) => {
      if (!ctx.profile.email?.endsWith("@1moby.com")) {
        return { allow: false, reason: "DOMAIN_BLOCKED" };
      }
      // Optional: look up invitation, attach org_id
      return {
        allow: true,
        userOverrides: { org_id: "the-org-uuid" },
      };
    },
  },
};
```

Extra columns must already exist on the `users` table — the library never ALTERs existing tables. Column names are validated against `/^[a-zA-Z_][a-zA-Z0-9_]*$/` before being interpolated into the INSERT; values use parameter binding.

### `session` — customize the `/api/auth/session` response

Fires on every `GET /api/auth/session` call, after the session + user are loaded. Whatever you return becomes the response body verbatim (the default `{ user, session, accounts, permissions }` shape is bypassed entirely — include what you need).

```ts
callbacks: {
  session: async ({ user, session }) => {
    const roles = await fetchRolesFor(user.id);
    return { user, roles, sessionExpiresAt: session.expiresAt };
  },
}
```

With no `callbacks.session` set, the default response shape is unchanged from 0.1.x.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs(readme): document signIn and session callback hooks"
```

---

## Task 9: Bump version to 0.2.0

**Files:**
- Modify: `package.json` (line 3)

- [ ] **Step 1: Edit version field**

In `package.json`, change line 3 from:

```json
  "version": "0.1.2",
```

to:

```json
  "version": "0.2.0",
```

- [ ] **Step 2: Build to confirm packaging works**

Run: `bun run build`
Expected: build succeeds, `dist/` is refreshed.

- [ ] **Step 3: Run full test suite one more time**

Run: `bun test`
Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "chore: bump version to 0.2.0"
```

---

## Self-Review Checklist (pre-flight before executing)

- [x] **Spec coverage:**
  - Add `SignInCallbackContext`, `SignInCallbackResult`, `SessionCallbackContext`, `AuthCallbacks` → Task 1.
  - Extend `AuthConfig.callbacks` → Task 1.
  - Wire `signIn` into `handleCallback` → Task 5.
  - Abort + redirect with `?error=REASON` → Task 5 (redirect uses `pages.error ?? "/"`).
  - Merge `userOverrides` into createUser → Task 5.
  - `createUser(user, extraColumns)` dynamic INSERT, filter undefined, safe column names → Task 3.
  - Wire `session` into `getServerSession` (i.e., `handleSession`) → Task 6.
  - Default shape preserved with no callbacks → Tasks 6 + 7.
  - Re-export types → Task 2.
  - Tests for each spec bullet → Tasks 3, 5, 6, 7.
  - Version 0.2.0 → Task 9.
  - README "Hooks" section → Task 8.

- [x] **No placeholders:** Every step contains exact code or exact command with expected output.

- [x] **Type consistency:** `SignInCallbackContext.profile.email` is `string | null` (matches `OAuthUserProfile.email`); `SessionCallbackContext.session.expiresAt` is `number` (unix ms, converted in `handleSession`). `AuthCallbacks.signIn` / `.session` signatures match `createHandlers` consumption sites.

- [x] **Path deviation from spec:** The external spec references `src/server/types.ts`; the repo uses `src/types.ts`. Plan follows repo convention; Task 1 notes this.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-04-17-auth-callbacks.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
