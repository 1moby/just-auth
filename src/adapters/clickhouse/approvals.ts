import type {
  CHClient,
  CHTableNames,
  Logger,
  ApprovalRequest,
  ApprovalStatus,
} from "./types.ts";
import type { RbacApi } from "./rbac.ts";

export interface ApprovalsApi {
  open(args: {
    requesterUserId: string;
    action: string;
    resource: { orgId: string; deptId?: string; resourceType?: string; resourceId?: string };
    payload: unknown;
    chainStrategy: "supervisor_chain" | "role_holders" | "explicit";
    chain?: string[];
    requiredRoleId?: string;
    chainMaxDepth?: number;
    expiresAt?: Date | null;
  }): Promise<{ id: string; status: "pending"; chain: string[] }>;
  decide(args: {
    requestId: string;
    approverUserId: string;
    decision: "approved" | "rejected" | "delegated";
    comment?: string;
    delegateTo?: string;
  }): Promise<{ requestId: string; status: ApprovalStatus; nextApproverUserId: string | null }>;
  get(requestId: string): Promise<ApprovalRequest | null>;
  listForApprover(approverUserId: string, opts?: { status?: ApprovalStatus[]; limit?: number; cursor?: string }): Promise<ApprovalRequest[]>;
  listForRequester(requesterUserId: string, opts?: { status?: ApprovalStatus[]; limit?: number; cursor?: string }): Promise<ApprovalRequest[]>;
  expireDuePending(now?: Date): Promise<{ expired: number }>;
}

interface ApprovalsOptions {
  client: CHClient;
  tableNames: CHTableNames;
  rbac: RbacApi;
  logger?: Logger;
}

