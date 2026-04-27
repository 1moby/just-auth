/**
 * Minimal ClickHouse client surface the adapter needs. Matches the shape of
 * `@clickhouse/client` so consumers can pass either the real client or a mock.
 */
export interface CHClient {
  query(args: {
    query: string;
    query_params?: Record<string, unknown>;
    format?: "JSONEachRow" | "JSON";
  }): Promise<{ json<T = Record<string, unknown>>(): Promise<T[]> }>;
  command(args: {
    query: string;
    query_params?: Record<string, unknown>;
  }): Promise<void>;
  insert(args: {
    table: string;
    values: Record<string, unknown>[];
    format?: "JSONEachRow";
  }): Promise<void>;
}

export interface CHTableNames {
  users: string;
  accounts: string;
  sessions: string;
  verificationTokens: string;
  organizations: string;
  departments: string;
  roles: string;
  userRoleGrants: string;
  approvalRequests: string;
  approvalDecisions: string;
}

export const DEFAULT_TABLE_NAMES: CHTableNames = {
  users: "users",
  accounts: "accounts",
  sessions: "sessions",
  verificationTokens: "verification_tokens",
  organizations: "organizations",
  departments: "departments",
  roles: "roles",
  userRoleGrants: "user_role_grants",
  approvalRequests: "approval_requests",
  approvalDecisions: "approval_decisions",
};

export interface Logger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

export const NOOP_LOGGER: Logger = {
  info() {},
  warn() {},
  error() {},
};

// ─── RBAC types ────────────────────────────────────────────────────

export interface Organization {
  id: string;
  name: string;
  parentOrgId: string | null;
}

export interface Department {
  id: string;
  orgId: string;
  parentDeptId: string | null;
  name: string;
}

export type RoleScope = "system" | "org" | "department";

export interface RoleDefinition {
  id: string;
  scope: RoleScope;
  permissions: string[]; // may include "*" for superadmin or "deny:<perm>" for explicit deny
}

export interface RoleGrant {
  id: string;
  userId: string;
  roleId: string;
  orgId: string | null;
  deptId: string | null;
  grantedBy: string;
  expiresAt: Date | null;
}

export interface EffectiveRole {
  roleId: string;
  scope: RoleScope;
  orgId: string | null;
  deptId: string | null;
  via: "direct" | "inherited" | "home_org";
}

export type PermissionVia =
  | "role"
  | "inherited"
  | "supervisor"
  | "home_org"
  | "superadmin";

export type PermissionDecision =
  | { allowed: true; via: PermissionVia; rolesUsed: string[] }
  | { allowed: false; reason: string };

// ─── Approval types ────────────────────────────────────────────────

export type ApprovalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "expired"
  | "delegated";

export interface ApprovalRequest {
  id: string;
  requesterUserId: string;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  orgId: string;
  deptId: string | null;
  payload: unknown;
  chain: string[];
  currentStep: number;
  status: ApprovalStatus;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ApprovalDecision {
  requestId: string;
  step: number;
  approverUserId: string;
  decision: "approved" | "rejected" | "delegated";
  delegateUserId: string | null;
  comment: string | null;
  decidedAt: Date;
}
