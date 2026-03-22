import { describe, it, expect } from "bun:test";
import { createPgAdapter } from "../src/adapters/pg.ts";
import { createMySQLAdapter } from "../src/adapters/mysql.ts";
import { createBunSQLAdapter } from "../src/adapters/bun-sql.ts";
import { createBunSQLiteAdapter } from "../src/adapters/bun-sqlite.ts";
import { createD1Adapter } from "../src/adapters/d1.ts";

describe("Pg Adapter", () => {
  it("should translate ? placeholders to $1, $2, ...", async () => {
    const queries: { text: string; values: unknown[] }[] = [];
    const mockPool = {
      async query(text: string, values?: unknown[]) {
        queries.push({ text, values: values ?? [] });
        return { rows: [{ id: "1", email: "a@b.com" }], rowCount: 1 };
      },
    };

    const db = createPgAdapter(mockPool);
    const result = await db.prepare("SELECT * FROM users WHERE id = ? AND email = ?").bind("u1", "a@b.com").first();

    expect(queries[0]!.text).toBe("SELECT * FROM users WHERE id = $1 AND email = $2");
    expect(queries[0]!.values).toEqual(["u1", "a@b.com"]);
    expect(result).toEqual({ id: "1", email: "a@b.com" });
  });

  it("should return null for first() with no rows", async () => {
    const mockPool = {
      async query() { return { rows: [], rowCount: 0 }; },
    };
    const db = createPgAdapter(mockPool);
    const result = await db.prepare("SELECT * FROM users WHERE id = ?").bind("none").first();
    expect(result).toBeNull();
  });

  it("should return results array for all()", async () => {
    const mockPool = {
      async query() { return { rows: [{ id: "1" }, { id: "2" }], rowCount: 2 }; },
    };
    const db = createPgAdapter(mockPool);
    const { results } = await db.prepare("SELECT * FROM users").bind().all();
    expect(results).toHaveLength(2);
  });

  it("should run() successfully", async () => {
    const mockPool = {
      async query() { return { rows: [], rowCount: 0 }; },
    };
    const db = createPgAdapter(mockPool);
    const result = await db.prepare("INSERT INTO users (id) VALUES (?)").bind("u1").run();
    expect(result.success).toBe(true);
  });

  it("should batch() statements", async () => {
    let count = 0;
    const mockPool = {
      async query() { count++; return { rows: [], rowCount: 0 }; },
    };
    const db = createPgAdapter(mockPool);
    const stmts = [
      db.prepare("INSERT INTO users (id) VALUES (?)").bind("u1"),
      db.prepare("INSERT INTO users (id) VALUES (?)").bind("u2"),
    ];
    await db.batch(stmts);
    expect(count).toBe(2);
  });
});

describe("MySQL Adapter", () => {
  it("should keep ? placeholders as-is", async () => {
    const queries: { sql: string; values: unknown[] }[] = [];
    const mockPool = {
      async execute(sql: string, values?: unknown[]) {
        queries.push({ sql, values: values ?? [] });
        return [[{ id: "1" }], []];
      },
    };

    const db = createMySQLAdapter(mockPool);
    await db.prepare("SELECT * FROM users WHERE id = ?").bind("u1").first();

    expect(queries[0]!.sql).toBe("SELECT * FROM users WHERE id = ?");
    expect(queries[0]!.values).toEqual(["u1"]);
  });

  it("should return null for first() with no rows", async () => {
    const mockPool = {
      async execute() { return [[], []]; },
    };
    const db = createMySQLAdapter(mockPool);
    const result = await db.prepare("SELECT * FROM users WHERE id = ?").bind("none").first();
    expect(result).toBeNull();
  });
});

describe("Bun SQL Adapter", () => {
  it("should translate ? to $1, $2, ... for postgres (default)", async () => {
    const queries: { sql: string; params: unknown[] }[] = [];
    const mockSql = {
      async unsafe(sql: string, params?: unknown[]) {
        queries.push({ sql, params: params ?? [] });
        return [{ id: "1" }];
      },
    };

    const db = createBunSQLAdapter(mockSql);
    await db.prepare("SELECT * FROM users WHERE id = ? AND name = ?").bind("u1", "test").first();

    expect(queries[0]!.sql).toBe("SELECT * FROM users WHERE id = $1 AND name = $2");
    expect(queries[0]!.params).toEqual(["u1", "test"]);
  });

  it("should keep ? placeholders for mysql dialect", async () => {
    const queries: { sql: string; params: unknown[] }[] = [];
    const mockSql = {
      async unsafe(sql: string, params?: unknown[]) {
        queries.push({ sql, params: params ?? [] });
        return [{ id: "1" }];
      },
    };

    const db = createBunSQLAdapter(mockSql, { dialect: "mysql" });
    await db.prepare("SELECT * FROM users WHERE id = ? AND name = ?").bind("u1", "test").first();

    expect(queries[0]!.sql).toBe("SELECT * FROM users WHERE id = ? AND name = ?");
    expect(queries[0]!.params).toEqual(["u1", "test"]);
  });
});

describe("Bun SQLite Adapter", () => {
  it("should wrap bun:sqlite sync methods as async", async () => {
    const mockDb = {
      prepare(sql: string) {
        return {
          run(..._params: unknown[]) {},
          get(..._params: unknown[]) { return { id: "1", email: "a@b.com" }; },
          all(..._params: unknown[]) { return [{ id: "1" }, { id: "2" }]; },
        };
      },
    };

    const db = createBunSQLiteAdapter(mockDb);

    const first = await db.prepare("SELECT * FROM users WHERE id = ?").bind("u1").first();
    expect(first).toEqual({ id: "1", email: "a@b.com" });

    const { results } = await db.prepare("SELECT * FROM users").bind().all();
    expect(results).toHaveLength(2);

    const run = await db.prepare("INSERT INTO users (id) VALUES (?)").bind("u1").run();
    expect(run.success).toBe(true);
  });
});

describe("D1 Adapter", () => {
  it("should wrap D1 methods", async () => {
    const mockD1 = {
      prepare(sql: string) {
        return {
          bind(..._params: unknown[]) {
            return {
              async run() { return {}; },
              async first<T>() { return { id: "1" } as T; },
              async all<T>() { return { results: [{ id: "1" }] as T[] }; },
            };
          },
        };
      },
    };

    const db = createD1Adapter(mockD1);

    const first = await db.prepare("SELECT * FROM users WHERE id = ?").bind("u1").first();
    expect(first).toEqual({ id: "1" });

    const { results } = await db.prepare("SELECT * FROM users").bind().all();
    expect(results).toHaveLength(1);

    const run = await db.prepare("INSERT INTO users (id) VALUES (?)").bind("u1").run();
    expect(run.success).toBe(true);
  });
});
