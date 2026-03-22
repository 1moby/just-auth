import { Database } from "bun:sqlite";
import type {
  DatabaseAdapter,
  PreparedStatement,
  BoundStatement,
} from "../src/types.ts";

export function createSQLiteAdapter(dbPath: string): DatabaseAdapter {
  const db = new Database(dbPath);
  db.run("PRAGMA journal_mode=WAL");
  db.run("PRAGMA foreign_keys=ON");

  return {
    prepare(sql: string): PreparedStatement {
      return {
        bind(...params: unknown[]): BoundStatement {
          return {
            async run() {
              db.run(sql, params as any[]);
              return { success: true };
            },
            async first<T = Record<string, unknown>>(): Promise<T | null> {
              const result = db.query(sql).get(...(params as any[]));
              return (result as T) ?? null;
            },
            async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
              const results = db.query(sql).all(...(params as any[]));
              return { results: results as T[] };
            },
          };
        },
      };
    },
    async batch(statements: BoundStatement[]): Promise<unknown[]> {
      const results: unknown[] = [];
      for (const stmt of statements) {
        results.push(await stmt.run());
      }
      return results;
    },
  };
}
