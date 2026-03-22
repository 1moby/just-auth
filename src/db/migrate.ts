import type { DatabaseAdapter } from "../types.ts";
import { resolveTableNames, type TableNames } from "./queries.ts";

// ─── Expected schema ────────────────────────────────────────────────

const EXPECTED_COLUMNS: Record<string, string[]> = {
  users: ["id", "email", "name", "avatar_url", "password_hash", "role"],
  accounts: ["id", "user_id", "provider_id", "provider_user_id", "access_token", "refresh_token", "expires_at"],
  sessions: ["id", "user_id", "expires_at"],
};

function schemaStatements(t: TableNames): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS ${t.users} (
      id VARCHAR(255) PRIMARY KEY,
      email VARCHAR(255) UNIQUE,
      name TEXT,
      avatar_url TEXT,
      password_hash TEXT,
      role VARCHAR(50) NOT NULL DEFAULT 'user'
    )`,
    `CREATE TABLE IF NOT EXISTS ${t.accounts} (
      id VARCHAR(255) PRIMARY KEY,
      user_id VARCHAR(255) NOT NULL,
      provider_id VARCHAR(255) NOT NULL,
      provider_user_id VARCHAR(255) NOT NULL,
      access_token TEXT,
      refresh_token TEXT,
      expires_at BIGINT,
      FOREIGN KEY (user_id) REFERENCES ${t.users}(id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS ${t.sessions} (
      id VARCHAR(255) PRIMARY KEY,
      user_id VARCHAR(255) NOT NULL,
      expires_at BIGINT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES ${t.users}(id) ON DELETE CASCADE
    )`,
  ];
}

function indexStatements(t: TableNames): string[] {
  // Index names include the table name to avoid collisions with different prefixes.
  return [
    `CREATE INDEX idx_${t.accounts}_provider ON ${t.accounts}(provider_id, provider_user_id)`,
    `CREATE INDEX idx_${t.accounts}_user ON ${t.accounts}(user_id)`,
    `CREATE INDEX idx_${t.sessions}_user ON ${t.sessions}(user_id)`,
  ];
}

function isIgnorableError(message: string): boolean {
  return (
    message.includes("duplicate column") ||
    message.includes("already exists") ||
    message.includes("Duplicate column") ||
    message.includes("Duplicate key name")
  );
}

// ─── Schema validation ──────────────────────────────────────────────

async function tableExists(db: DatabaseAdapter, tableName: string): Promise<boolean> {
  try {
    await db.prepare(`SELECT 1 FROM ${tableName} LIMIT 0`).bind().run();
    return true;
  } catch {
    return false;
  }
}

async function detectMissingColumns(
  db: DatabaseAdapter,
  tableName: string,
  expectedCols: string[]
): Promise<string[]> {
  const missing: string[] = [];
  for (const col of expectedCols) {
    try {
      await db.prepare(`SELECT ${col} FROM ${tableName} LIMIT 0`).bind().run();
    } catch {
      missing.push(col);
    }
  }
  return missing;
}

async function validateSchema(db: DatabaseAdapter, t: TableNames): Promise<boolean> {
  let valid = true;

  for (const [baseTable, expectedCols] of Object.entries(EXPECTED_COLUMNS)) {
    const tableName = t[baseTable as keyof TableNames];
    const exists = await tableExists(db, tableName);
    if (!exists) continue; // table will be created by CREATE TABLE IF NOT EXISTS

    const missingCols = await detectMissingColumns(db, tableName, expectedCols);
    if (missingCols.length === 0) continue;

    valid = false;
    const alterStatements = missingCols.map((col) => {
      if (col === "password_hash") return `  ALTER TABLE ${tableName} ADD COLUMN password_hash TEXT;`;
      if (col === "role") return `  ALTER TABLE ${tableName} ADD COLUMN role VARCHAR(50) NOT NULL DEFAULT 'user';`;
      return `  ALTER TABLE ${tableName} ADD COLUMN ${col} TEXT;`;
    });

    console.error(
      `[just-auth] Table "${tableName}" exists but is missing columns: ${missingCols.join(", ")}\n` +
      `  The library will NOT modify existing tables. Please run the following manually:\n\n` +
      alterStatements.join("\n") + "\n"
    );
  }

  return valid;
}

// ─── Public API ─────────────────────────────────────────────────────

export interface MigrateOptions {
  tablePrefix?: string;
}

export async function migrate(
  db: DatabaseAdapter,
  options?: MigrateOptions
): Promise<void> {
  const t = resolveTableNames(options?.tablePrefix);

  // Validate existing tables BEFORE creating anything.
  // If a table already exists with a mismatched schema, log the error and bail
  // for that table — never ALTER or DROP.
  const schemaValid = await validateSchema(db, t);
  if (!schemaValid) {
    console.error(
      "[just-auth] Migration aborted: fix the schema issues above, then run migrate() again.\n" +
      "  Existing data has NOT been modified."
    );
    return;
  }

  // Create tables that don't exist yet (CREATE TABLE IF NOT EXISTS is safe).
  const statements = schemaStatements(t).map((sql) => db.prepare(sql).bind());
  await db.batch(statements);

  // Create indexes — ignore "already exists" errors.
  for (const sql of indexStatements(t)) {
    try {
      await db.prepare(sql).bind().run();
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      if (!isIgnorableError(message)) {
        throw e;
      }
    }
  }
}

// Backward-compatible exports for tests
export const SCHEMA_STATEMENTS = schemaStatements(resolveTableNames());
export const INDEX_STATEMENTS = indexStatements(resolveTableNames());
