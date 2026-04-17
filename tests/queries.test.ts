import { describe, it, expect, beforeEach } from "bun:test";
import { createQueries, type Queries } from "../src/db/queries.ts";
import { createMockDatabase } from "./helpers/mock-db.ts";

describe("Database Queries", () => {
  let db: ReturnType<typeof createMockDatabase>;
  let q: Queries;

  beforeEach(() => {
    db = createMockDatabase();
    q = createQueries(db);
  });

  describe("User operations", () => {
    it("should create a user", async () => {
      const user = await q.createUser({
        id: "u1",
        email: "alice@example.com",
        name: "Alice",
        avatarUrl: "https://example.com/avatar.png",
      });
      expect(user.id).toBe("u1");
      expect(user.email).toBe("alice@example.com");
      expect(user.name).toBe("Alice");
    });

    it("should get user by ID", async () => {
      await q.createUser({
        id: "u1",
        email: "alice@example.com",
        name: "Alice",
        avatarUrl: null,
      });
      const found = await q.getUserById("u1");
      expect(found).not.toBeNull();
      expect(found!.id).toBe("u1");
      expect(found!.email).toBe("alice@example.com");
    });

    it("should return null for non-existent user by ID", async () => {
      const found = await q.getUserById("nonexistent");
      expect(found).toBeNull();
    });

    it("should get user by email", async () => {
      await q.createUser({
        id: "u1",
        email: "alice@example.com",
        name: "Alice",
        avatarUrl: null,
      });
      const found = await q.getUserByEmail("alice@example.com");
      expect(found).not.toBeNull();
      expect(found!.id).toBe("u1");
    });

    it("should return null for non-existent email", async () => {
      const found = await q.getUserByEmail("nobody@example.com");
      expect(found).toBeNull();
    });

    it("should update user role", async () => {
      await q.createUser({ id: "u1", email: "a@b.com", name: "A", avatarUrl: null });
      await q.updateUserRole("u1", "admin");
      const user = await q.getUserById("u1");
      expect(user?.role).toBe("admin");
    });

    it("should create user with null fields", async () => {
      const user = await q.createUser({
        id: "u2",
        email: null,
        name: null,
        avatarUrl: null,
      });
      expect(user.email).toBeNull();
      expect(user.name).toBeNull();
    });
  });

  describe("Account operations", () => {
    beforeEach(async () => {
      await q.createUser({
        id: "u1",
        email: "alice@example.com",
        name: "Alice",
        avatarUrl: null,
      });
    });

    it("should create an account", async () => {
      await q.createAccount({
        id: "a1",
        userId: "u1",
        providerId: "github",
        providerUserId: "gh-123",
        accessToken: "tok-abc",
        refreshToken: null,
        expiresAt: null,
      });
      const rows = db.tables.get("accounts");
      expect(rows).toHaveLength(1);
      expect(rows![0]!.provider_id).toBe("github");
    });

    it("should get account by provider", async () => {
      await q.createAccount({
        id: "a1",
        userId: "u1",
        providerId: "github",
        providerUserId: "gh-123",
        accessToken: "tok-abc",
        refreshToken: null,
        expiresAt: null,
      });
      const account = await q.getAccountByProvider("github", "gh-123");
      expect(account).not.toBeNull();
      expect(account!.userId).toBe("u1");
      expect(account!.accessToken).toBe("tok-abc");
    });

    it("should return null for non-existent account", async () => {
      const account = await q.getAccountByProvider("github", "nonexistent");
      expect(account).toBeNull();
    });

    it("should get user by account", async () => {
      await q.createAccount({
        id: "a1",
        userId: "u1",
        providerId: "github",
        providerUserId: "gh-123",
        accessToken: "tok",
        refreshToken: null,
        expiresAt: null,
      });
      const user = await q.getUserByAccount("github", "gh-123");
      expect(user).not.toBeNull();
      expect(user!.id).toBe("u1");
      expect(user!.email).toBe("alice@example.com");
    });

    it("should return null when no user linked to account", async () => {
      const user = await q.getUserByAccount("github", "nonexistent");
      expect(user).toBeNull();
    });

    it("should get all accounts by user ID", async () => {
      await q.createAccount({
        id: "a1",
        userId: "u1",
        providerId: "github",
        providerUserId: "gh-123",
        accessToken: "tok-abc",
        refreshToken: null,
        expiresAt: null,
      });
      await q.createAccount({
        id: "a2",
        userId: "u1",
        providerId: "google",
        providerUserId: "go-456",
        accessToken: "tok-def",
        refreshToken: "ref-def",
        expiresAt: 1234567890,
      });
      const accounts = await q.getAccountsByUserId("u1");
      expect(accounts).toHaveLength(2);
      expect(accounts[0]!.providerId).toBe("github");
      expect(accounts[1]!.providerId).toBe("google");
      expect(accounts[1]!.refreshToken).toBe("ref-def");
    });

    it("should return empty array when user has no accounts", async () => {
      const accounts = await q.getAccountsByUserId("u1");
      expect(accounts).toHaveLength(0);
    });
  });

  describe("Session operations", () => {
    beforeEach(async () => {
      await q.createUser({
        id: "u1",
        email: "alice@example.com",
        name: "Alice",
        avatarUrl: "https://example.com/a.png",
      });
    });

    it("should insert a session", async () => {
      await q.insertSession({
        id: "sess-1",
        userId: "u1",
        expiresAt: Date.now() + 86400000,
      });
      const rows = db.tables.get("sessions");
      expect(rows).toHaveLength(1);
      expect(rows![0]!.id).toBe("sess-1");
    });

    it("should get session and user", async () => {
      const expiresAt = Date.now() + 86400000;
      await q.insertSession({ id: "sess-1", userId: "u1", expiresAt });

      const result = await q.getSessionAndUser("sess-1");
      expect(result).not.toBeNull();
      expect(result!.session.id).toBe("sess-1");
      expect(result!.session.userId).toBe("u1");
      expect(result!.user.id).toBe("u1");
      expect(result!.user.email).toBe("alice@example.com");
      expect(result!.user.avatarUrl).toBe("https://example.com/a.png");
    });

    it("should return null for non-existent session", async () => {
      const result = await q.getSessionAndUser("nonexistent");
      expect(result).toBeNull();
    });

    it("should update session expiry", async () => {
      await q.insertSession({
        id: "sess-1",
        userId: "u1",
        expiresAt: 1000,
      });
      await q.updateSessionExpiry("sess-1", 9999);
      const rows = db.tables.get("sessions")!;
      expect(rows[0]!.expires_at).toBe(9999);
    });

    it("should delete a session", async () => {
      await q.insertSession({
        id: "sess-1",
        userId: "u1",
        expiresAt: Date.now() + 86400000,
      });
      await q.deleteSession("sess-1");
      const rows = db.tables.get("sessions")!;
      expect(rows).toHaveLength(0);
    });

    it("should delete all sessions for a user", async () => {
      await q.insertSession({
        id: "sess-1",
        userId: "u1",
        expiresAt: Date.now() + 86400000,
      });
      await q.insertSession({
        id: "sess-2",
        userId: "u1",
        expiresAt: Date.now() + 86400000,
      });
      await q.deleteUserSessions("u1");
      const rows = db.tables.get("sessions")!;
      expect(rows).toHaveLength(0);
    });
  });

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

    it("does not let extraColumns override base identity columns", async () => {
      await q.createUser(
        { id: "real-id", email: "real@x.com", name: "Real", avatarUrl: null },
        { id: "attacker-id", email: "attacker@y.com", org_id: "org-7" }
      );
      const rows = db.tables.get("users")!;
      expect(rows[0]!.id).toBe("real-id");
      expect(rows[0]!.email).toBe("real@x.com");
      expect(rows[0]!.org_id).toBe("org-7");
    });
  });

  describe("Table prefix", () => {
    it("should use prefixed table names", async () => {
      const pq = createQueries(db, "app_");
      expect(pq.tableNames.users).toBe("app_users");
      expect(pq.tableNames.accounts).toBe("app_accounts");
      expect(pq.tableNames.sessions).toBe("app_sessions");
    });

    it("should reject invalid prefix characters", () => {
      expect(() => createQueries(db, "my-prefix")).toThrow("Invalid tablePrefix");
      expect(() => createQueries(db, "has space")).toThrow("Invalid tablePrefix");
      expect(() => createQueries(db, "drop;--")).toThrow("Invalid tablePrefix");
    });

    it("should store data in prefixed tables", async () => {
      const pq = createQueries(db, "test_");
      await pq.createUser({ id: "u1", email: "a@b.com", name: "A", avatarUrl: null });
      expect(db.tables.get("test_users")).toHaveLength(1);
      expect(db.tables.has("users")).toBe(false);
    });
  });
});
