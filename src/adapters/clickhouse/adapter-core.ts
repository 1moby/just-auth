/**
 * Translates the framework's `DatabaseAdapter` (prepare/bind/run/first/all)
 * to ClickHouse via the simplified statement parser.
 *
 * Tombstone semantics: DELETE writes a row with `_deleted=1` and bumped
 * `updated_at`. UPDATE writes a fresh row with the new column values and
 * bumped `updated_at`. ReplacingMergeTree FINAL collapses to the latest
 * version per primary key.
 */
import type {
  DatabaseAdapter,
  PreparedStatement,
  BoundStatement,
} from "../../types.ts";
import type { CHClient, CHTableNames, Logger } from "./types.ts";
import { parseSql, injectFinal, gateDeleted } from "./sql-translator.ts";
import { chDate, chDateNow } from "./util.ts";

export interface AdapterCoreOptions {
  client: CHClient;
  tableNames: CHTableNames;
  logger?: Logger;
  /** Optional hook: called for each session token-hash lookup so the consumer
   * can route through `sessions_dict` first. */
  sessionDictLookup?: (
    tokenHash: string
  ) => Promise<{ user_id: string; expires_at: string } | null>;
}

const FRAMEWORK_TABLE_KEYS: (keyof CHTableNames)[] = [
  "users",
  "accounts",
  "sessions",
  "verificationTokens",
];

/** Map JS values to ClickHouse-friendly representations.
 *  - Date → canonical CH DateTime64 string (matches DateTime64(3,'UTC'))
 *  - undefined → null */
function chValue(v: unknown): unknown {
  if (v === undefined) return null;
  if (v instanceof Date) return chDate(v);
  return v;
}

export function createAdapterCore(opts: AdapterCoreOptions): DatabaseAdapter {
  const { client, tableNames, logger, sessionDictLookup } = opts;
  const finalTables = new Set<string>(
    FRAMEWORK_TABLE_KEYS.map((k) => tableNames[k])
  );

  function bind(sql: string, params: unknown[]): BoundStatement {
    const parsed = parseSql(sql);

    return {
      async run(): Promise<{ success: boolean }> {
        const t0 = Date.now();
        if (parsed.kind === "insert") {
          const row: Record<string, unknown> = {};
          for (let i = 0; i < parsed.columns.length; i++) {
            row[parsed.columns[i]!] = chValue(params[i]);
          }
          // framework-managed audit cols
          if (!("created_at" in row)) row.created_at = chDateNow();
          if (!("updated_at" in row)) row.updated_at = chDateNow();
          if (!("_deleted" in row)) row._deleted = 0;
          await client.insert({
            table: parsed.table,
            values: [row],
            format: "JSONEachRow",
          });
          logger?.info("auth.ch.insert", {
            table: parsed.table,
            elapsedMs: Date.now() - t0,
          });
          return { success: true };
        }
        if (parsed.kind === "command" && parsed.source === "delete") {
          // tombstone insert: copy WHERE col→value, set _deleted=1
          const row: Record<string, unknown> = { _deleted: 1, updated_at: chDateNow() };
          for (const w of parsed.whereCols) {
            row[w.col] = chValue(params[w.paramIdx]);
          }
          await client.insert({
            table: parsed.table,
            values: [row],
            format: "JSONEachRow",
          });
          logger?.info("auth.ch.delete", {
            table: parsed.table,
            elapsedMs: Date.now() - t0,
          });
          return { success: true };
        }
        if (parsed.kind === "command" && parsed.source === "update") {
          // We can't construct a full new row from just WHERE id=? + SET col=?:
          // the rest of the row is unknown. We must read the latest row first,
          // merge SETs, and re-insert.
          // Build SELECT * FROM <t> FINAL WHERE <whereCols> AND _deleted=0 LIMIT 1.
          const whereSql = parsed.whereCols
            .map((w, i) => `${w.col} = {p${i}:String}`)
            .join(" AND ");
          const queryParams: Record<string, unknown> = {};
          parsed.whereCols.forEach((w, i) => {
            queryParams[`p${i}`] = String(chValue(params[w.paramIdx]) ?? "");
          });
          const sel = `SELECT * FROM ${parsed.table} FINAL WHERE ${whereSql} AND _deleted = 0 LIMIT 1`;
          const res = await client.query({
            query: sel,
            query_params: queryParams,
            format: "JSONEachRow",
          });
          const rows = await res.json<Record<string, unknown>>();
          if (rows.length === 0) {
            // nothing to update — no-op
            return { success: true };
          }
          const merged: Record<string, unknown> = { ...rows[0]! };
          for (const s of parsed.setCols) {
            merged[s.col] = chValue(params[s.paramIdx]);
          }
          merged.updated_at = chDateNow();
          merged._deleted = 0;
          await client.insert({
            table: parsed.table,
            values: [merged],
            format: "JSONEachRow",
          });
          logger?.info("auth.ch.update", {
            table: parsed.table,
            elapsedMs: Date.now() - t0,
          });
          return { success: true };
        }
        // SELECT.run() is a no-op (no caller uses it that way today)
        return { success: true };
      },

      async first<T = Record<string, unknown>>(): Promise<T | null> {
        if (parsed.kind !== "select") return null;
        const t0 = Date.now();
        // sessions_dict hot path: SELECT … FROM sessions WHERE token_hash = ?
        if (
          sessionDictLookup &&
          /\bFROM\s+sessions\b/i.test(parsed.query) &&
          /\btoken_hash\s*=\s*\{p0:String\}/i.test(parsed.query)
        ) {
          // Try the dictionary first
          const tokenHash = String(params[0]);
          const dictHit = await sessionDictLookup(tokenHash);
          if (dictHit) {
            return dictHit as T;
          }
        }
        const finalQuery = gateDeleted(injectFinal(parsed.query, finalTables));
        const queryParams: Record<string, unknown> = {};
        for (let i = 0; i < parsed.paramCount; i++) {
          queryParams[`p${i}`] = String(chValue(params[i]) ?? "");
        }
        const res = await client.query({
          query: finalQuery,
          query_params: queryParams,
          format: "JSONEachRow",
        });
        const rows = await res.json<T>();
        logger?.info("auth.ch.select.first", {
          rows: rows.length,
          elapsedMs: Date.now() - t0,
        });
        return rows[0] ?? null;
      },

      async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
        if (parsed.kind !== "select") return { results: [] };
        const t0 = Date.now();
        const finalQuery = gateDeleted(injectFinal(parsed.query, finalTables));
        const queryParams: Record<string, unknown> = {};
        for (let i = 0; i < parsed.paramCount; i++) {
          queryParams[`p${i}`] = String(chValue(params[i]) ?? "");
        }
        const res = await client.query({
          query: finalQuery,
          query_params: queryParams,
          format: "JSONEachRow",
        });
        const rows = await res.json<T>();
        logger?.info("auth.ch.select.all", {
          rows: rows.length,
          elapsedMs: Date.now() - t0,
        });
        return { results: rows };
      },
    };
  }

  return {
    prepare(sql: string): PreparedStatement {
      return {
        bind(...params: unknown[]): BoundStatement {
          return bind(sql, params);
        },
      };
    },
    async batch<T>(stmts: BoundStatement[]): Promise<T[]> {
      const out: T[] = [];
      for (const s of stmts) {
        await s.run();
      }
      return out;
    },
  };
}
