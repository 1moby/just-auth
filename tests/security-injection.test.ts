import { describe, it, expect, beforeEach } from "bun:test";
import { createHandlers } from "../src/server/handlers.ts";
import { createSessionManager } from "../src/core/session.ts";
import { resolveCookieConfig } from "../src/core/cookie.ts";
import { createMockDatabase } from "./helpers/mock-db.ts";
import { createQueries, resolveTableNames } from "../src/db/queries.ts";

describe("Security: Injection Prevention", () => {
  let db: ReturnType<typeof createMockDatabase>;
  let cookieConfig: ReturnType<typeof resolveCookieConfig>;
  let sessionManager: ReturnType<typeof createSessionManager>;

  function makeHandlers() {
    return createHandlers({
      providers: new Map(),
      sessionManager,
      cookieConfig,
      queries: createQueries(db),
      basePath: "/api/auth",
      sessionMaxAge: 30 * 86400,
      credentials: true,
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

  // ── SQL Injection in Login ────────────────────────────────────────

  describe("SQL injection in login email field", () => {
    const sqlPayloads = [
      "' OR 1=1 --",
      "'; DROP TABLE users; --",
      "admin'--",
      "' UNION SELECT * FROM users --",
      "1' OR '1'='1",
      "' OR ''='",
      "'; INSERT INTO users (id, email) VALUES ('hack', 'hack@evil.com'); --",
      "admin@test.com' AND 1=1--",
      "' OR 1=1#",
      "' OR 1=1/*",
    ];

    for (const payload of sqlPayloads) {
      it(`should safely handle SQL injection payload in email: ${JSON.stringify(payload)}`, async () => {
        const handlers = makeHandlers();

        // Register a real user
        await handlers.handleRequest(new Request("http://localhost/api/auth/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "admin@test.com", password: "securepass1" }),
        }));

        // Try to login with SQL injection payload
        const res = await handlers.handleRequest(new Request("http://localhost/api/auth/callback/credentials", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: payload, password: "anything" }),
        }));

        // Should fail authentication — NOT succeed via injection
        expect(res!.status).toBe(401);
        const body = await res!.json() as { error: string };
        expect(body.error).toBe("Invalid email or password");
      });
    }
  });

  // ── SQL Injection in Registration ─────────────────────────────────

  describe("SQL injection in registration email field", () => {
    it("should reject SQL injection in registration email", async () => {
      const handlers = makeHandlers();

      const res = await handlers.handleRequest(new Request("http://localhost/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "'; DROP TABLE users; --", password: "password123" }),
      }));

      // Should fail email validation, not execute SQL
      expect(res!.status).toBe(400);
      const body = await res!.json() as { error: string };
      expect(body.error).toContain("email");
    });

    it("should handle SQL payload that passes email regex", async () => {
      const handlers = makeHandlers();

      // This looks like a valid email but contains SQL
      const res = await handlers.handleRequest(new Request("http://localhost/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "admin'--@test.com", password: "password123" }),
      }));

      // Should either reject or safely store — not execute the injection
      // The user table should not have more than one user
      const users = db.tables.get("users") ?? [];
      expect(users.length).toBeLessThanOrEqual(1);
      // If registration succeeded, the email should be stored literally
      if (res!.status === 200) {
        expect(users[0]?.email).toBe("admin'--@test.com");
      }
    });
  });

  // ── SQL Injection in Password Field ───────────────────────────────

  describe("SQL injection in password field", () => {
    it("should safely hash password containing SQL payload", async () => {
      const handlers = makeHandlers();

      const sqlPassword = "'; DROP TABLE users; --";
      const res = await handlers.handleRequest(new Request("http://localhost/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "user@test.com", password: sqlPassword }),
      }));

      // Should succeed — the password is hashed, never interpolated into SQL
      expect(res!.status).toBe(200);

      // Verify the stored password_hash is a proper hash, not the raw SQL
      const user = db.tables.get("users")![0]!;
      expect(user.password_hash).toBeTruthy();
      expect(String(user.password_hash)).not.toContain("DROP TABLE");
      expect(String(user.password_hash)).toMatch(/^[0-9a-f]+:[0-9a-f]+$/);
    });
  });

  // ── Parameterized Query Verification ──────────────────────────────

  describe("Parameterized queries (meta-test)", () => {
    it("should use parameterized queries (? placeholders) in all SQL", async () => {
      const fs = await import("node:fs");
      const path = await import("node:path");

      const queriesContent = fs.readFileSync(
        path.join(import.meta.dir, "..", "src", "db", "queries.ts"),
        "utf-8"
      );

      // Find all SQL strings (template literals or string literals with SQL keywords)
      const sqlPattern = /prepare\(`([^`]+)`\)/g;
      let match;
      while ((match = sqlPattern.exec(queriesContent)) !== null) {
        const sql = match[1]!;
        // Check that user values use ? placeholders, not string interpolation
        // Table names from resolveTableNames are safe (validated regex)
        // but actual values must use ?
        const hasUserInterpolation = /\$\{(?!t\.|p)/.test(sql);
        if (hasUserInterpolation) {
          throw new Error(
            `Found non-table-name interpolation in SQL: ${sql}\n` +
            `All user values must use ? parameterized placeholders.`
          );
        }
      }
    });

    it("should validate table prefix to prevent SQL injection via prefix", () => {
      // Valid prefixes
      expect(() => resolveTableNames("myapp_")).not.toThrow();
      expect(() => resolveTableNames("App1")).not.toThrow();
      expect(() => resolveTableNames("")).not.toThrow();
      expect(() => resolveTableNames(undefined)).not.toThrow();

      // Invalid prefixes (SQL injection attempts)
      expect(() => resolveTableNames("'; DROP TABLE users; --")).toThrow();
      expect(() => resolveTableNames("users; DROP")).toThrow();
      expect(() => resolveTableNames("a b")).toThrow();
      expect(() => resolveTableNames("a-b")).toThrow();
      expect(() => resolveTableNames("test'")).toThrow();
    });
  });

  // ── NoSQL-style Injection ─────────────────────────────────────────

  describe("NoSQL-style injection payloads", () => {
    it("should treat object payloads as invalid (not as query operators)", async () => {
      const handlers = makeHandlers();

      // Try sending an object where a string is expected
      const res = await handlers.handleRequest(new Request("http://localhost/api/auth/callback/credentials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: { "$gt": "" }, password: "test" }),
      }));

      // Should reject — must not authenticate
      expect([400, 401]).toContain(res!.status);
    });

    it("should treat null email as invalid", async () => {
      const handlers = makeHandlers();

      const res = await handlers.handleRequest(new Request("http://localhost/api/auth/callback/credentials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: null, password: "test" }),
      }));

      expect(res!.status).toBe(400);
    });

    it("should treat array email as invalid", async () => {
      const handlers = makeHandlers();

      const res = await handlers.handleRequest(new Request("http://localhost/api/auth/callback/credentials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: ["admin@test.com"], password: "test" }),
      }));

      // Should not authenticate
      expect([400, 401]).toContain(res!.status);
    });
  });

  // ── XSS in Stored Fields ──────────────────────────────────────────

  describe("XSS payloads in stored fields", () => {
    it("should store XSS payload literally (not execute it)", async () => {
      const handlers = makeHandlers();

      const xssName = "<script>alert('xss')</script>";
      const res = await handlers.handleRequest(new Request("http://localhost/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "user@test.com", password: "password123", name: xssName }),
      }));

      expect(res!.status).toBe(200);
      // Name should be stored verbatim (escaping is the frontend's responsibility)
      const user = db.tables.get("users")![0]!;
      expect(user.name).toBe(xssName);
    });
  });
});
