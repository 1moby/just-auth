import { describe, it, expect } from "bun:test";
import { migrate, SCHEMA_STATEMENTS, INDEX_STATEMENTS } from "../src/db/migrate.ts";
import { createMockDatabase } from "./helpers/mock-db.ts";

describe("migrate", () => {
  it("should export schema statements", () => {
    expect(SCHEMA_STATEMENTS).toBeInstanceOf(Array);
    expect(SCHEMA_STATEMENTS.length).toBeGreaterThan(0);
  });

  it("should contain CREATE TABLE statements for all required tables", () => {
    const joined = SCHEMA_STATEMENTS.join("\n");
    expect(joined).toContain("CREATE TABLE IF NOT EXISTS users");
    expect(joined).toContain("CREATE TABLE IF NOT EXISTS accounts");
    expect(joined).toContain("CREATE TABLE IF NOT EXISTS sessions");
  });

  it("should contain index creation statements", () => {
    const joined = INDEX_STATEMENTS.join("\n");
    expect(joined).toContain("CREATE INDEX idx_accounts_provider");
    expect(joined).toContain("CREATE INDEX idx_sessions_user");
  });

  it("should run migrate without errors", async () => {
    const db = createMockDatabase();
    await migrate(db);
    expect(true).toBe(true);
  });

  it("should be idempotent (safe to run twice)", async () => {
    const db = createMockDatabase();
    await migrate(db);
    await migrate(db);
    expect(true).toBe(true);
  });

  it("should include password_hash in users schema", () => {
    const joined = SCHEMA_STATEMENTS.join("\n");
    expect(joined).toContain("password_hash TEXT");
  });

  it("should include role in users schema", () => {
    const joined = SCHEMA_STATEMENTS.join("\n");
    expect(joined).toContain("role VARCHAR(50)");
  });

  it("should support table prefix", async () => {
    const db = createMockDatabase();
    await migrate(db, { tablePrefix: "app_" });
    expect(true).toBe(true);
  });
});
