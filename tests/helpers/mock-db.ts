import type {
  DatabaseAdapter,
  PreparedStatement,
  BoundStatement,
} from "../../src/types.ts";

interface TableRow {
  [key: string]: unknown;
}

export function createMockDatabase(): DatabaseAdapter & {
  tables: Map<string, TableRow[]>;
  reset(): void;
} {
  const tables = new Map<string, TableRow[]>();

  function ensureTable(name: string): TableRow[] {
    if (!tables.has(name)) {
      tables.set(name, []);
    }
    return tables.get(name)!;
  }

  function reset() {
    tables.clear();
  }

  function prepare(sql: string): PreparedStatement {
    return {
      bind(...params: unknown[]): BoundStatement {
        return {
          async run(): Promise<{ success: boolean }> {
            executeSql(sql, params);
            return { success: true };
          },
          async first<T = Record<string, unknown>>(): Promise<T | null> {
            const results = executeSql(sql, params);
            return (results[0] as T) ?? null;
          },
          async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
            const results = executeSql(sql, params);
            return { results: results as T[] };
          },
        };
      },
    };
  }

  async function batch(statements: BoundStatement[]): Promise<unknown[]> {
    const results: unknown[] = [];
    for (const stmt of statements) {
      results.push(await stmt.run());
    }
    return results;
  }

  function executeSql(sql: string, params: unknown[]): TableRow[] {
    const normalizedSql = sql.replace(/\s+/g, " ").trim().toUpperCase();

    // CREATE TABLE / CREATE INDEX / ALTER TABLE - no-op for mock
    if (normalizedSql.startsWith("CREATE TABLE") || normalizedSql.startsWith("CREATE INDEX") || normalizedSql.startsWith("ALTER TABLE")) {
      return [];
    }

    // INSERT
    if (normalizedSql.startsWith("INSERT INTO")) {
      const tableMatch = sql.match(/INSERT INTO (\w+)/i);
      if (!tableMatch) return [];
      const tableName = tableMatch[1]!;
      const colMatch = sql.match(/\(([^)]+)\)\s*VALUES/i);
      if (!colMatch) return [];
      const columns = colMatch[1]!.split(",").map((c) => c.trim());
      const row: TableRow = {};
      columns.forEach((col, i) => {
        row[col] = params[i] ?? null;
      });
      ensureTable(tableName).push(row);
      return [];
    }

    // SELECT with JOIN
    if (normalizedSql.includes("INNER JOIN") || normalizedSql.includes("JOIN")) {
      return handleJoinSelect(sql, params);
    }

    // SELECT
    if (normalizedSql.startsWith("SELECT")) {
      return handleSelect(sql, params);
    }

    // UPDATE
    if (normalizedSql.startsWith("UPDATE")) {
      return handleUpdate(sql, params);
    }

    // DELETE
    if (normalizedSql.startsWith("DELETE FROM")) {
      return handleDelete(sql, params);
    }

    return [];
  }

  function handleSelect(sql: string, params: unknown[]): TableRow[] {
    const tableMatch = sql.match(/FROM\s+(\w+)/i);
    if (!tableMatch) return [];
    const tableName = tableMatch[1]!;
    const rows = ensureTable(tableName);
    const conditions = extractConditions(sql, params);
    return rows.filter((row) => matchesConditions(row, conditions));
  }

  function handleJoinSelect(sql: string, params: unknown[]): TableRow[] {
    // Handle user-account join
    if (sql.includes("accounts") && sql.includes("users")) {
      const users = ensureTable("users");
      const accounts = ensureTable("accounts");
      const conditions = extractConditions(sql, params);

      // Find matching accounts
      const matchingAccounts = accounts.filter((account) => {
        return conditions.every(({ column, value }) => {
          // Map joined column references
          const col = column.replace(/^a\./, "").replace(/^u\./, "");
          if (col in account) return account[col] === value;
          return true;
        });
      });

      // Join with users
      return matchingAccounts
        .map((account) => {
          const user = users.find((u) => u.id === account.user_id);
          if (!user) return null;
          return { ...user };
        })
        .filter(Boolean) as TableRow[];
    }

    // Handle session-user join
    if (sql.includes("sessions") && sql.includes("users")) {
      const sessions = ensureTable("sessions");
      const users = ensureTable("users");

      // Get session ID from params
      const sessionId = params[0];
      const session = sessions.find((s) => s.id === sessionId);
      if (!session) return [];

      const user = users.find((u) => u.id === session.user_id);
      if (!user) return [];

      return [
        {
          id: session.id,
          user_id: session.user_id,
          expires_at: session.expires_at,
          user_email: user.email,
          user_name: user.name,
          user_avatar_url: user.avatar_url,
          user_role: user.role,
        },
      ];
    }

    return [];
  }

  function handleUpdate(sql: string, params: unknown[]): TableRow[] {
    const tableMatch = sql.match(/UPDATE\s+(\w+)/i);
    if (!tableMatch) return [];
    const tableName = tableMatch[1]!;
    const rows = ensureTable(tableName);

    // Parse SET clause
    const setMatch = sql.match(/SET\s+(.+?)\s+WHERE/i);
    if (!setMatch) return [];
    const setClauses = setMatch[1]!.split(",").map((c) => c.trim());
    const setColumns: string[] = [];
    setClauses.forEach((clause) => {
      const col = clause.split("=")[0]!.trim();
      setColumns.push(col);
    });

    // SET params come first, then WHERE params
    const setValues = params.slice(0, setColumns.length);
    const whereParams = params.slice(setColumns.length);

    const whereConditions = extractWhereConditions(sql, whereParams);

    rows.forEach((row) => {
      if (matchesConditions(row, whereConditions)) {
        setColumns.forEach((col, i) => {
          row[col] = setValues[i];
        });
      }
    });

    return [];
  }

  function handleDelete(sql: string, params: unknown[]): TableRow[] {
    const tableMatch = sql.match(/DELETE FROM\s+(\w+)/i);
    if (!tableMatch) return [];
    const tableName = tableMatch[1]!;
    const rows = ensureTable(tableName);
    const conditions = extractConditions(sql, params);

    const toKeep = rows.filter((row) => !matchesConditions(row, conditions));
    tables.set(tableName, toKeep);

    return [];
  }

  function extractConditions(
    sql: string,
    params: unknown[]
  ): { column: string; value: unknown }[] {
    const whereMatch = sql.match(/WHERE\s+(.+?)(?:\s*$|\s*ORDER|\s*LIMIT|\s*GROUP)/i);
    if (!whereMatch) return [];
    return extractColumnsFromWhere(whereMatch[1]!, params);
  }

  function extractWhereConditions(
    sql: string,
    params: unknown[]
  ): { column: string; value: unknown }[] {
    const whereMatch = sql.match(/WHERE\s+(.+?)(?:\s*$|\s*ORDER|\s*LIMIT|\s*GROUP)/i);
    if (!whereMatch) return [];
    return extractColumnsFromWhere(whereMatch[1]!, params);
  }

  function extractColumnsFromWhere(
    whereClause: string,
    params: unknown[]
  ): { column: string; value: unknown }[] {
    const conditions: { column: string; value: unknown }[] = [];
    const parts = whereClause.split(/\s+AND\s+/i);
    let paramIdx = 0;

    for (const part of parts) {
      const colMatch = part.match(/([\w.]+)\s*=\s*\?/);
      if (colMatch) {
        const col = colMatch[1]!.replace(/^[a-z]\./, "");
        conditions.push({ column: col, value: params[paramIdx] });
        paramIdx++;
      }
      // Handle > comparisons (e.g., expires_at > ?)
      const gtMatch = part.match(/([\w.]+)\s*>\s*\?/);
      if (gtMatch) {
        paramIdx++; // consume the param but skip for basic matching
      }
    }

    return conditions;
  }

  function matchesConditions(
    row: TableRow,
    conditions: { column: string; value: unknown }[]
  ): boolean {
    return conditions.every(({ column, value }) => row[column] === value);
  }

  return { prepare, batch: batch as DatabaseAdapter["batch"], tables, reset };
}
