# Basic Auth + Account Linking Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add email/password authentication and automatic account linking by email, so users who log in via different methods with the same email share one account.

**Architecture:** Add `password_hash` column to `users` table. Add PBKDF2 password hashing via Web Crypto (zero deps). Add `POST /api/auth/register` and `POST /api/auth/callback/credentials` routes. Change OAuth callback to look up existing user by email before creating a new one. Add `allowDangerousEmailAccountLinking` config flag (NextAuth-compatible). Enhance session endpoint to return linked accounts. Update client `signIn` to POST for credentials. Add `signUp` client helper.

**Tech Stack:** Web Crypto API (PBKDF2-SHA256), existing DatabaseAdapter, existing cookie/session infra.

---

### Task 1: Password Hashing Module

**Files:**
- Create: `src/core/password.ts`
- Create: `tests/password.test.ts`

**Step 1: Write the failing tests**

```ts
// tests/password.test.ts
import { describe, it, expect } from "bun:test";
import { hashPassword, verifyPassword } from "../src/core/password.ts";

describe("Password hashing", () => {
  it("should hash a password and return salt:hash format", async () => {
    const hashed = await hashPassword("mypassword");
    expect(hashed).toContain(":");
    const [salt, hash] = hashed.split(":");
    expect(salt!.length).toBe(32); // 16 bytes hex
    expect(hash!.length).toBe(64); // 32 bytes hex
  });

  it("should verify a correct password", async () => {
    const hashed = await hashPassword("secret123");
    const valid = await verifyPassword("secret123", hashed);
    expect(valid).toBe(true);
  });

  it("should reject an incorrect password", async () => {
    const hashed = await hashPassword("secret123");
    const valid = await verifyPassword("wrong", hashed);
    expect(valid).toBe(false);
  });

  it("should produce different hashes for same password (random salt)", async () => {
    const hash1 = await hashPassword("same");
    const hash2 = await hashPassword("same");
    expect(hash1).not.toBe(hash2);
  });

  it("should reject empty password", async () => {
    expect(hashPassword("")).rejects.toThrow();
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test tests/password.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

```ts
// src/core/password.ts
const ITERATIONS = 100_000;
const HASH_LENGTH = 32; // bytes
const SALT_LENGTH = 16; // bytes