function uuid(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function nowMs(): string {
  return new Date().toISOString();
}

export function createApprovalsApi(opts: ApprovalsOptions): ApprovalsApi {
  const { client, tableNames: t, rbac, logger } = opts;

  async function rowsFromQuery(query: string, params: Record<string, unknown>) {
    const res = await client.query({
      query,
      query_params: params,
      format: "JSONEachRow",
    });
    return res.json<Record<string, unknown>>();
  }

  function rowToRequest(r: Record<string, unknown>): ApprovalRequest {
    let payload: unknown = null;
    try {
      payload = JSON.parse(String(r.payload ?? "null"));
    } catch {
      payload = null;
    }
    return {
      id: String(r.id),
      requesterUserId: String(r.requester_user_id),
      action: String(r.action),
      resourceType: r.resource_type ? String(r.resource_type) : null,
      resourceId: r.resource_id ? String(r.resource_id) : null,
      orgId: String(r.org_id),
      deptId: r.dept_id ? String(r.dept_id) : null,
      payload,
      chain: Array.isArray(r.chain) ? (r.chain as string[]) : [],
      currentStep: Number(r.current_step ?? 0),
      status: String(r.status ?? "pending") as ApprovalStatus,
      expiresAt: r.expires_at ? new Date(String(r.expires_at)) : null,
      createdAt: new Date(String(r.created_at)),
      updatedAt: new Date(String(r.updated_at)),
    };
  }

  async function getRequest(id: string): Promise<ApprovalRequest | null> {
    const rows = await rowsFromQuery(
      `SELECT * FROM ${t.approvalRequests} FINAL WHERE id = {id:String} LIMIT 1`,
      { id }
    );
    if (rows.length === 0) return null;
    return rowToRequest(rows[0]!);
  }

  async function buildChain(
    strategy: "supervisor_chain" | "role_holders" | "explicit",
    args: {
      requesterUserId: string;
      requiredRoleId?: string;
      explicitChain?: string[];
      maxDepth: number;
      orgId: string;
    }
  ): Promise<string[]> {
    if (strategy === "explicit") {
      const c = args.explicitChain ?? [];
      if (c.length === 0) throw new Error("explicit chain must be non-empty");
      const seen = new Set<string>();
      for (const u of c) {
        if (seen.has(u)) throw new Error(`duplicate user in explicit chain: ${u}`);
        seen.add(u);
      }
      return c;
    }
    if (strategy === "supervisor_chain") {
      return rbac.getSupervisorChain(args.requesterUserId, { maxDepth: args.maxDepth });
    }
    // role_holders
    if (!args.requiredRoleId) {
      throw new Error("requiredRoleId required for chainStrategy='role_holders'");
    }
    const rows = await rowsFromQuery(
      `SELECT user_id FROM ${t.userRoleGrants} FINAL
       WHERE role_id = {rid:String} AND org_id = {oid:String} AND _deleted = 0
       ORDER BY created_at LIMIT 50`,
      { rid: args.requiredRoleId, oid: args.orgId }
    );
    return rows.map((r) => String(r.user_id));
  }

  async function appendDecision(
    requestId: string,
    step: number,
    approverUserId: string,
    decision: "approved" | "rejected" | "delegated",
    delegateUserId: string | null,
    comment: string | null
  ) {
    await client.insert({
      table: t.approvalDecisions,
      values: [
        {
          request_id: requestId,
          step,
          approver_user_id: approverUserId,
          decision,
          delegate_user_id: delegateUserId,
          comment,
          decided_at: nowMs(),
        },
      ],
      format: "JSONEachRow",
    });
  }

  async function writeRequest(req: ApprovalRequest): Promise<void> {
    await client.insert({
      table: t.approvalRequests,
      values: [
        {
          id: req.id,
          requester_user_id: req.requesterUserId,
          action: req.action,
          resource_type: req.resourceType,
          resource_id: req.resourceId,
          org_id: req.orgId,
          dept_id: req.deptId,
          payload: JSON.stringify(req.payload ?? null),
          chain: req.chain,
          current_step: req.currentStep,
          status: req.status,
          expires_at: req.expiresAt ? req.expiresAt.toISOString() : null,
          created_at: req.createdAt.toISOString(),
          updated_at: req.updatedAt.toISOString(),
          _deleted: 0,
        },
      ],
      format: "JSONEachRow",
    });
  }

  return {
    async open(args) {
      const id = uuid();
      const chain = await buildChain(args.chainStrategy, {
        requesterUserId: args.requesterUserId,
        requiredRoleId: args.requiredRoleId,
        explicitChain: args.chain,
        maxDepth: args.chainMaxDepth ?? 5,
        orgId: args.resource.orgId,
      });
      if (chain.length === 0) {
        throw new Error("approval chain resolved to empty — no approvers");
      }
      const now = new Date();
      const req: ApprovalRequest = {
        id,
        requesterUserId: args.requesterUserId,
        action: args.action,
        resourceType: args.resource.resourceType ?? null,
        resourceId: args.resource.resourceId ?? null,
        orgId: args.resource.orgId,
        deptId: args.resource.deptId ?? null,
        payload: args.payload,
        chain,
        currentStep: 0,
        status: "pending",
        expiresAt: args.expiresAt ?? null,
        createdAt: now,
        updatedAt: now,
      };
      await writeRequest(req);
      logger?.info("auth.ch.approval.open", { id, chainLength: chain.length });
      return { id, status: "pending", chain };
    },

    async decide(args) {
      const req = await getRequest(args.requestId);
      if (!req) throw new Error(`approval request not found: ${args.requestId}`);

      // Idempotency: if already terminal, return current state
      if (req.status !== "pending") {
        return {
          requestId: req.id,
          status: req.status,
          nextApproverUserId: null,
        };
      }

      const expectedApprover = req.chain[req.currentStep];
      if (expectedApprover !== args.approverUserId) {
        throw new Error(
          `not current approver: expected ${expectedApprover}, got ${args.approverUserId}`
        );
      }

      // Idempotency on (requestId, approverUserId): if a decision row exists
      // for this approver+step, treat as no-op replay
      const prior = await rowsFromQuery(
        `SELECT decision FROM ${t.approvalDecisions}
         WHERE request_id = {id:String} AND step = {step:String} AND approver_user_id = {uid:String}
         LIMIT 1`,
        {
          id: req.id,
          step: String(req.currentStep),
          uid: args.approverUserId,
        }
      );
      if (prior.length > 0) {
        // Re-fetch and return whatever the request status now is
        const cur = (await getRequest(req.id))!;
        return {
          requestId: cur.id,
          status: cur.status,
          nextApproverUserId:
            cur.status === "pending" && cur.chain[cur.currentStep]
              ? cur.chain[cur.currentStep]!
              : null,
        };
      }

      const now = new Date();
      await appendDecision(
        req.id,
        req.currentStep,
        args.approverUserId,
        args.decision,
        args.delegateTo ?? null,
        args.comment ?? null
      );

      let newStatus: ApprovalStatus = req.status;
      let newStep = req.currentStep;
      let newChain = [...req.chain];
      let nextApprover: string | null = null;

      switch (args.decision) {
        case "approved": {
          if (req.currentStep + 1 >= req.chain.length) {
            newStatus = "approved";
          } else {
            newStep = req.currentStep + 1;
            nextApprover = req.chain[newStep]!;
          }
          break;
        }
        case "rejected": {
          newStatus = "rejected";
          break;
        }
        case "delegated": {
          if (!args.delegateTo) {
            throw new Error("delegateTo required for decision='delegated'");
          }
          // Delegate replaces the current approver. The chain length is unchanged;
          // currentStep stays put so the delegate is now the active approver.
          newChain = [
            ...req.chain.slice(0, req.currentStep),
            args.delegateTo,
            ...req.chain.slice(req.currentStep + 1),
          ];
          nextApprover = args.delegateTo;
          break;
        }
      }

      const updated: ApprovalRequest = {
        ...req,
        chain: newChain,
        currentStep: newStep,
        status: newStatus,
        updatedAt: now,
      };
      await writeRequest(updated);
      logger?.info("auth.ch.approval.decide", {
        id: req.id,
        decision: args.decision,
        status: newStatus,
      });
      return {
        requestId: req.id,
        status: newStatus,
        nextApproverUserId: nextApprover,
      };
    },

    async get(requestId) {
      return getRequest(requestId);
    },

    async listForApprover(approverUserId, opts) {
      const status = opts?.status ?? ["pending"];
      const limit = opts?.limit ?? 50;
      const rows = await rowsFromQuery(
        `SELECT * FROM ${t.approvalRequests} FINAL
         WHERE _deleted = 0
         ORDER BY updated_at LIMIT {lim:String}`,
        { lim: String(limit * 4) }
      );
      const all = rows.map(rowToRequest);
      return all
        .filter(
          (r) =>
            status.includes(r.status) &&
            r.chain[r.currentStep] === approverUserId
        )
        .slice(0, limit);
    },

    async listForRequester(requesterUserId, opts) {
      const status = opts?.status;
      const limit = opts?.limit ?? 50;
      const rows = await rowsFromQuery(
        `SELECT * FROM ${t.approvalRequests} FINAL
         WHERE requester_user_id = {uid:String} AND _deleted = 0
         ORDER BY created_at LIMIT {lim:String}`,
        { uid: requesterUserId, lim: String(limit * 4) }
      );
      const all = rows.map(rowToRequest);
      return all.filter((r) => !status || status.includes(r.status)).slice(0, limit);
    },

    async expireDuePending(now) {
      const cutoff = (now ?? new Date()).toISOString();
      const rows = await rowsFromQuery(
        `SELECT * FROM ${t.approvalRequests} FINAL
         WHERE status = {pending:String} AND expires_at < {cutoff:String} AND _deleted = 0`,
        { pending: "pending", cutoff }
      );
      let n = 0;
      for (const r of rows) {
        const req = rowToRequest(r);
        await writeRequest({ ...req, status: "expired", updatedAt: new Date() });
        n++;
      }
      logger?.info("auth.ch.approval.expire", { expired: n });
      return { expired: n };
    },
  };
}
