/**
 * ClickHouse adapter for @1moby/just-auth.
 *
 * Returns a `DatabaseAdapter` (drop-in for `createReactAuth({ database })`)
 * with three additional members:
 *  - `migrate()` — idempotent DDL setup
 *  - `rbac` — multi-org / department / supervisor permission graph
 *  - `approvals` — approval-flow state machine
 *
 * Trade-offs documented in README "ClickHouse adapter (experimental)" section.
 */
import type { DatabaseAdapter } from "../../types.ts";
import {
  type CHClient,
  type CHTableNames,
  type Logger,
  DEFAULT_TABLE_NAMES,
  NOOP_LOGGER,
} from "./types.ts";
import { createAdapterCore } from "./adapter-core.ts";
import { createRbacApi, type RbacApi } from "./rbac.ts";
import { createApprovalsApi, type ApprovalsApi } from "./approvals.ts";
import { migrate as runMigrate } from "./migrate.ts";

export interface ClickhouseAdapterOptions {
  client: CHClient;
  database?: string;
  cluster?: string;
  installation?: string;
  tableNames?: Partial<CHTableNames>;
  logger?: Logger;
  /** Enable the sessions_dict hot path (default: true). */
  useSessionDict?: boolean;
}

export interface ClickhouseAdapter extends DatabaseAdapter {
  rbac: RbacApi;
  approvals: ApprovalsApi;
  migrate(): Promise<void>;
}

export function createClickhouseAdapter(
  opts: ClickhouseAdapterOptions
): ClickhouseAdapter {
  const tableNames: CHTableNames = {
    ...DEFAULT_TABLE_NAMES,
    ...opts.tableNames,
  };
  const logger = opts.logger ?? NOOP_LOGGER;
  const useDict = opts.useSessionDict !== false;

  const sessionDictLookup = useDict
    ? async (tokenHash: string) => {
        try {
          const res = await opts.client.query({
            query: `SELECT dictGet('sessions_dict', 'user_id', tuple({tokenHash:String})) AS user_id`,
            query_params: { tokenHash },
            format: "JSONEachRow",
          });
          const rows = await res.json<{ user_id: string }>();
          if (!rows[0] || !rows[0].user_id) {
            logger.info("auth.ch.session.lookup_miss", { source: "dict" });
            return null;
          }
          // Dict gave us user_id; we still need expires_at.
          const exp = await opts.client.query({
            query: `SELECT dictGet('sessions_dict', 'expires_at', tuple({tokenHash:String})) AS expires_at`,
            query_params: { tokenHash },
            format: "JSONEachRow",
          });
          const expRows = await exp.json<{ expires_at: string }>();
          const expiresAt = expRows[0]?.expires_at ?? "";
          if (!expiresAt) {
            logger.info("auth.ch.session.lookup_miss", { source: "dict" });
            return null;
          }
          if (new Date(expiresAt) < new Date()) {
            logger.info("auth.ch.session.expired", { source: "dict" });
            return null;
          }
          logger.info("auth.ch.session.lookup_hit", { source: "dict" });
          return { user_id: rows[0].user_id, expires_at: expiresAt };
        } catch {
          logger.info("auth.ch.session.lookup_miss", { source: "dict_error" });
          return null;
        }
      }
    : undefined;

  const core = createAdapterCore({
    client: opts.client,
    tableNames,
    logger,
    sessionDictLookup,
  });
  const rbac = createRbacApi({ client: opts.client, tableNames, logger });
  const approvals = createApprovalsApi({
    client: opts.client,
    tableNames,
    logger,
    rbac,
  });

  return {
    ...core,
    rbac,
    approvals,
    async migrate() {
      await runMigrate({
        client: opts.client,
        database: opts.database,
        cluster: opts.cluster,
        installation: opts.installation,
        tableNames,
        logger,
      });
    },
  };
}

export type {
  CHClient,
  CHTableNames,
  Logger,
  Organization,
  Department,
  EffectiveRole,
  PermissionDecision,
  PermissionVia,
  RoleScope,
  RoleDefinition,
  RoleGrant,
  ApprovalRequest,
  ApprovalStatus,
  ApprovalDecision,
} from "./types.ts";
export type { RbacApi } from "./rbac.ts";
export type { ApprovalsApi } from "./approvals.ts";