function hexEncode(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

function hexDecode(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

export async function hashPassword(password: string): Promise<string> {
  if (!password) throw new Error("Password cannot be empty");

  const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const hash = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    HASH_LENGTH * 8
  );
  return `${hexEncode(salt)}:${hexEncode(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;

  const salt = hexDecode(saltHex);
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const hash = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    HASH_LENGTH * 8
  );
  return hexEncode(hash) === hashHex;
}
```

**Step 4: Run tests to verify they pass**

Run: `bun test tests/password.test.ts`
Expected: 5 pass, 0 fail

**Step 5: Commit**

```bash
git add src/core/password.ts tests/password.test.ts
git commit -m "feat: add PBKDF2 password hashing via Web Crypto"
```

---

### Task 2: Schema Migration — Add password_hash Column

**Files:**
- Modify: `src/db/schema.sql`
- Modify: `src/db/migrate.ts`
- Modify: `tests/migrate.test.ts`

**Step 1: Write failing test**

Add to `tests/migrate.test.ts`:

```ts
it("should include password_hash column in users table", () => {
  const usersStatement = SCHEMA_STATEMENTS.find((s) => s.includes("CREATE TABLE") && s.includes("users"));
  expect(usersStatement).toContain("password_hash");
});
```

**Step 2: Run test to verify it fails**

Run: `bun test tests/migrate.test.ts`
Expected: FAIL — users CREATE TABLE doesn't contain password_hash

**Step 3: Update schema**

In `src/db/schema.sql`, add `password_hash TEXT` to users table:

```sql
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE,
  name TEXT,
  avatar_url TEXT,
  password_hash TEXT
);
```

In `src/db/migrate.ts`, update the `SCHEMA_STATEMENTS` array — add `password_hash TEXT` to the users CREATE TABLE statement. Also add an ALTER TABLE statement for existing databases:

```ts
const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE,
    name TEXT,
    avatar_url TEXT,
    password_hash TEXT
  )`,
  // ... rest unchanged ...
  // Add migration for existing DBs:
  `ALTER TABLE users ADD COLUMN password_hash TEXT`,
];
```

Note: The ALTER TABLE will fail on new DBs where the column already exists. Wrap the migrate function to ignore "duplicate column" errors, or use a separate `MIGRATION_STATEMENTS` array that runs with individual error handling.

Better approach: keep SCHEMA_STATEMENTS for CREATE TABLE (for new DBs), add a separate `MIGRATIONS` array:

```ts
const MIGRATIONS = [
  `ALTER TABLE users ADD COLUMN password_hash TEXT`,
];
```

Update `migrate()` to run MIGRATIONS after SCHEMA_STATEMENTS, ignoring "duplicate column" errors.

**Step 4: Run tests**

Run: `bun test tests/migrate.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/db/schema.sql src/db/migrate.ts tests/migrate.test.ts
git commit -m "feat: add password_hash column to users schema"
```

---

### Task 3: Database Queries — getAccountsByUserId, getUserByEmail with password

**Files:**
- Modify: `src/db/queries.ts`
- Modify: `tests/queries.test.ts`

**Step 1: Write failing tests**

Add to `tests/queries.test.ts`:

```ts
import { getAccountsByUserId } from "../src/db/queries.ts";

describe("Account listing", () => {
  beforeEach(async () => {
    await createUser(db, { id: "u1", email: "a@b.com", name: "A", avatarUrl: null });
  });

  it("should return all accounts for a user", async () => {
    await createAccount(db, {
      id: "a1", userId: "u1", providerId: "google",
      providerUserId: "g-123", accessToken: null, refreshToken: null, expiresAt: null,
    });
    await createAccount(db, {
      id: "a2", userId: "u1", providerId: "line",
      providerUserId: "l-456", accessToken: null, refreshToken: null, expiresAt: null,
    });
    const accounts = await getAccountsByUserId(db, "u1");
    expect(accounts).toHaveLength(2);
    expect(accounts.map(a => a.providerId).sort()).toEqual(["google", "line"]);
  });

  it("should return empty array for user with no accounts", async () => {
    const accounts = await getAccountsByUserId(db, "u1");
    expect(accounts).toHaveLength(0);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test tests/queries.test.ts`
Expected: FAIL — getAccountsByUserId not exported

**Step 3: Implement getAccountsByUserId**

Add to `src/db/queries.ts`:

```ts
export async function getAccountsByUserId(
  db: DatabaseAdapter,
  userId: string
): Promise<Account[]> {
  const { results } = await db
    .prepare("SELECT * FROM accounts WHERE user_id = ?")
    .bind(userId)
    .all<AccountRow>();
  return results.map((row) => ({
    id: row.id,
    userId: row.user_id,
    providerId: row.provider_id,
    providerUserId: row.provider_user_id,
    accessToken: row.access_token,
    refreshToken: row.refresh_token,
    expiresAt: row.expires_at,
  }));
}
```

**Step 4: Run tests**

Run: `bun test tests/queries.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/db/queries.ts tests/queries.test.ts
git commit -m "feat: add getAccountsByUserId query"
```

---

### Task 4: Types — Update AuthConfig, add CredentialsConfig

**Files:**
- Modify: `src/types.ts`

**Step 1: Update types**

Add to `src/types.ts`:

```ts
export interface AuthConfig {
  providers: OAuthProvider[];
  database: DatabaseAdapter;
  basePath?: string;
  cookie?: CookieOptions;
  session?: SessionOptions;
  secret?: string;
  credentials?: boolean;                          // enable email/password auth
  allowDangerousEmailAccountLinking?: boolean;     // auto-link by email (NextAuth-compat)
}
```

Add new type for session response with accounts:

```ts
export interface SessionWithAccounts extends SessionValidationResult {
  accounts: { providerId: string }[];
}
```

Update `SessionContextValue`:

```ts
export interface SessionContextValue {
  data: (SessionValidationResult & { accounts?: { providerId: string }[] }) | null;
  status: SessionStatus;
  update(): Promise<void>;
}
```

**Step 2: Run existing tests to verify nothing breaks**

Run: `bun test`
Expected: 92 pass (all existing tests still pass — additive changes only)

**Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat: add credentials and account linking config types"
```

---

### Task 5: Handlers — Credentials Register + Login Routes

**Files:**
- Modify: `src/server/handlers.ts`
- Modify: `tests/handlers.test.ts`

**Step 1: Write failing tests for credentials register**

Add to `tests/handlers.test.ts`:

```ts
describe("Credentials register", () => {
  it("should register a new user with email+password", async () => {
    // Re-create handlers with credentials enabled
    const providers = new Map<string, OAuthProvider>();
    providers.set("github", createMockProvider("github"));
    const credHandlers = createHandlers({
      providers,
      sessionManager,
      cookieConfig,
      database: db,
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

    // Should have session cookie
    const cookies = res!.headers.getSetCookie();
    expect(cookies.some(c => c.startsWith("auth_session="))).toBe(true);

    // Should have user + account in DB
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
      database: db,
      basePath: "/api/auth",
      sessionMaxAge: 30 * 86400,
      credentials: true,
    });

    // Register first
    await credHandlers.handleRequest(new Request("http://localhost/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "dup@test.com", password: "pass1" }),
    }));

    // Try registering again
    const res = await credHandlers.handleRequest(new Request("http://localhost/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "dup@test.com", password: "pass2" }),
    }));
    expect(res!.status).toBe(409);
  });

  it("should reject registration when credentials disabled", async () => {
    // Default handlers (no credentials: true)
    const req = new Request("http://localhost/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "a@b.com", password: "pass" }),
    });
    const res = await handlers.handleRequest(req);
    expect(res).toBeNull(); // Not handled
  });
});

describe("Credentials login", () => {
  it("should login with correct email+password", async () => {
    const credHandlers = createHandlers({
      providers: new Map(),
      sessionManager,
      cookieConfig,
      database: db,
      basePath: "/api/auth",
      sessionMaxAge: 30 * 86400,
      credentials: true,
    });

    // Register first
    await credHandlers.handleRequest(new Request("http://localhost/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "login@test.com", password: "mypass" }),
    }));

    // Login
    const res = await credHandlers.handleRequest(new Request("http://localhost/api/auth/callback/credentials", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "login@test.com", password: "mypass" }),
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
      database: db,
      basePath: "/api/auth",
      sessionMaxAge: 30 * 86400,
      credentials: true,
    });

    // Register
    await credHandlers.handleRequest(new Request("http://localhost/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "user@test.com", password: "correct" }),
    }));

    // Wrong password
    const res = await credHandlers.handleRequest(new Request("http://localhost/api/auth/callback/credentials", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "user@test.com", password: "wrong" }),
    }));
    expect(res!.status).toBe(401);
  });

  it("should reject login for non-existent email", async () => {
    const credHandlers = createHandlers({
      providers: new Map(),
      sessionManager,
      cookieConfig,
      database: db,
      basePath: "/api/auth",
      sessionMaxAge: 30 * 86400,
      credentials: true,
    });

    const res = await credHandlers.handleRequest(new Request("http://localhost/api/auth/callback/credentials", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "noone@test.com", password: "pass" }),
    }));
    expect(res!.status).toBe(401);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test tests/handlers.test.ts`
Expected: FAIL — credentials config not recognized, routes not handled

**Step 3: Implement credentials routes in handlers.ts**

Modify `HandlersConfig` in `src/server/handlers.ts`:

```ts
export interface HandlersConfig {
  // ... existing fields
  credentials?: boolean;
  allowDangerousEmailAccountLinking?: boolean;
}
```

Add to `handleRequest()`:

```ts
// POST /api/auth/register
if (subPath === "/register" && request.method === "POST" && config.credentials) {
  return handleRegister(request);
}

// POST /api/auth/callback/credentials
if (subPath === "/callback/credentials" && request.method === "POST" && config.credentials) {
  return handleCredentialsLogin(request);
}
```

Implement `handleRegister`:
1. Parse JSON body `{ email, password, name? }`
2. Validate email and password presence
3. Check if email already exists (`getUserByEmail`)
4. If exists → return 409
5. Hash password with `hashPassword()`
6. Create user (with password_hash)
7. Create account (provider_id="credentials", provider_user_id=email)
8. Create session, set cookie
9. Return `{ user }` with 200

Implement `handleCredentialsLogin`:
1. Parse JSON body `{ email, password }`
2. Get user by email
3. If no user or no password_hash → return 401
4. Verify password
5. If wrong → return 401
6. Create session, set cookie
7. Return `{ user }` with 200

Need new query: `getUserByEmailWithPassword` that returns `UserRow` including `password_hash`.

**Step 4: Run tests**

Run: `bun test tests/handlers.test.ts`
Expected: All pass

**Step 5: Commit**

```bash
git add src/server/handlers.ts src/db/queries.ts tests/handlers.test.ts
git commit -m "feat: add credentials register and login routes"
```

---

### Task 6: Account Linking in OAuth Callback

**Files:**
- Modify: `src/server/handlers.ts` (handleCallback function)
- Modify: `tests/handlers.test.ts`

**Step 1: Write failing tests for account linking**

Add to `tests/handlers.test.ts`:

```ts
describe("Account linking by email", () => {
  it("should link OAuth account to existing user with same email when enabled", async () => {
    const providers = new Map<string, OAuthProvider>();
    providers.set("github", createMockProvider("github")); // returns email: user@example.com
    const linkingHandlers = createHandlers({
      providers,
      sessionManager,
      cookieConfig,
      database: db,
      basePath: "/api/auth",
      sessionMaxAge: 30 * 86400,
      credentials: true,
      allowDangerousEmailAccountLinking: true,
    });

    // Register user with email first
    await linkingHandlers.handleRequest(new Request("http://localhost/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "user@example.com", password: "pass123" }),
    }));

    // Now OAuth login with same email
    const res = await linkingHandlers.handleRequest(new Request(
      "http://localhost/api/auth/callback/github?code=abc&state=s1",
      { headers: { cookie: "oauth_state=s1" } }
    ));
    expect(res!.status).toBe(302);

    // Should still be 1 user
    expect(db.tables.get("users")).toHaveLength(1);
    // Should have 2 accounts (credentials + github)
    expect(db.tables.get("accounts")).toHaveLength(2);
  });

  it("should return error when same email exists and linking disabled", async () => {
    const providers = new Map<string, OAuthProvider>();
    providers.set("github", createMockProvider("github"));
    const noLinkHandlers = createHandlers({
      providers,
      sessionManager,
      cookieConfig,
      database: db,
      basePath: "/api/auth",
      sessionMaxAge: 30 * 86400,
      credentials: true,
      allowDangerousEmailAccountLinking: false,
    });

    // Register with same email
    await noLinkHandlers.handleRequest(new Request("http://localhost/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "user@example.com", password: "pass123" }),
    }));

    // OAuth login → should fail
    const res = await noLinkHandlers.handleRequest(new Request(
      "http://localhost/api/auth/callback/github?code=abc&state=s1",
      { headers: { cookie: "oauth_state=s1" } }
    ));
    expect(res!.status).toBe(403);
    const body = await res!.json();
    expect(body.error).toContain("OAuthAccountNotLinked");
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test tests/handlers.test.ts`
Expected: FAIL — linking logic not implemented

**Step 3: Modify handleCallback in handlers.ts**

Replace the user lookup section in `handleCallback`:

```ts
// Current:
// let user = await getUserByAccount(database, providerId, profile.id);
// if (!user) { create new user + account }

// New:
let user = await getUserByAccount(database, providerId, profile.id);

if (!user) {
  // Check if a user with same email already exists
  if (profile.email) {
    const existingUser = await getUserByEmail(database, profile.email);
    if (existingUser) {
      if (config.allowDangerousEmailAccountLinking) {
        // Link this OAuth provider to existing user
        user = existingUser;
        await createAccount(database, {
          id: generateId(),
          userId: existingUser.id,
          providerId,
          providerUserId: profile.id,
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken ?? null,
          expiresAt: tokens.expiresAt ?? null,
        });
      } else {
        return new Response(
          JSON.stringify({ error: "OAuthAccountNotLinked", message: "Email already associated with another account" }),
          { status: 403, headers: { "Content-Type": "application/json" } }
        );
      }
    }
  }

  if (!user) {
    // Create new user + account
    const userId = generateId();
    user = { id: userId, email: profile.email, name: profile.name, avatarUrl: profile.avatarUrl };
    await createUser(database, user);
    await createAccount(database, {
      id: generateId(),
      userId,
      providerId,
      providerUserId: profile.id,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken ?? null,
      expiresAt: tokens.expiresAt ?? null,
    });
  }
}
```

**Step 4: Run tests**

Run: `bun test tests/handlers.test.ts`
Expected: All pass

**Step 5: Commit**

```bash
git add src/server/handlers.ts tests/handlers.test.ts
git commit -m "feat: add email-based account linking with OAuthAccountNotLinked error"
```

---

### Task 7: Session Endpoint — Include Linked Accounts

**Files:**
- Modify: `src/server/handlers.ts` (handleSession function)
- Modify: `tests/handlers.test.ts`

**Step 1: Write failing test**

Add to `tests/handlers.test.ts` session handler section:

```ts
it("should return linked accounts in session response", async () => {
  db.tables.set("users", [
    { id: "u1", email: "alice@example.com", name: "Alice", avatar_url: null, password_hash: null },
  ]);
  db.tables.set("accounts", [
    { id: "a1", user_id: "u1", provider_id: "google", provider_user_id: "g1", access_token: null, refresh_token: null, expires_at: null },
    { id: "a2", user_id: "u1", provider_id: "credentials", provider_user_id: "alice@example.com", access_token: null, refresh_token: null, expires_at: null },
  ]);
  const { token } = await sessionManager.createSession("u1");

  const req = new Request("http://localhost/api/auth/session", {
    headers: { cookie: `auth_session=${token}` },
  });
  const res = await handlers.handleRequest(req);
  const body = await res!.json();
  expect(body.user.id).toBe("u1");
  expect(body.accounts).toHaveLength(2);
  expect(body.accounts.map((a: any) => a.providerId).sort()).toEqual(["credentials", "google"]);
});
```

**Step 2: Run test to verify it fails**

Run: `bun test tests/handlers.test.ts`
Expected: FAIL — accounts not in response

**Step 3: Update handleSession in handlers.ts**

After getting the session result, fetch accounts:

```ts
const accounts = await getAccountsByUserId(database, result.user.id);

return new Response(
  JSON.stringify({
    user: result.user,
    session: { expiresAt: result.session.expiresAt },
    accounts: accounts.map((a) => ({ providerId: a.providerId })),
  }),
  { status: 200, headers: { "Content-Type": "application/json" } }
);
```

**Step 4: Update mock-db.ts to handle SELECT with WHERE user_id on accounts**

The mock DB's `handleSelect` should already work for `SELECT * FROM accounts WHERE user_id = ?`.

**Step 5: Run tests**

Run: `bun test`
Expected: All pass

**Step 6: Commit**

```bash
git add src/server/handlers.ts tests/handlers.test.ts
git commit -m "feat: include linked accounts in session endpoint response"
```

---

### Task 8: Client — Update signIn for Credentials + Add signUp

**Files:**
- Modify: `src/client/actions.ts`
- Modify: `src/client/index.ts`
- Modify: `src/client/session-context.tsx` (store accounts in context)

**Step 1: Update signIn to handle credentials**

```ts
// src/client/actions.ts
export function signIn(
  provider: string,
  options?: { email?: string; password?: string; redirect?: boolean },
  basePath = "/api/auth"
): void | Promise<{ ok: boolean; error?: string }> {
  if (provider === "credentials") {
    // POST to callback/credentials
    return fetch(`${basePath}/callback/credentials`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ email: options?.email, password: options?.password }),
    }).then(async (res) => {
      if (res.ok) {
        if (options?.redirect !== false) {
          window.location.href = "/";
        }
        return { ok: true };
      }
      const body = await res.json().catch(() => ({}));
      return { ok: false, error: body.error || "Login failed" };
    });
  }
  // OAuth: redirect as before
  window.location.href = `${basePath}/login/${provider}`;
}

export function signUp(
  options: { email: string; password: string; name?: string; redirect?: boolean },
  basePath = "/api/auth"
): Promise<{ ok: boolean; error?: string }> {
  return fetch(`${basePath}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ email: options.email, password: options.password, name: options.name }),
  }).then(async (res) => {
    if (res.ok) {
      if (options.redirect !== false) {
        window.location.href = "/";
      }
      return { ok: true };
    }
    const body = await res.json().catch(() => ({}));
    return { ok: false, error: body.error || "Registration failed" };
  });
}
```

**Step 2: Export signUp from client/index.ts**

```ts
export { signIn, signOut, signUp } from "./actions.ts";
```

**Step 3: Update session-context.tsx to store accounts**

In `fetchSession`, store `json.accounts` alongside user/session:

```ts
if (json && json.user) {
  setData({ user: json.user, session: json.session, accounts: json.accounts });
  setStatus("authenticated");
}
```

**Step 4: Run all tests**

Run: `bun test`
Expected: All pass

**Step 5: Commit**

```bash
git add src/client/actions.ts src/client/index.ts src/client/session-context.tsx
git commit -m "feat: add signUp and credentials signIn to client"
```

---

### Task 9: Wire Up — createReactAuth and Exports

**Files:**
- Modify: `src/index.ts`
- Modify: `src/server/handlers.ts` (pass credentials config through)

**Step 1: Pass credentials and allowDangerousEmailAccountLinking through createReactAuth**

In `src/index.ts`, pass new config fields to createHandlers:

```ts
const { handleRequest } = createHandlers({
  providers: providerMap,
  sessionManager,
  cookieConfig,
  database: config.database,
  basePath,
  sessionMaxAge,
  credentials: config.credentials,
  allowDangerousEmailAccountLinking: config.allowDangerousEmailAccountLinking,
});
```

Export password and signUp:

```ts
export { hashPassword, verifyPassword } from "./core/password.ts";
```

**Step 2: Run all tests**

Run: `bun test`
Expected: All pass

**Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: wire credentials config through createReactAuth"
```

