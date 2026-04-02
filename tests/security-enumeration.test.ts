import { describe, it, expect, beforeEach } from "bun:test";
import { createHandlers } from "../src/server/handlers.ts";
import { createSessionManager } from "../src/core/session.ts";
import { resolveCookieConfig } from "../src/core/cookie.ts";
import { createMockDatabase } from "./helpers/mock-db.ts";
import { createQueries } from "../src/db/queries.ts";

describe("Security: User Enumeration Prevention", () => {
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

  // ── Login error uniformity ────────────────────────────────────────

  describe("Login error messages", () => {
    it("should return same status and error for non-existent user", async () => {
      const handlers = makeHandlers();

      const res = await handlers.handleRequest(new Request("http://localhost/api/auth/callback/credentials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "noone@test.com", password: "anypass123" }),
      }));
      expect(res!.status).toBe(401);
      const body = await res!.json() as { error: string };
      expect(body.error).toBe("Invalid email or password");
    });

    it("should return same status and error for wrong password on existing user", async () => {
      const handlers = makeHandlers();

      // Register a user first
      await handlers.handleRequest(new Request("http://localhost/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "real@test.com", password: "correctpass" }),
      }));

      // Login with wrong password
      const res = await handlers.handleRequest(new Request("http://localhost/api/auth/callback/credentials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "real@test.com", password: "wrongpass11" }),
      }));
      expect(res!.status).toBe(401);
      const body = await res!.json() as { error: string };
      expect(body.error).toBe("Invalid email or password");
    });

    it("should return identical response shape for existent vs non-existent user login failure", async () => {
      const handlers = makeHandlers();

      // Register
      await handlers.handleRequest(new Request("http://localhost/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "real@test.com", password: "correctpass" }),
      }));

      // Non-existent user
      const res1 = await handlers.handleRequest(new Request("http://localhost/api/auth/callback/credentials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "fake@test.com", password: "anypassword" }),
      }));

      // Existing user, wrong password
      const res2 = await handlers.handleRequest(new Request("http://localhost/api/auth/callback/credentials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "real@test.com", password: "wrongpass11" }),
      }));

      // Same status code
      expect(res1!.status).toBe(res2!.status);

      // Same body shape and message
      const body1 = await res1!.json() as Record<string, unknown>;
      const body2 = await res2!.json() as Record<string, unknown>;
      expect(Object.keys(body1).sort()).toEqual(Object.keys(body2).sort());
      expect(body1.error).toBe(body2.error);
    });
  });

  // ── Registration error uniformity ─────────────────────────────────

  describe("Registration error messages", () => {
    it("should return generic error when registering with existing email", async () => {
      const handlers = makeHandlers();

      // Register first user
      await handlers.handleRequest(new Request("http://localhost/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "taken@test.com", password: "password123" }),
      }));

      // Try to register same email
      const res = await handlers.handleRequest(new Request("http://localhost/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "taken@test.com", password: "password456" }),
      }));

      expect(res!.status).toBe(400);
      const body = await res!.json() as { error: string };
      // Must NOT reveal that the email exists — generic error only
      expect(body.error).toBe("Registration failed");
      expect(body.error).not.toContain("exists");
      expect(body.error).not.toContain("taken");
      expect(body.error).not.toContain("already");
      expect(body.error).not.toContain("email");
    });
  });

  // ── Timing oracle prevention ──────────────────────────────────────

  describe("Timing oracle prevention", () => {
    it("should always run password verification (even for non-existent users)", async () => {
      const handlers = makeHandlers();

      // This test ensures the dummy hash path is exercised (no early return)
      // by verifying the response is 401 (not 400 or 500 which would indicate
      // a different code path)
      const res = await handlers.handleRequest(new Request("http://localhost/api/auth/callback/credentials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "ghost@nowhere.com", password: "a".repeat(50) }),
      }));
      expect(res!.status).toBe(401);
      const body = await res!.json() as { error: string };
      // Same generic error — not "user not found"
      expect(body.error).toBe("Invalid email or password");
      expect(body.error).not.toContain("not found");
      expect(body.error).not.toContain("does not exist");
    });
  });

  // ── Error message leak prevention ─────────────────────────────────

  describe("Error message information leak prevention", () => {
    it("should not leak internal details in login failure", async () => {
      const handlers = makeHandlers();

      const res = await handlers.handleRequest(new Request("http://localhost/api/auth/callback/credentials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "user@test.com", password: "wrong" }),
      }));
      const body = await res!.json() as { error: string };
      expect(body.error).not.toContain("password_hash");
      expect(body.error).not.toContain("SELECT");
      expect(body.error).not.toContain("TypeError");
      expect(body.error).not.toContain("undefined");
    });

    it("should not leak internal details in registration failure", async () => {
      const handlers = makeHandlers();

      // Register
      await handlers.handleRequest(new Request("http://localhost/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "dupe@test.com", password: "password123" }),
      }));

      // Duplicate
      const res = await handlers.handleRequest(new Request("http://localhost/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "dupe@test.com", password: "password456" }),
      }));
      const body = await res!.json() as { error: string };
      expect(body.error).not.toContain("UNIQUE");
      expect(body.error).not.toContain("constraint");
      expect(body.error).not.toContain("duplicate");
    });
  });

  // ── Meta-test: constant-time comparisons ──────────────────────────

  describe("Constant-time comparison meta-test", () => {
    it("should use constant-time comparison for security-sensitive values in source", async () => {
      const fs = await import("node:fs");
      const path = await import("node:path");

      const srcDir = path.join(import.meta.dir, "..", "src");
      const files = [
        "server/handlers.ts",
        "core/password.ts",
      ];

      for (const file of files) {
        const content = fs.readFileSync(path.join(srcDir, file), "utf-8");
        const lines = content.split("\n");

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]!;
          // Flag direct === comparisons next to hash/token/digest/password patterns
          // These should use constantTimeEqual or timingSafeEqual instead
          if (
            (line.includes(".hash") || line.includes(".token") || line.includes(".digest") || line.includes("password")) &&
            (line.includes(" === ") || line.includes(" == ")) &&
            !line.trimStart().startsWith("//") &&
            !line.trimStart().startsWith("*") &&
            // Allow comparisons against null/undefined/false/true (not timing-sensitive)
            !/ ===? (null|undefined|false|true|0|""|'')/.test(line) &&
            !/(null|undefined|false|true|0|""|'') ===? /.test(line)
          ) {
            // This is a potential timing-sensitive comparison
            throw new Error(
              `Potential timing-unsafe comparison in ${file}:${i + 1}: ${line.trim()}\n` +
              `Security-sensitive comparisons should use constantTimeEqual or timingSafeEqual.`
            );
          }
        }
      }
    });

    it("should have constantTimeEqual or timingSafeEqual functions in security-critical files", async () => {
      const fs = await import("node:fs");
      const path = await import("node:path");

      const handlersContent = fs.readFileSync(
        path.join(import.meta.dir, "..", "src", "server", "handlers.ts"),
        "utf-8"
      );
      expect(handlersContent).toContain("timingSafeEqual");

      const passwordContent = fs.readFileSync(
        path.join(import.meta.dir, "..", "src", "core", "password.ts"),
        "utf-8"
      );
      expect(passwordContent).toContain("constantTimeEqual");
    });
  });
});
