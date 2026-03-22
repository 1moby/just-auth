import type { DatabaseAdapter, PreparedStatement, BoundStatement } from "../types.ts";

interface BunSQLiteDatabase {
  prepare(sql: string): {
    run(...params: unknown[]): void;
    get(...params: unknown[]): Record<string, unknown> | null;
    all(...params: unknown[]): Record<string, unknown>[];
  };
}

export function createBunSQLiteAdapter(db: BunSQLiteDatabase): DatabaseAdapter {
  return {
    prepare(sql: string): PreparedStatement {
      return {
        bind(...params: unknown[]): BoundStatement {
          return {
            async run() {
              db.prepare(sql).run(...params);
              return { success: true };
            },
            async first<T = Record<string, unknown>>(): Promise<T | null> {
              return (db.prepare(sql).get(...params) as T) ?? null;
            },
            async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
              return { results: db.prepare(sql).all(...params) as T[] };
            },
          };
        },
      };
    },
    async batch<T>(statements: (PreparedStatement | BoundStatement)[]) {
      const results: T[] = [];
      for (const stmt of statements) {
        results.push(await (stmt as BoundStatement).run() as T);
      }
      return results;
    },
  };
}