---

### Task 10: Sample App — Add Login Form + Linked Accounts Display

**Files:**
- Modify: `sample-auth/worker.ts` — add `credentials: true, allowDangerousEmailAccountLinking: true`
- Modify: `sample-auth/pages/login.tsx` — add email/password form + registration
- Modify: `sample-auth/pages/dashboard.tsx` — show linked accounts
- Modify: `sample-auth/app.tsx` — add /register route

**Step 1: Update worker.ts**

Add to `createReactAuth` config:

```ts
credentials: true,
allowDangerousEmailAccountLinking: true,
```

**Step 2: Update login.tsx**

Add email/password form with two buttons (Sign In / Register) below the OAuth buttons. Use `signIn("credentials", { email, password })` and `signUp({ email, password })`.

**Step 3: Update dashboard.tsx**

Show linked accounts from `data.accounts`:

```tsx
const { data } = useSession();
// ...
{data.accounts && data.accounts.length > 0 && (
  <div>
    <h3>Linked Accounts</h3>
    {data.accounts.map((a) => (
      <span key={a.providerId} className="badge">{a.providerId}</span>
    ))}
  </div>
)}
```

**Step 4: Build and deploy**

```bash
cd sample-auth && bun run build.ts && bunx wrangler deploy
```

**Step 5: Commit**

