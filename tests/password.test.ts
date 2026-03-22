import { describe, it, expect } from "bun:test";
import { hashPassword, verifyPassword } from "../src/core/password.ts";

describe("Password hashing", () => {
  it("should hash a password and return salt:hash format", async () => {
    const hashed = await hashPassword("mypassword");
    expect(hashed).toContain(":");
    const [salt, hash] = hashed.split(":");
    expect(salt!.length).toBe(32);
    expect(hash!.length).toBe(64);
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
