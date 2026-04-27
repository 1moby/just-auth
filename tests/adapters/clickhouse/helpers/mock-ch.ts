/**
 * In-memory ClickHouse client stub. Implements just enough of the surface
 * the adapter uses to be a contract test: ReplacingMergeTree FINAL semantics,
 * named-param substitution, dictGet over a refreshable source query, and
 * append-only MergeTree behavior.
 *
 * This is NOT a ClickHouse simulator. It fails loudly on any SQL pattern it
 * doesn't recognize so the adapter can't silently get a wrong answer.
 */
import type { CHClient } from "../../../../src/adapters/clickhouse/types.ts";

interface TableMeta {
  engine: "ReplacingMergeTree" | "MergeTree" | "ReplicatedReplacingMergeTree" | "ReplicatedMergeTree";
  versionCol: string | null; // for ReplacingMergeTree
  orderBy: string[]; // primary key columns (used to dedup in FINAL)
}

interface DictMeta {
  primaryKey: string;
  source: string; // SELECT query
  cache: Map<string, Record<string, unknown>>; // primary-key value → row
  lastRefresh: number;
  lifetimeMs: number;
}

export interface MockCH extends CHClient {
  rows: Map<string, Record<string, unknown>[]>; // table → array of rows
  tables: Map<string, TableMeta>;
  dictionaries: Map<string, DictMeta>;
  ddl: string[]; // every command()ed query, for assertion
  inserts: { table: string; values: Record<string, unknown>[] }[];
  reset(): void;
  refreshDictionaries(): Promise<void>;
}

const NOW = () => Date.now();

