import type { DatabaseAdapter, PreparedStatement, BoundStatement } from "../types.ts";

interface MySQLPool {
  execute(sql: string, values?: unknown[]): Promise<[Record<string, unknown>[], unknown]>;
}

export function createMySQLAdapter(pool: MySQLPool): DatabaseAdapter {
  return {
    prepare(sql: string): PreparedStatement {
      return {
        bind(...params: unknown[]): BoundStatement {
          return {
            async run() {
              await pool.execute(sql, params);
              return { success: true };
            },
            async first<T = Record<string, unknown>>(): Promise<T | null> {
              const [rows] = await pool.execute(sql, params);
              return (rows[0] as T) ?? null;
            },
            async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
              const [rows] = await pool.execute(sql, params);
              return { results: rows as T[] };
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
