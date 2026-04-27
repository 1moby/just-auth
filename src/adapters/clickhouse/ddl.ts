import type { CHTableNames } from "./types.ts";

export interface DDLOptions {
  database?: string;
  cluster?: string;
  installation?: string; // CH macro name; defaults to literal {installation}
  tableNames: CHTableNames;
}

const IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function ident(name: string): string {
  if (!IDENT_RE.test(name)) {
    throw new Error(`[just-auth/ch] invalid identifier "${name}"`);
  }
  return name;
}

function clusterClause(cluster?: string): string {
  if (!cluster) return "";
  if (!IDENT_RE.test(cluster)) {
    throw new Error(`[just-auth/ch] invalid cluster name "${cluster}"`);
  }
  return ` ON CLUSTER '${cluster}'`;
}

/** Wrap an engine name in `Replicated*` and inject the keeper-path + replica args
 * when running on a cluster. The version-col / extra args follow. */
function replEngine(
  baseEngine: "ReplacingMergeTree" | "MergeTree",
  table: string,
  cluster: string | undefined,
  installation: string,
  versionCol?: string
): string {
  if (!cluster) {
    if (baseEngine === "ReplacingMergeTree" && versionCol) {
      return `ReplacingMergeTree(${ident(versionCol)})`;
    }
    return baseEngine;
  }
  // Replicated* needs keeper path + replica name. Macros stay as CH literals.
  const keeperPath = `'/clickhouse/tables/{${ident(installation)}}/{shard}/${ident(table)}'`;
  const replica = `'{replica}'`;
  if (baseEngine === "ReplacingMergeTree") {
    const v = versionCol ? `, ${ident(versionCol)}` : "";
    return `ReplicatedReplacingMergeTree(${keeperPath}, ${replica}${v})`;
  }
  return `ReplicatedMergeTree(${keeperPath}, ${replica})`;
}

/**
 * Returns the full DDL set: 9 CREATE TABLE + 1 CREATE DICTIONARY statements.
 * All statements use IF NOT EXISTS so re-running is a no-op.
 */
