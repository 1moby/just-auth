import type { DatabaseAdapter, PreparedStatement, BoundStatement } from "../types.ts";

interface D1Database {
  prepare(sql: string): {
    bind(...params: unknown[]): {
      run(): Promise<unknown>;
      first<T = Record<string, unknown>>(): Promise<T | null>;
      all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
    };
  };
}

export function createD1Adapter(db: D1Database): DatabaseAdapter {
  return {
    prepare(sql: string): PreparedStatement {
      return {
        bind(...params: unknown[]): BoundStatement {
          const stmt = db.prepare(sql).bind(...params);
          return {
            async run() {
              await stmt.run();
              return { success: true };
            },
            async first<T = Record<string, unknown>>(): Promise<T | null> {
              return await stmt.first<T>();
            },
            async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
              const result = await stmt.all<T>();
              return { results: result.results };
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
