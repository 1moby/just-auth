import type {
  CHClient,
  CHTableNames,
  Logger,
  Organization,
  Department,
  EffectiveRole,
  PermissionDecision,
  RoleDefinition,
  RoleScope,
} from "./types.ts";
import { traverseChain, collectDescendants } from "./cycle-detect.ts";
import { chDate, chDateNow, uuid } from "./util.ts";

export interface RbacApi {
  createOrganization(args: { id?: string; name: string; parentOrgId?: string | null }): Promise<{ id: string }>;
  getOrganization(id: string): Promise<Organization | null>;
  listChildOrganizations(parentId: string): Promise<Organization[]>;
  listDescendantOrganizations(parentId: string): Promise<Organization[]>;
  createDepartment(args: { id?: string; orgId: string; name: string; parentDeptId?: string | null }): Promise<{ id: string }>;
  listDepartments(orgId: string): Promise<Department[]>;
  setUserHomeOrg(userId: string, orgId: string): Promise<void>;
  setUserDepartment(userId: string, deptId: string | null): Promise<void>;
  setUserSupervisor(userId: string, supervisorUserId: string | null): Promise<void>;
  getSupervisorChain(userId: string, opts?: { maxDepth?: number }): Promise<string[]>;
  defineRole(args: { id: string; scope: RoleScope; permissions: string[] }): Promise<void>;
  grantUserRole(args: {
    userId: string;
    roleId: string;
    orgId?: string;
    deptId?: string;
    grantedBy: string;
    expiresAt?: Date | null;
  }): Promise<{ id: string }>;
  revokeUserRole(args: {
    userId: string;
    roleId: string;
    orgId?: string;
    deptId?: string;
    revokedBy: string;
  }): Promise<void>;
  listEffectiveRoles(
    userId: string,
    opts?: { orgId?: string; deptId?: string; includeInherited?: boolean }
  ): Promise<EffectiveRole[]>;
  resolvePermission(args: {
    userId: string;
    permission: string;
    resource?: { orgId?: string; deptId?: string; ownerUserId?: string };
  }): Promise<PermissionDecision>;
}

interface RbacOptions {
  client: CHClient;
  tableNames: CHTableNames;
  logger?: Logger;
}

