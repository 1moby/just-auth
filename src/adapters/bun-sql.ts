import type { DatabaseAdapter, PreparedStatement, BoundStatement } from "../types.ts";

/**
 * Bun's built-in SQL interface (bun:sql).
 * Uses `unsafe()` for dynamic SQL with parameter binding.
 */
interface BunSQL {
  unsafe(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
}

function toNumbered(sql: string): string {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

export interface BunSQLAdapterOptions {
  /** Set to "mysql" to keep ? placeholders instead of converting to $1,$2. */
  dialect?: "postgres" | "mysql";
}

export function createBunSQLAdapter(
  sql: BunSQL,
  options?: BunSQLAdapterOptions,
): DatabaseAdapter {
  const useNumbered = options?.dialect !== "mysql";

  return {
    prepare(rawSql: string): PreparedStatement {
      const finalSql = useNumbered ? toNumbered(rawSql) : rawSql;
      return {
        bind(...params: unknown[]): BoundStatement {
          return {
            async run() {
              await sql.unsafe(finalSql, params);
              return { success: true };
            },
            async first<T = Record<string, unknown>>(): Promise<T | null> {
              const rows = await sql.unsafe(finalSql, params);
              return (rows[0] as T) ?? null;
            },
            async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
              const rows = await sql.unsafe(finalSql, params);
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