export function ddlStatements(opts: DDLOptions): string[] {
  const { cluster, installation = "installation", tableNames: t } = opts;
  const cc = clusterClause(cluster);

  const stmts: string[] = [];

  // Users
  stmts.push(
    `CREATE TABLE IF NOT EXISTS ${ident(t.users)}${cc} (
  id String,
  email String,
  email_normalized String,
  name Nullable(String),
  avatar_url Nullable(String),
  status LowCardinality(String) DEFAULT 'active',
  home_org_id Nullable(String),
  department_id Nullable(String),
  supervisor_user_id Nullable(String),
  password_hash Nullable(String),
  role Nullable(String),
  created_at DateTime64(3, 'UTC') DEFAULT now64(3),
  updated_at DateTime64(3, 'UTC') DEFAULT now64(3),
  _deleted UInt8 DEFAULT 0
) ENGINE = ${replEngine("ReplacingMergeTree", t.users, cluster, installation, "updated_at")}
ORDER BY (id)`
  );

  // Accounts
  stmts.push(
    `CREATE TABLE IF NOT EXISTS ${ident(t.accounts)}${cc} (
  id String,
  user_id String,
  provider String,
  provider_account_id String,
  access_token Nullable(String),
  refresh_token Nullable(String),
  expires_at Nullable(DateTime64(3, 'UTC')),
  created_at DateTime64(3, 'UTC') DEFAULT now64(3),
  updated_at DateTime64(3, 'UTC') DEFAULT now64(3),
  _deleted UInt8 DEFAULT 0
) ENGINE = ${replEngine("ReplacingMergeTree", t.accounts, cluster, installation, "updated_at")}
ORDER BY (provider, provider_account_id)`
  );

  // Sessions
  stmts.push(
    `CREATE TABLE IF NOT EXISTS ${ident(t.sessions)}${cc} (
  token_hash String,
  user_id String,
  expires_at DateTime64(3, 'UTC'),
  created_at DateTime64(3, 'UTC') DEFAULT now64(3),
  updated_at DateTime64(3, 'UTC') DEFAULT now64(3),
  _deleted UInt8 DEFAULT 0
) ENGINE = ${replEngine("ReplacingMergeTree", t.sessions, cluster, installation, "updated_at")}
ORDER BY (token_hash)`
  );

  // Verification tokens
  stmts.push(
    `CREATE TABLE IF NOT EXISTS ${ident(t.verificationTokens)}${cc} (
  identifier String,
  token_hash String,
  expires_at DateTime64(3, 'UTC'),
  used_at Nullable(DateTime64(3, 'UTC')),
  created_at DateTime64(3, 'UTC') DEFAULT now64(3),
  _deleted UInt8 DEFAULT 0
) ENGINE = ${replEngine("ReplacingMergeTree", t.verificationTokens, cluster, installation, "created_at")}
ORDER BY (identifier, token_hash)`
  );

  // Organizations
  stmts.push(
    `CREATE TABLE IF NOT EXISTS ${ident(t.organizations)}${cc} (
  id String,
  name String,
  parent_org_id Nullable(String),
  created_at DateTime64(3, 'UTC') DEFAULT now64(3),
  updated_at DateTime64(3, 'UTC') DEFAULT now64(3),
  _deleted UInt8 DEFAULT 0
) ENGINE = ${replEngine("ReplacingMergeTree", t.organizations, cluster, installation, "updated_at")}
ORDER BY (id)`
  );

  // Departments
  stmts.push(
    `CREATE TABLE IF NOT EXISTS ${ident(t.departments)}${cc} (
  id String,
  org_id String,
  parent_dept_id Nullable(String),
  name String,
  created_at DateTime64(3, 'UTC') DEFAULT now64(3),
  updated_at DateTime64(3, 'UTC') DEFAULT now64(3),
  _deleted UInt8 DEFAULT 0
) ENGINE = ${replEngine("ReplacingMergeTree", t.departments, cluster, installation, "updated_at")}
ORDER BY (org_id, id)`
  );

  // Roles
  stmts.push(
    `CREATE TABLE IF NOT EXISTS ${ident(t.roles)}${cc} (
  id String,
  scope LowCardinality(String),
  permissions String,
  created_at DateTime64(3, 'UTC') DEFAULT now64(3),
  updated_at DateTime64(3, 'UTC') DEFAULT now64(3),
  _deleted UInt8 DEFAULT 0
) ENGINE = ${replEngine("ReplacingMergeTree", t.roles, cluster, installation, "updated_at")}
ORDER BY (id)`
  );

  // User role grants — org_id and dept_id participate in ORDER BY, so they
  // must be non-nullable. We use empty-string sentinel '' for "no org / no
  // dept" rather than enabling allow_nullable_key (which would also affect
  // sparseness / merge cost).
  stmts.push(
    `CREATE TABLE IF NOT EXISTS ${ident(t.userRoleGrants)}${cc} (
  id String,
  user_id String,
  role_id String,
  org_id String DEFAULT '',
  dept_id String DEFAULT '',
  granted_by String,
  expires_at Nullable(DateTime64(3, 'UTC')),
  created_at DateTime64(3, 'UTC') DEFAULT now64(3),
  updated_at DateTime64(3, 'UTC') DEFAULT now64(3),
  _deleted UInt8 DEFAULT 0
) ENGINE = ${replEngine("ReplacingMergeTree", t.userRoleGrants, cluster, installation, "updated_at")}
ORDER BY (user_id, role_id, org_id, dept_id)`
  );

  // Approval requests
  stmts.push(
    `CREATE TABLE IF NOT EXISTS ${ident(t.approvalRequests)}${cc} (
  id String,
  requester_user_id String,
  action String,
  resource_type Nullable(String),
  resource_id Nullable(String),
  org_id String,
  dept_id Nullable(String),
  payload String,
  chain Array(String),
  current_step UInt32 DEFAULT 0,
  status LowCardinality(String) DEFAULT 'pending',
  expires_at Nullable(DateTime64(3, 'UTC')),
  created_at DateTime64(3, 'UTC') DEFAULT now64(3),
  updated_at DateTime64(3, 'UTC') DEFAULT now64(3),
  _deleted UInt8 DEFAULT 0
) ENGINE = ${replEngine("ReplacingMergeTree", t.approvalRequests, cluster, installation, "updated_at")}
PARTITION BY toYYYYMM(created_at)
ORDER BY (id)`
  );

  // Approval decisions (append-only audit)
  stmts.push(
    `CREATE TABLE IF NOT EXISTS ${ident(t.approvalDecisions)}${cc} (
  request_id String,
  step UInt32,
  approver_user_id String,
  decision LowCardinality(String),
  delegate_user_id Nullable(String),
  comment Nullable(String),
  decided_at DateTime64(3, 'UTC') DEFAULT now64(3)
) ENGINE = ${replEngine("MergeTree", t.approvalDecisions, cluster, installation)}
PARTITION BY toYYYYMM(decided_at)
ORDER BY (request_id, step, decided_at)`
  );

  // Sessions Dictionary — hot path for token lookup. CH dictionaries' SOURCE
  // QUERY is parsed without inheriting the caller's default database, so the
  // table reference inside the QUERY string itself must be fully qualified
  // when a database is in play. Tested across CH 24.8 / 25.3 / latest.
  const fromTable = opts.database
    ? `${ident(opts.database)}.${ident(t.sessions)}`
    : ident(t.sessions);
  const dbClause = opts.database ? `DB '${ident(opts.database)}' ` : "";
  stmts.push(
    `CREATE DICTIONARY IF NOT EXISTS sessions_dict${cc} (
  token_hash String,
  user_id String,
  expires_at DateTime64(3, 'UTC')
) PRIMARY KEY token_hash
SOURCE(CLICKHOUSE(${dbClause}QUERY 'SELECT token_hash, user_id, expires_at FROM ${fromTable} FINAL WHERE _deleted = 0'))
LIFETIME(MIN 5 MAX 15)
LAYOUT(HASHED())`
  );

  return stmts;
}