export function createRbacApi(opts: RbacOptions): RbacApi {
  const { client, tableNames: t, logger } = opts;

  async function rowsFromQuery(query: string, params: Record<string, unknown>) {
    const res = await client.query({
      query,
      query_params: params,
      format: "JSONEachRow",
    });
    return res.json<Record<string, unknown>>();
  }

  async function getRoleDef(roleId: string): Promise<RoleDefinition | null> {
    const rows = await rowsFromQuery(
      `SELECT id, scope, permissions FROM ${t.roles} FINAL WHERE id = {id:String} AND _deleted = 0 LIMIT 1`,
      { id: roleId }
    );
    if (rows.length === 0) return null;
    const r = rows[0]!;
    let perms: string[] = [];
    try {
      perms = JSON.parse(String(r.permissions ?? "[]"));
    } catch {
      perms = [];
    }
    return { id: String(r.id), scope: r.scope as RoleScope, permissions: perms };
  }

  async function listGrantsForUser(userId: string): Promise<{
    roleId: string;
    orgId: string | null;
    deptId: string | null;
  }[]> {
    const rows = await rowsFromQuery(
      `SELECT role_id, org_id, dept_id, expires_at FROM ${t.userRoleGrants} FINAL
       WHERE user_id = {uid:String} AND _deleted = 0`,
      { uid: userId }
    );
    const now = chDateNow();
    return rows
      .filter((r) => !r.expires_at || String(r.expires_at) > now)
      .map((r) => ({
        roleId: String(r.role_id),
        orgId: r.org_id ? String(r.org_id) : null,
        deptId: r.dept_id ? String(r.dept_id) : null,
      }));
  }

  async function getUserHome(userId: string): Promise<{
    homeOrgId: string | null;
    departmentId: string | null;
    supervisorUserId: string | null;
  } | null> {
    const rows = await rowsFromQuery(
      `SELECT home_org_id, department_id, supervisor_user_id FROM ${t.users} FINAL
       WHERE id = {uid:String} AND _deleted = 0 LIMIT 1`,
      { uid: userId }
    );
    if (rows.length === 0) return null;
    const r = rows[0]!;
    return {
      homeOrgId: r.home_org_id ? String(r.home_org_id) : null,
      departmentId: r.department_id ? String(r.department_id) : null,
      supervisorUserId: r.supervisor_user_id ? String(r.supervisor_user_id) : null,
    };
  }

  /** Read-then-merge upsert against the users table. Either updates an existing
   * row preserving all other columns, or creates a stub row if the user doesn't
   * exist yet (e.g. a placeholder for an external user-id under management). */
  async function mutateUser(
    userId: string,
    patch: Record<string, unknown>
  ): Promise<void> {
    const existing = await rowsFromQuery(
      `SELECT * FROM ${t.users} FINAL WHERE id = {uid:String} AND _deleted = 0 LIMIT 1`,
      { uid: userId }
    );
    const base: Record<string, unknown> =
      existing.length > 0
        ? { ...existing[0]! }
        : {
            id: userId,
            email: "",
            email_normalized: "",
            name: null,
            avatar_url: null,
            status: "active",
            home_org_id: null,
            department_id: null,
            supervisor_user_id: null,
            password_hash: null,
            role: null,
            created_at: chDateNow(),
          };
    Object.assign(base, patch);
    base.updated_at = chDateNow();
    base._deleted = 0;
    await client.insert({
      table: t.users,
      values: [base],
      format: "JSONEachRow",
    });
  }

  async function fetchOrgParent(orgId: string): Promise<string | null> {
    const rows = await rowsFromQuery(
      `SELECT parent_org_id FROM ${t.organizations} FINAL WHERE id = {id:String} AND _deleted = 0 LIMIT 1`,
      { id: orgId }
    );
    if (rows.length === 0) return null;
    const p = rows[0]!.parent_org_id;
    return p ? String(p) : null;
  }

  async function permissionMatches(
    roleId: string,
    permission: string
  ): Promise<{ matches: boolean; deny: boolean }> {
    const def = await getRoleDef(roleId);
    if (!def) return { matches: false, deny: false };
    if (def.permissions.includes("*")) return { matches: true, deny: false };
    const denyKey = `deny:${permission}`;
    if (def.permissions.includes(denyKey)) return { matches: false, deny: true };
    if (def.permissions.includes(permission)) return { matches: true, deny: false };
    return { matches: false, deny: false };
  }

  return {
    async createOrganization({ id, name, parentOrgId }) {
      const orgId = id ?? uuid();
      await client.insert({
        table: t.organizations,
        values: [
          {
            id: orgId,
            name,
            parent_org_id: parentOrgId ?? null,
            created_at: chDateNow(),
            updated_at: chDateNow(),
            _deleted: 0,
          },
        ],
        format: "JSONEachRow",
      });
      return { id: orgId };
    },

    async getOrganization(id) {
      const rows = await rowsFromQuery(
        `SELECT id, name, parent_org_id FROM ${t.organizations} FINAL
         WHERE id = {id:String} AND _deleted = 0 LIMIT 1`,
        { id }
      );
      if (rows.length === 0) return null;
      const r = rows[0]!;
      return {
        id: String(r.id),
        name: String(r.name),
        parentOrgId: r.parent_org_id ? String(r.parent_org_id) : null,
      };
    },

    async listChildOrganizations(parentId) {
      const rows = await rowsFromQuery(
        `SELECT id, name, parent_org_id FROM ${t.organizations} FINAL
         WHERE parent_org_id = {pid:String} AND _deleted = 0`,
        { pid: parentId }
      );
      return rows.map((r) => ({
        id: String(r.id),
        name: String(r.name),
        parentOrgId: r.parent_org_id ? String(r.parent_org_id) : null,
      }));
    },

    async listDescendantOrganizations(parentId) {
      const ids = await collectDescendants(
        parentId,
        async (id) => {
          const rows = await rowsFromQuery(
            `SELECT id FROM ${t.organizations} FINAL WHERE parent_org_id = {pid:String} AND _deleted = 0`,
            { pid: id }
          );
          return rows.map((r) => String(r.id));
        },
        { kind: "org tree" }
      );
      const out: Organization[] = [];
      for (const id of ids) {
        const o = await this.getOrganization(id);
        if (o) out.push(o);
      }
      return out;
    },

    async createDepartment({ id, orgId, name, parentDeptId }) {
      const deptId = id ?? uuid();
      await client.insert({
        table: t.departments,
        values: [
          {
            id: deptId,
            org_id: orgId,
            parent_dept_id: parentDeptId ?? null,
            name,
            created_at: chDateNow(),
            updated_at: chDateNow(),
            _deleted: 0,
          },
        ],
        format: "JSONEachRow",
      });
      return { id: deptId };
    },

    async listDepartments(orgId) {
      const rows = await rowsFromQuery(
        `SELECT id, org_id, parent_dept_id, name FROM ${t.departments} FINAL
         WHERE org_id = {oid:String} AND _deleted = 0`,
        { oid: orgId }
      );
      return rows.map((r) => ({
        id: String(r.id),
        orgId: String(r.org_id),
        parentDeptId: r.parent_dept_id ? String(r.parent_dept_id) : null,
        name: String(r.name),
      }));
    },

    async setUserHomeOrg(userId, orgId) {
      await mutateUser(userId, { home_org_id: orgId });
    },

    async setUserDepartment(userId, deptId) {
      await mutateUser(userId, { department_id: deptId });
    },

    async setUserSupervisor(userId, supervisorUserId) {
      await mutateUser(userId, { supervisor_user_id: supervisorUserId });
    },

    async getSupervisorChain(userId, opts) {
      const chain = await traverseChain(
        userId,
        async (id) => {
          const home = await getUserHome(id);
          return home?.supervisorUserId ?? null;
        },
        { maxDepth: opts?.maxDepth ?? 50, kind: "supervisor chain" }
      );
      // Return chain WITHOUT the starting user (caller asked for *supervisors*)
      return chain.slice(1);
    },

    async defineRole({ id, scope, permissions }) {
      await client.insert({
        table: t.roles,
        values: [
          {
            id,
            scope,
            permissions: JSON.stringify(permissions),
            created_at: chDateNow(),
            updated_at: chDateNow(),
            _deleted: 0,
          },
        ],
        format: "JSONEachRow",
      });
    },

    async grantUserRole({ userId, roleId, orgId, deptId, grantedBy, expiresAt }) {
      const id = uuid();
      await client.insert({
        table: t.userRoleGrants,
        values: [
          {
            id,
            user_id: userId,
            role_id: roleId,
            // empty-string sentinel — these columns are non-nullable to be
            // valid ORDER BY keys in CH (see ddl.ts comment).
            org_id: orgId ?? "",
            dept_id: deptId ?? "",
            granted_by: grantedBy,
            expires_at: expiresAt ? chDate(expiresAt) : null,
            created_at: chDateNow(),
            updated_at: chDateNow(),
            _deleted: 0,
          },
        ],
        format: "JSONEachRow",
      });
      return { id };
    },

    async revokeUserRole({ userId, roleId, orgId, deptId }) {
      // Tombstone the grant matching (user_id, role_id, org_id, dept_id)
      await client.insert({
        table: t.userRoleGrants,
        values: [
          {
            id: uuid(),
            user_id: userId,
            role_id: roleId,
            org_id: orgId ?? "",
            dept_id: deptId ?? "",
            granted_by: "",
            expires_at: null,
            updated_at: chDateNow(),
            _deleted: 1,
          },
        ],
        format: "JSONEachRow",
      });
    },

    async listEffectiveRoles(userId, opts) {
      const grants = await listGrantsForUser(userId);
      const out: EffectiveRole[] = [];
      for (const g of grants) {
        // direct
        if (
          (!opts?.orgId || g.orgId === opts.orgId || !g.orgId) &&
          (!opts?.deptId || g.deptId === opts.deptId || !g.deptId)
        ) {
          const def = await getRoleDef(g.roleId);
          if (!def) continue;
          out.push({
            roleId: g.roleId,
            scope: def.scope,
            orgId: g.orgId,
            deptId: g.deptId,
            via: "direct",
          });
        }
      }
      return out;
    },

    async resolvePermission({ userId, permission, resource }) {
      const t0 = Date.now();
      const grants = await listGrantsForUser(userId);
      const rolesUsed: string[] = [];

      // Step 1: superadmin (system role with '*')
      for (const g of grants) {
        const def = await getRoleDef(g.roleId);
        if (def?.scope === "system" && def.permissions.includes("*")) {
          logger?.info("auth.ch.rbac.permission.allow", {
            userId,
            permission,
            via: "superadmin",
            elapsedMs: Date.now() - t0,
          });
          return { allowed: true, via: "superadmin", rolesUsed: [g.roleId] };
        }
      }

      // Step 2: explicit deny anywhere
      for (const g of grants) {
        const m = await permissionMatches(g.roleId, permission);
        if (m.deny) {
          logger?.info("auth.ch.rbac.permission.deny", {
            userId,
            permission,
            reason: "explicit deny",
            elapsedMs: Date.now() - t0,
          });
          return { allowed: false, reason: `denied by role ${g.roleId}` };
        }
      }

      // Step 3: direct role on resource org/dept
      if (resource?.orgId || resource?.deptId) {
        for (const g of grants) {
          const orgMatch = resource.orgId && g.orgId === resource.orgId;
          const deptMatch = resource.deptId && g.deptId === resource.deptId;
          if (!orgMatch && !deptMatch) continue;
          const m = await permissionMatches(g.roleId, permission);
          if (m.matches) {
            rolesUsed.push(g.roleId);
            logger?.info("auth.ch.rbac.permission.allow", {
              userId,
              permission,
              via: "role",
              rolesUsed,
              elapsedMs: Date.now() - t0,
            });
            return { allowed: true, via: "role", rolesUsed };
          }
        }
      }

      // Step 4: role inherited up the org tree
      if (resource?.orgId) {
        let cursor: string | null = resource.orgId;
        const seen = new Set<string>();
        while (cursor) {
          if (seen.has(cursor)) {
            throw new Error(`cycle in org tree at ${cursor}`);
          }
          seen.add(cursor);
          const parent: string | null = await fetchOrgParent(cursor);
          if (!parent) break;
          for (const g of grants) {
            if (g.orgId !== parent) continue;
            const m = await permissionMatches(g.roleId, permission);
            if (m.matches) {
              rolesUsed.push(g.roleId);
              logger?.info("auth.ch.rbac.permission.allow", {
                userId,
                permission,
                via: "inherited",
                rolesUsed,
                elapsedMs: Date.now() - t0,
              });
              return { allowed: true, via: "inherited", rolesUsed };
            }
          }
          cursor = parent;
        }
      }

      // Step 5: role on user's home org
      const home = await getUserHome(userId);
      if (home?.homeOrgId) {
        for (const g of grants) {
          if (g.orgId !== home.homeOrgId) continue;
          const m = await permissionMatches(g.roleId, permission);
          if (m.matches) {
            rolesUsed.push(g.roleId);
            logger?.info("auth.ch.rbac.permission.allow", {
              userId,
              permission,
              via: "home_org",
              rolesUsed,
              elapsedMs: Date.now() - t0,
            });
            return { allowed: true, via: "home_org", rolesUsed };
          }
        }
      }

      // Step 6: supervisor-chain delegation
      const chain = await this.getSupervisorChain(userId, { maxDepth: 10 });
      for (const supervisorId of chain) {
        const supGrants = await listGrantsForUser(supervisorId);
        for (const g of supGrants) {
          const m = await permissionMatches(g.roleId, permission);
          if (m.matches) {
            rolesUsed.push(g.roleId);
            logger?.info("auth.ch.rbac.permission.allow", {
              userId,
              permission,
              via: "supervisor",
              supervisor: supervisorId,
              rolesUsed,
              elapsedMs: Date.now() - t0,
            });
            return { allowed: true, via: "supervisor", rolesUsed };
          }
        }
      }

      logger?.info("auth.ch.rbac.permission.deny", {
        userId,
        permission,
        reason: "no matching role",
        elapsedMs: Date.now() - t0,
      });
      return { allowed: false, reason: "no matching role" };
    },
  };
}
