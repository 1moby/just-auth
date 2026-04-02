import { describe, it, expect, beforeEach } from "bun:test";
import { createHandlers } from "../src/server/handlers.ts";
import { createSessionManager } from "../src/core/session.ts";
import { resolveCookieConfig } from "../src/core/cookie.ts";
import { createMockDatabase } from "./helpers/mock-db.ts";
import { createQueries } from "../src/db/queries.ts";

describe("Security: CSRF Protection", () => {
  let db: ReturnType<typeof createMockDatabase>;
  let cookieConfig: ReturnType<typeof resolveCookieConfig>;
  let sessionManager: ReturnType<typeof createSessionManager>;

  function makeHandlers(overrides?: Record<string, unknown>) {
    return createHandlers({
      providers: new Map(),
      sessionManager,
      cookieConfig,
      queries: createQueries(db),
      basePath: "/api/auth",
      sessionMaxAge: 30 * 86400,
      credentials: true,
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

  // ── POST endpoints reject cross-origin ────────────────────────────

  describe("Cross-origin POST rejection", () => {
    const postEndpoints = [
      "/api/auth/logout",
      "/api/auth/register",
      "/api/auth/callback/credentials",
    ];

    for (const endpoint of postEndpoints) {
      it(`should reject cross-origin POST to ${endpoint}`, async () => {
        const handlers = makeHandlers();
        const res = await handlers.handleRequest(new Request(`http://localhost${endpoint}`, {
          method: "POST",
          headers: {
            "Origin": "https://evil.com",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ email: "a@b.com", password: "password" }),
        }));
        expect(res!.status).toBe(403);
        const body = await res!.json() as { error: string };
        expect(body.error).toContain("CSRF");
      });
    }

    it("should reject POST with subdomain-spoofed Origin", async () => {
      const handlers = makeHandlers();
      const res = await handlers.handleRequest(new Request("http://localhost/api/auth/logout", {
        method: "POST",
        headers: { "Origin": "http://localhost.evil.com" },
      }));
      expect(res!.status).toBe(403);
    });

    it("should reject POST with port-mismatch Origin", async () => {
      const handlers = makeHandlers();
      const res = await handlers.handleRequest(new Request("http://localhost:3000/api/auth/logout", {
        method: "POST",
        headers: { "Origin": "http://localhost:4000" },
      }));
      expect(res!.status).toBe(403);
    });

    it("should reject POST with scheme-mismatch Origin", async () => {
      const handlers = makeHandlers();
      const res = await handlers.handleRequest(new Request("https://localhost/api/auth/logout", {
        method: "POST",
        headers: { "Origin": "http://localhost" },
      }));
      expect(res!.status).toBe(403);
    });
  });

  // ── Referer fallback ──────────────────────────────────────────────

  describe("Referer header fallback", () => {
    it("should reject cross-origin Referer when no Origin header present", async () => {
      const handlers = makeHandlers();
      const res = await handlers.handleRequest(new Request("http://localhost/api/auth/logout", {
        method: "POST",
        headers: { "Referer": "https://evil.com/page" },
      }));
      expect(res!.status).toBe(403);
    });

    it("should allow same-origin Referer when no Origin header", async () => {
      const handlers = makeHandlers();
      const res = await handlers.handleRequest(new Request("http://localhost/api/auth/logout", {
        method: "POST",
        headers: { "Referer": "http://localhost/some-page" },
      }));
      expect(res!.status).toBe(200);
    });
  });

  // ── Non-browser clients ───────────────────────────────────────────

  describe("Non-browser client compatibility", () => {
    it("should allow POST without Origin or Referer (curl, server-to-server)", async () => {
      const handlers = makeHandlers();
      const res = await handlers.handleRequest(new Request("http://localhost/api/auth/logout", {
        method: "POST",
      }));
      expect(res!.status).toBe(200);
    });
  });

  // ── GET requests bypass CSRF ──────────────────────────────────────

  describe("GET requests do not require CSRF check", () => {
    it("should allow GET /session with cross-origin Origin header", async () => {
      const handlers = makeHandlers();
      const res = await handlers.handleRequest(new Request("http://localhost/api/auth/session", {
        method: "GET",
        headers: { "Origin": "https://evil.com" },
      }));
      // GET /session should succeed (returns null for no session)
      expect(res!.status).toBe(200);
    });
  });

  // ── Same-origin POST accepted ─────────────────────────────────────

  describe("Same-origin POST acceptance", () => {
    it("should allow POST with matching Origin", async () => {
      const handlers = makeHandlers();
      const res = await handlers.handleRequest(new Request("http://localhost/api/auth/logout", {
        method: "POST",
        headers: { "Origin": "http://localhost" },
      }));
      expect(res!.status).toBe(200);
    });
  });

  // ── RBAC endpoint also protected ──────────────────────────────────

  describe("RBAC endpoint CSRF protection", () => {
    it("should reject cross-origin POST to /role", async () => {
      const handlers = createHandlers({
        providers: new Map(),
        sessionManager,
        cookieConfig,
        queries: createQueries(db),
        basePath: "/api/auth",
        sessionMaxAge: 30 * 86400,
        rbac: {
          statements: {},
          roles: { admin: "*", user: {} },
          defaultRole: "user",
        },
      });

      const res = await handlers.handleRequest(new Request("http://localhost/api/auth/role", {
        method: "POST",
        headers: {
          "Origin": "https://evil.com",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ userId: "u1", role: "admin" }),
      }));
      expect(res!.status).toBe(403);
      const body = await res!.json() as { error: string };
      expect(body.error).toContain("CSRF");
    });
  });
});
