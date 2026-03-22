import { describe, it, expect, beforeEach } from "bun:test";
import {
  generateSessionToken,
  hashToken,
  createSessionManager,
} from "../src/core/session.ts";
import { createMockDatabase } from "./helpers/mock-db.ts";
import { createQueries } from "../src/db/queries.ts";

describe("generateSessionToken", () => {
  it("should generate a non-empty string", () => {
    const token = generateSessionToken();
    expect(token).toBeTruthy();
    expect(typeof token).toBe("string");
  });

  it("should generate unique tokens", () => {
    const tokens = new Set(Array.from({ length: 100 }, () => generateSessionToken()));
    expect(tokens.size).toBe(100);
  });

  it("should generate base64url-encoded tokens", () => {
    const token = generateSessionToken();
    // base64url uses only A-Z, a-z, 0-9, -, _
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("hashToken", () => {
  it("should return a hex string", async () => {
    const hash = await hashToken("test-token");
    expect(hash).toMatch(/^[0-9a-f]+$/);
  });

  it("should return consistent results for the same input", async () => {
    const hash1 = await hashToken("same-token");
    const hash2 = await hashToken("same-token");
    expect(hash1).toBe(hash2);
  });

  it("should return different results for different inputs", async () => {
    const hash1 = await hashToken("token-a");
    const hash2 = await hashToken("token-b");
    expect(hash1).not.toBe(hash2);
  });

  it("should return a 64-character SHA-256 hash", async () => {
    const hash = await hashToken("any-token");
    expect(hash.length).toBe(64);
  });
});

describe("createSessionManager", () => {
  let db: ReturnType<typeof createMockDatabase>;

  beforeEach(() => {
    db = createMockDatabase();
    // Seed a user
    db.tables.set("users", [
      { id: "user-1", email: "test@example.com", name: "Test User", avatar_url: null },
    ]);
    db.tables.set("sessions", []);
  });

  it("should create a session with token", async () => {
    const manager = createSessionManager(createQueries(db));
    const { session, token } = await manager.createSession("user-1");

    expect(token).toBeTruthy();
    expect(session.userId).toBe("user-1");
    expect(session.expiresAt).toBeInstanceOf(Date);
    expect(session.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("should create a session that expires in ~30 days by default", async () => {
    const manager = createSessionManager(createQueries(db));
    const { session } = await manager.createSession("user-1");

    const expectedExpiry = Date.now() + 30 * 86400 * 1000;
    const diff = Math.abs(session.expiresAt.getTime() - expectedExpiry);
    expect(diff).toBeLessThan(1000); // within 1 second
  });

  it("should validate a valid session", async () => {
    const manager = createSessionManager(createQueries(db));
    const { token } = await manager.createSession("user-1");

    const result = await manager.validateSession(token);
    expect(result).not.toBeNull();
    expect(result!.user.id).toBe("user-1");
    expect(result!.user.email).toBe("test@example.com");
    expect(result!.session.userId).toBe("user-1");
  });

  it("should return null for an invalid token", async () => {
    const manager = createSessionManager(createQueries(db));
    const result = await manager.validateSession("invalid-token");
    expect(result).toBeNull();
  });

  it("should return null for an expired session", async () => {
    const manager = createSessionManager(createQueries(db), { maxAge: 0 });
    const { token } = await manager.createSession("user-1");

    // Session was created with 0 maxAge, so it's already expired
    const result = await manager.validateSession(token);
    expect(result).toBeNull();
  });

  it("should invalidate a session", async () => {
    const manager = createSessionManager(createQueries(db));
    const { token, session } = await manager.createSession("user-1");

    await manager.invalidateSession(session.id);

    const result = await manager.validateSession(token);
    expect(result).toBeNull();
  });

  it("should extend session with sliding window when near expiry", async () => {
    const manager = createSessionManager(createQueries(db), {
      maxAge: 30 * 86400,
      refreshThreshold: 30 * 86400, // always refresh
    });
    const { token } = await manager.createSession("user-1");

    const result = await manager.validateSession(token);
    expect(result).not.toBeNull();
    // Session should have been extended
    const newExpiry = result!.session.expiresAt.getTime();
    const expectedMin = Date.now() + 29 * 86400 * 1000;
    expect(newExpiry).toBeGreaterThan(expectedMin);
  });

  it("should respect custom maxAge", async () => {
    const manager = createSessionManager(createQueries(db), { maxAge: 3600 }); // 1 hour
    const { session } = await manager.createSession("user-1");

    const expectedExpiry = Date.now() + 3600 * 1000;
    const diff = Math.abs(session.expiresAt.getTime() - expectedExpiry);
    expect(diff).toBeLessThan(1000);
  });

  it("should generate unique tokens for each session", async () => {
    const manager = createSessionManager(createQueries(db));
    const result1 = await manager.createSession("user-1");
    const result2 = await manager.createSession("user-1");

    expect(result1.token).not.toBe(result2.token);
    expect(result1.session.id).not.toBe(result2.session.id);
  });
});
