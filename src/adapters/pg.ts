import type { DatabaseAdapter, PreparedStatement, BoundStatement } from "../types.ts";

interface PgPool {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
}

/** Translate the framework's `?`-style SQL into Postgres `$1, $2, …` form.
 *  Defensive guard: this naive replacement is wrong if a `?` appears inside a
 *  SQL string literal (e.g. LIKE '%?%'). The framework's queries don't emit
 *  literal `?` today, but throw early if it ever happens — corrupted parameter
 *  numbering can silently flow data from one binding into the wrong column. */
function toNumbered(sql: string): string {
  if (/'[^']*\?[^']*'/.test(sql)) {
    throw new Error(
      `[just-auth/pg] SQL contains '?' inside a string literal: parameter ` +
      `numbering would be corrupted. Use a parameter placeholder instead.`
    );
  }
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

export function createPgAdapter(pool: PgPool): DatabaseAdapter {
  return {
    prepare(sql: string): PreparedStatement {
      const pgSql = toNumbered(sql);
      return {
        bind(...params: unknown[]): BoundStatement {
          return {
            async run() {
              await pool.query(pgSql, params);
              return { success: true };
            },
            async first<T = Record<string, unknown>>(): Promise<T | null> {
              const result = await pool.query(pgSql, params);
              return (result.rows[0] as T) ?? null;
            },
            async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
              const result = await pool.query(pgSql, params);
              return { results: result.rows as T[] };
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