export function createMockCH(): MockCH {
  const rows = new Map<string, Record<string, unknown>[]>();
  const tables = new Map<string, TableMeta>();
  const dictionaries = new Map<string, DictMeta>();
  const ddl: string[] = [];
  const inserts: { table: string; values: Record<string, unknown>[] }[] = [];

  function reset() {
    rows.clear();
    tables.clear();
    dictionaries.clear();
    ddl.length = 0;
    inserts.length = 0;
  }

  // ─── DDL parsing ─────────────────────────────────────────────────

  function parseCreateTable(sql: string): { name: string; meta: TableMeta } | null {
    const m = sql.match(
      /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:[a-zA-Z0-9_]+\.)?(`?)([a-zA-Z0-9_]+)\1(?:\s+ON\s+CLUSTER\s+'[^']+')?/i
    );
    if (!m) return null;
    const name = m[2]!;
    const engineM = sql.match(
      /ENGINE\s*=\s*((?:Replicated)?(?:Replacing)?MergeTree)\s*(?:\([^)]*\))?/i
    );
    if (!engineM) return null;
    const engine = engineM[1]! as TableMeta["engine"];
    let versionCol: string | null = null;
    if (engine === "ReplacingMergeTree" || engine === "ReplicatedReplacingMergeTree") {
      // version column is the LAST argument of the engine paren list
      const argsM = sql.match(/ENGINE\s*=\s*(?:Replicated)?ReplacingMergeTree\s*\(([^)]*)\)/i);
      if (argsM) {
        const args = argsM[1]!.split(",").map((s) => s.trim()).filter(Boolean);
        versionCol = args[args.length - 1] ?? null;
        // for Replicated, args[0..1] are the keeper path and replica name
        if (engine === "ReplicatedReplacingMergeTree" && args.length >= 3) {
          versionCol = args[args.length - 1] ?? null;
        }
      }
    }
    const orderByM = sql.match(/ORDER\s+BY\s+\(([^)]*)\)/i);
    let orderBy: string[] = [];
    if (orderByM) {
      orderBy = orderByM[1]!.split(",").map((s) => s.trim());
    } else {
      const obSingle = sql.match(/ORDER\s+BY\s+([a-zA-Z0-9_]+)/i);
      if (obSingle) orderBy = [obSingle[1]!];
    }
    return { name, meta: { engine, versionCol, orderBy } };
  }

  function parseCreateDictionary(sql: string): { name: string; meta: DictMeta } | null {
    const m = sql.match(
      /CREATE\s+DICTIONARY\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:[a-zA-Z0-9_]+\.)?(`?)([a-zA-Z0-9_]+)\1/i
    );
    if (!m) return null;
    const name = m[2]!;
    const pkM = sql.match(/PRIMARY\s+KEY\s+([a-zA-Z0-9_]+)/i);
    const sourceM = sql.match(/SOURCE\(\s*CLICKHOUSE\(\s*QUERY\s+'([^']+)'\s*\)\s*\)/i);
    const lifetimeM = sql.match(/LIFETIME\(\s*MIN\s+(\d+)\s+MAX\s+(\d+)\s*\)/i);
    if (!pkM || !sourceM) return null;
    const lifetimeSec = lifetimeM ? Number(lifetimeM[2]) : 15;
    return {
      name,
      meta: {
        primaryKey: pkM[1]!,
        source: sourceM[1]!,
        cache: new Map(),
        lastRefresh: 0,
        lifetimeMs: lifetimeSec * 1000,
      },
    };
  }

  // ─── Param substitution ──────────────────────────────────────────

  function substituteParams(query: string, params?: Record<string, unknown>): string {
    if (!params) return query;
    // {name:Type} → JS literal of params[name]. We only substitute for the parser's sake.
    return query.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*):[^}]+\}/g, (_m, name) => {
      if (!(name in params)) {
        throw new Error(`mock-ch: missing query_param "${name}" for query: ${query}`);
      }
      return JSON.stringify(params[name]);
    });
  }

  // ─── FINAL semantics ─────────────────────────────────────────────

  function applyFinal(table: string): Record<string, unknown>[] {
    const all = rows.get(table) ?? [];
    const meta = tables.get(table);
    if (!meta) return all;
    if (meta.engine === "MergeTree" || meta.engine === "ReplicatedMergeTree") {
      // append-only: no dedup
      return all;
    }
    // ReplacingMergeTree[*]: keep latest by versionCol per orderBy key.
    // Iterate in INSERT order; tie-break on equal versions by keeping the later write.
    const byKey = new Map<string, Record<string, unknown>>();
    for (const row of all) {
      const key = meta.orderBy.map((c) => JSON.stringify(row[c])).join("|");
      const cur = byKey.get(key);
      if (!cur) {
        byKey.set(key, row);
        continue;
      }
      const vc = meta.versionCol;
      if (!vc) {
        byKey.set(key, row); // last write wins
      } else {
        if (compareVersions(row[vc], cur[vc]) >= 0) {
          byKey.set(key, row);
        }
      }
    }
    return [...byKey.values()];
  }

  /** Compare two version-column values. Supports numbers and ISO date strings.
   *  Returns 1 if a > b, -1 if a < b, 0 if equal. */
  function compareVersions(a: unknown, b: unknown): number {
    if (a === b) return 0;
    if (a == null) return -1;
    if (b == null) return 1;
    // numbers
    const an = Number(a);
    const bn = Number(b);
    if (!Number.isNaN(an) && !Number.isNaN(bn)) {
      return an < bn ? -1 : an > bn ? 1 : 0;
    }
    // strings (ISO timestamps sort lexically)
    const as = String(a);
    const bs = String(b);
    return as < bs ? -1 : as > bs ? 1 : 0;
  }

  // ─── SELECT execution ────────────────────────────────────────────

  function executeSelect(rawSql: string, params?: Record<string, unknown>): Record<string, unknown>[] {
    // Handle dictGet expressions specifically (used only as full-statement: SELECT dictGet(...))
    const dictGetM = rawSql.match(
      /SELECT\s+dictGet\(\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*tuple\(\s*\{([a-zA-Z_][a-zA-Z0-9_]*):[^}]+\}\s*\)\s*\)\s*AS\s+([a-zA-Z0-9_]+)/i
    );
    if (dictGetM) {
      const [_, dictName, attr, paramName, alias] = dictGetM as unknown as string[];
      const dict = dictionaries.get(dictName!);
      if (!dict) throw new Error(`mock-ch: dictGet on unknown dictionary ${dictName}`);
      maybeRefreshDict(dict);
      const key = String(params?.[paramName!]);
      const row = dict.cache.get(key);
      const value = row ? row[attr!] : "";
      return [{ [alias!]: value ?? "" }];
    }

    const tableM = rawSql.match(
      /FROM\s+(?:[a-zA-Z0-9_]+\.)?(`?)([a-zA-Z0-9_]+)\1(\s+FINAL)?/i
    );
    if (!tableM) throw new Error(`mock-ch: cannot parse FROM in: ${rawSql}`);
    const table = tableM[2]!;
    const isFinal = !!tableM[3];

    let working = isFinal ? applyFinal(table) : (rows.get(table) ?? []).slice();

    // WHERE — handles AND'd predicates of the form "col OP literalOrParam"
    const whereM = rawSql.match(
      /WHERE\s+(.+?)(?=\s+ORDER\s+BY|\s+LIMIT|\s+GROUP\s+BY|\s+HAVING|\s*$)/is
    );
    if (whereM) {
      working = working.filter((row) => evalPredicate(whereM[1]!, row, params));
    }

    // ORDER BY
    const orderM = rawSql.match(/ORDER\s+BY\s+([a-zA-Z0-9_]+)(\s+(ASC|DESC))?/i);
    if (orderM) {
      const col = orderM[1]!;
      const dir = (orderM[3] ?? "ASC").toUpperCase();
      working.sort((a, b) => {
        const av = a[col],
          bv = b[col];
        if (av === bv) return 0;
        // @ts-expect-error coerce
        return ((av < bv ? -1 : 1) as number) * (dir === "DESC" ? -1 : 1);
      });
    }

    // LIMIT
    const limitM = rawSql.match(/LIMIT\s+(\d+)/i);
    if (limitM) working = working.slice(0, Number(limitM[1]!));

    // SELECT cols projection
    const selM = rawSql.match(/SELECT\s+(.+?)\s+FROM\s/is);
    if (!selM) return working;
    const colsRaw = selM[1]!.trim();
    if (colsRaw === "*" || colsRaw === "count()") {
      if (colsRaw === "count()") return [{ "count()": working.length }];
      return working;
    }
    const cols = colsRaw.split(",").map((c) => {
      const asM = c.trim().match(/^([a-zA-Z0-9_]+)(\s+AS\s+([a-zA-Z0-9_]+))?$/i);
      return asM ? { src: asM[1]!, alias: asM[3] ?? asM[1]! } : null;
    });
    return working.map((r) => {
      const out: Record<string, unknown> = {};
      for (const c of cols) {
        if (!c) continue;
        out[c.alias] = r[c.src];
      }
      return out;
    });
  }

  function evalPredicate(
    pred: string,
    row: Record<string, unknown>,
    params?: Record<string, unknown>
  ): boolean {
    // Split by " AND " (case-insensitive). We don't support OR/parens.
    const parts = pred.split(/\s+AND\s+/i);
    for (const part of parts) {
      // patterns: col = {p:T}, col = 'literal', col = N, col != ..., col IS NULL, col IN (...)
      let m: RegExpMatchArray | null;
      // IS NULL / IS NOT NULL
      if ((m = part.match(/^\s*([a-zA-Z0-9_]+)\s+IS\s+NULL\s*$/i))) {
        if (row[m[1]!] != null) return false;
        continue;
      }
      if ((m = part.match(/^\s*([a-zA-Z0-9_]+)\s+IS\s+NOT\s+NULL\s*$/i))) {
        if (row[m[1]!] == null) return false;
        continue;
      }
      // Comparison
      const cmpM = part.match(
        /^\s*([a-zA-Z0-9_]+)\s*(=|!=|<>|<=|>=|<|>)\s*(.+?)\s*$/
      );
      if (cmpM) {
        const [, col, op, rhsRaw] = cmpM;
        const lhs = row[col!];
        let rhs: unknown;
        const paramM = rhsRaw!.match(/^\{([a-zA-Z_][a-zA-Z0-9_]*):[^}]+\}$/);
        if (paramM) {
          rhs = params?.[paramM[1]!];
        } else if (rhsRaw!.startsWith("'") && rhsRaw!.endsWith("'")) {
          rhs = rhsRaw!.slice(1, -1);
        } else if (!isNaN(Number(rhsRaw))) {
          rhs = Number(rhsRaw);
        } else if (rhsRaw === "NULL") {
          rhs = null;
        } else {
          throw new Error(`mock-ch: unsupported RHS in predicate: ${part}`);
        }
        if (!cmpEval(lhs, op!, rhs)) return false;
        continue;
      }
      throw new Error(`mock-ch: unsupported predicate fragment: ${part}`);
    }
    return true;
  }

  function cmpEval(lhs: unknown, op: string, rhs: unknown): boolean {
    // Treat Date and ISO string equivalently
    const norm = (v: unknown): unknown =>
      v instanceof Date ? v.toISOString() : v;
    const a = norm(lhs);
    const b = norm(rhs);
    switch (op) {
      case "=":
        return a === b;
      case "!=":
      case "<>":
        return a !== b;
      case "<":
        // @ts-expect-error coerce
        return a < b;
      case ">":
        // @ts-expect-error coerce
        return a > b;
      case "<=":
        // @ts-expect-error coerce
        return a <= b;
      case ">=":
        // @ts-expect-error coerce
        return a >= b;
    }
    return false;
  }

  // ─── Dictionary refresh ──────────────────────────────────────────

  function maybeRefreshDict(dict: DictMeta) {
    if (NOW() - dict.lastRefresh < dict.lifetimeMs) return;
    refreshDict(dict);
  }
  function refreshDict(dict: DictMeta) {
    const result = executeSelect(dict.source);
    dict.cache.clear();
    for (const r of result) {
      dict.cache.set(String(r[dict.primaryKey]), r);
    }
    dict.lastRefresh = NOW();
  }
  async function refreshDictionaries() {
    for (const dict of dictionaries.values()) refreshDict(dict);
  }

  // ─── Public surface ──────────────────────────────────────────────

  async function command(args: { query: string; query_params?: Record<string, unknown> }) {
    const q = args.query;
    ddl.push(q);
    const ct = parseCreateTable(q);
    if (ct) {
      if (!tables.has(ct.name)) {
        tables.set(ct.name, ct.meta);
        rows.set(ct.name, []);
      }
      return;
    }
    const cd = parseCreateDictionary(q);
    if (cd) {
      if (!dictionaries.has(cd.name)) dictionaries.set(cd.name, cd.meta);
      return;
    }
    // ALTER, OPTIMIZE etc — accepted, no-op
  }

  async function insert(args: { table: string; values: Record<string, unknown>[] }) {
    inserts.push({ table: args.table, values: args.values });
    const list = rows.get(args.table) ?? [];
    list.push(...args.values);
    rows.set(args.table, list);
  }

  async function query(args: {
    query: string;
    query_params?: Record<string, unknown>;
  }) {
    const sub = substituteParams(args.query, args.query_params);
    const result = executeSelect(args.query, args.query_params);
    void sub;
    return {
      async json<T = Record<string, unknown>>(): Promise<T[]> {
        return result as T[];
      },
    };
  }

  return {
    rows,
    tables,
    dictionaries,
    ddl,
    inserts,
    reset,
    refreshDictionaries,
    command,
    insert,
    query,
  };
}
