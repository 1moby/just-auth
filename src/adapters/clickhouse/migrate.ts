import type { CHClient, Logger } from "./types.ts";
import { ddlStatements, type DDLOptions } from "./ddl.ts";

export interface MigrateOptions extends DDLOptions {
  client: CHClient;
  logger?: Logger;
}

/** Run DDL idempotently against ClickHouse. Safe to re-run. */
export async function migrate(opts: MigrateOptions): Promise<void> {
  const { client, logger } = opts;
  let database = opts.database;
  if (!database) {
    // Autodetect — dictionaries can't inherit the session's default database
    // for SOURCE queries, so we need an explicit DB clause.
    try {
      const res = await client.query({
        query: "SELECT currentDatabase() AS db",
        format: "JSONEachRow",
      });
      const rows = await res.json<{ db: string }>();
      database = rows[0]?.db;
    } catch {
      // fall back to bare source — works on simple deployments
    }
  }
  const stmts = ddlStatements({ ...opts, database });
  const t0 = Date.now();
  for (const stmt of stmts) {
    const stmtStart = Date.now();
    await client.command({ query: stmt });
    logger?.info("auth.ch.migrate.run", {
      elapsedMs: Date.now() - stmtStart,
      statement: stmt.split("\n")[0]!.slice(0, 80),
    });
  }
  logger?.info("auth.ch.migrate.done", {
    elapsedMs: Date.now() - t0,
    count: stmts.length,
  });
}
