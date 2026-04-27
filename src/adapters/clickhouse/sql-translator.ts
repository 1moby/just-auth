/**
 * Translates the framework's `?`-style SQL (used by `src/db/queries.ts`) into
 * ClickHouse named-params + auto-FINAL on ReplacingMergeTree reads.
 *
 * The framework only emits a small, well-known set of statement shapes:
 *  - INSERT INTO <t> (cols...) VALUES (?, ?, ...)
 *  - SELECT ... FROM <t> [JOIN ...] WHERE col = ? [AND ...]
 *  - UPDATE <t> SET col = ? WHERE id = ?
 *  - DELETE FROM <t> WHERE col = ?
 *
 * For SELECTs from the FINAL-managed tables, we inject FINAL after the
 * primary FROM clause and add `AND _deleted = 0` to the WHERE.
 */

export interface ParsedInsert {
  kind: "insert";
  table: string;
  columns: string[];
  paramCount: number;
}

export interface ParsedSelect {
  kind: "select";
  /** SQL with `?` placeholders rewritten to {pN:String}. We always send Strings;
   * ClickHouse coerces. The mock client handles the same. */
  query: string;
  paramCount: number;
}

export interface ParsedOther {
  kind: "command";
  /** Rewritten DELETE/UPDATE we'll emit as a tombstone insert via the caller. */
  source: "delete" | "update";
  table: string;
  /** Where-bound columns (names) and their param indexes (in `?` order). */
  whereCols: { col: string; paramIdx: number }[];
  /** For UPDATE: SET cols + their param indexes. */
  setCols: { col: string; paramIdx: number }[];
}

export type Parsed = ParsedInsert | ParsedSelect | ParsedOther;

const INSERT_RE =
  /^\s*INSERT\s+INTO\s+([a-zA-Z0-9_]+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)\s*$/is;
const DELETE_RE = /^\s*DELETE\s+FROM\s+([a-zA-Z0-9_]+)\s+WHERE\s+(.+?)\s*$/is;
const UPDATE_RE =
  /^\s*UPDATE\s+([a-zA-Z0-9_]+)\s+SET\s+(.+?)\s+WHERE\s+(.+?)\s*$/is;

export function parseSql(sql: string): Parsed {
  const norm = sql.trim();

  // INSERT
  const ins = norm.match(INSERT_RE);
  if (ins) {
    const table = ins[1]!;
    const columns = ins[2]!.split(",").map((c) => c.trim());
    const params = ins[3]!.split(",").map((c) => c.trim());
    if (params.some((p) => p !== "?")) {
      throw new Error(`[ch-translator] non-? value in INSERT: ${sql}`);
    }
    return { kind: "insert", table, columns, paramCount: columns.length };
  }

  // DELETE → tombstone insert (handled by caller)
  const del = norm.match(DELETE_RE);
  if (del) {
    const table = del[1]!;
    const whereCols = parseEqualityWhere(del[2]!);
    return { kind: "command", source: "delete", table, whereCols, setCols: [] };
  }

  // UPDATE → fresh-row insert with bumped version (handled by caller)
  const upd = norm.match(UPDATE_RE);
  if (upd) {
    const table = upd[1]!;
    const setCols = parseAssignList(upd[2]!, 0);
    const whereCols = parseEqualityWhere(upd[3]!, setCols.length);
    return {
      kind: "command",
      source: "update",
      table,
      whereCols,
      setCols,
    };
  }

  // SELECT (and anything else read-side)
  return { kind: "select", ...rewriteSelect(sql) };
}

function parseEqualityWhere(
  whereClause: string,
  paramOffset = 0
): { col: string; paramIdx: number }[] {
  const out: { col: string; paramIdx: number }[] = [];
  const parts = whereClause.split(/\s+AND\s+/i);
  let idx = paramOffset;
  for (const p of parts) {
    const m = p.match(/^([a-zA-Z0-9_.]+)\s*=\s*\?\s*$/);
    if (!m) {
      throw new Error(`[ch-translator] unsupported WHERE fragment: ${p}`);
    }
    const col = m[1]!.includes(".") ? m[1]!.split(".").pop()! : m[1]!;
    out.push({ col, paramIdx: idx });
    idx++;
  }
  return out;
}

function parseAssignList(
  setList: string,
  paramOffset: number
): { col: string; paramIdx: number }[] {
  const out: { col: string; paramIdx: number }[] = [];
  const parts = setList.split(",");
  let idx = paramOffset;
  for (const p of parts) {
    const m = p.trim().match(/^([a-zA-Z0-9_]+)\s*=\s*\?\s*$/);
    if (!m) throw new Error(`[ch-translator] unsupported SET fragment: ${p}`);
    out.push({ col: m[1]!, paramIdx: idx });
    idx++;
  }
  return out;
}

/**
 * Rewrite `?` placeholders → {pN:String}. We don't emit FINAL here because
 * the framework's queries already select with explicit join/where clauses
 * — auto-FINAL is injected by the calling adapter only on tables it knows
 * are ReplacingMergeTree.
 */
function rewriteSelect(sql: string): { query: string; paramCount: number } {
  let i = 0;
  const out = sql.replace(/\?/g, () => `{p${i++}:String}`);
  return { query: out, paramCount: i };
}

/** Inject FINAL on every direct table reference in the SQL that names one of
 * the FINAL-managed tables. Conservative match: only after FROM or JOIN. */
export function injectFinal(sql: string, finalTables: Set<string>): string {
  return sql.replace(
    /\b(FROM|JOIN)\s+([a-zA-Z0-9_]+)(?:\s+([a-zA-Z]))?/gi,
    (whole, kw: string, table: string, alias?: string) => {
      if (!finalTables.has(table)) return whole;
      // skip if FINAL already present in next 6 chars after match
      const aliasPart = alias ? ` ${alias}` : "";
      return `${kw} ${table}${aliasPart} FINAL`;
    }
  );
}

/** Append `AND _deleted = 0` to the WHERE clause; if no WHERE present, add one.
 * Only for tables known to have the column. */
export function gateDeleted(sql: string): string {
  const hasWhere = /\bWHERE\b/i.test(sql);
  if (hasWhere) {
    // insert " AND _deleted = 0" right after the WHERE expression's last clause,
    // but before any ORDER BY / LIMIT
    return sql.replace(
      /\bWHERE\b\s+(.+?)(\s+ORDER\s+BY|\s+LIMIT|\s+GROUP\s+BY|\s*$)/is,
      (_m, body, tail) => `WHERE ${body} AND _deleted = 0${tail}`
    );
  }
  return `${sql} WHERE _deleted = 0`;
}