```bash
git add sample-auth/
git commit -m "feat: add credentials login and linked accounts to sample app"
```

---

### Task 11: Update Documentation

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`
- Modify: `docs/plan.md`

**Step 1: Update README.md**

- Add credentials section to "Getting Started"
- Add account linking section
- Update schema diagram to show `password_hash`
- Add `signUp` to exports list
- Update auth routes table with POST routes

**Step 2: Update CLAUDE.md**

- Add `credentials: true` to AuthConfig description
- Add `allowDangerousEmailAccountLinking` docs
- Add `POST /api/auth/register` and `POST /api/auth/callback/credentials` routes
- Add `signUp` export
- Update schema to include `password_hash`

**Step 3: Update docs/plan.md**

- Add credentials flow to Auth Flow section
- Add account linking flow description
- Update schema

**Step 4: Commit**

```bash
git add README.md CLAUDE.md docs/plan.md
git commit -m "docs: update docs for credentials auth and account linking"
```

---

### Task 12: Run Full Test Suite + Deploy

**Step 1: Run all tests**

Run: `bun test`
Expected: All tests pass (92 existing + ~15 new)

**Step 2: Build sample app**

Run: `cd sample-auth && bun run build.ts`
Expected: Build complete

**Step 3: Deploy**

Run: `cd sample-auth && bunx wrangler deploy`
Expected: Deployed to https://your-worker.your-subdomain.workers.dev

**Step 4: Verify live**

- Visit https://your-worker.your-subdomain.workers.dev/login
- Test email/password registration
- Test email/password login
- Test OAuth login with same email → should link
- Dashboard should show linked accounts
