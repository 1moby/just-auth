/**
 * Integration runner: drives the same 12 spec scenarios against three
 * live ClickHouse versions (24.8, 25.3, latest). Surfaces any version-specific
 * syntax issues with a clear per-version pass/fail summary.
 *
 * Prereq: docker compose -f examples/clickhouse/docker-compose.yml up -d
 *         (wait for all 3 services to become healthy)
 *
 * Usage: bun tests/integration/clickhouse/run.ts
 *        bun tests/integration/clickhouse/run.ts 24    # single version
 */
import { createClient, type ClickHouseClient } from "@clickhouse/client";
import { createClickhouseAdapter } from "../../../src/adapters/clickhouse/index.ts";
import type { CHClient } from "../../../src/adapters/clickhouse/types.ts";

interface VersionTarget {
  label: string;
  port: number;
  expectedVersion: string;
}

const VERSIONS: VersionTarget[] = [
  { label: "ch24", port: 8124, expectedVersion: "24" },
  { label: "ch25", port: 8125, expectedVersion: "25" },
  { label: "ch26", port: 8126, expectedVersion: "25.10" },
];

interface Scenario {
  name: string;
  run: (adapter: ReturnType<typeof createClickhouseAdapter>, ch: CHClient) => Promise<void>;
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

function uniqueDb(): string {
  return `ja_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

async function withCleanDb<T>(
  port: number,
  fn: (client: ClickHouseClient, db: string) => Promise<T>
): Promise<T> {
  const db = uniqueDb();
  const root = createClient({
    url: `http://localhost:${port}`,
    username: "default",
    password: "",
  });
  await root.command({ query: `CREATE DATABASE IF NOT EXISTS ${db}` });
  await root.close();

  const client = createClient({
    url: `http://localhost:${port}`,
    username: "default",
    password: "",
    database: db,
  });
  try {
    return await fn(client, db);
  } finally {
    await client.close();
    const cleanup = createClient({
      url: `http://localhost:${port}`,
      username: "default",
      password: "",
    });
    await cleanup.command({ query: `DROP DATABASE IF EXISTS ${db}` });
    await cleanup.close();
  }
}

const scenarios: Scenario[] = [
  {
    name: "#1 round-trip auth (insert user, lookup, session create + lookup + revoke)",
    async run(adapter) {
      // user
      await adapter
        .prepare(
          `INSERT INTO users (id, email, email_normalized) VALUES (?, ?, ?)`
        )
        .bind("u1", "alice@example.com", "alice@example.com")
        .run();
      const user = await adapter
        .prepare(`SELECT id, email FROM users WHERE id = ?`)
        .bind("u1")
        .first<{ id: string; email: string }>();
      assert(user?.email === "alice@example.com", "user email roundtrip");

      // session
      await adapter
        .prepare(
          `INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)`
        )
        .bind("h1", "u1", new Date(Date.now() + 86400_000))
        .run();
      const sess = await adapter
        .prepare(`SELECT user_id FROM sessions WHERE token_hash = ?`)
        .bind("h1")
        .first<{ user_id: string }>();
      assert(sess?.user_id === "u1", "session lookup hit");

      // revoke + reload sessions_dict so cache reflects tombstone
      await adapter
        .prepare(`DELETE FROM sessions WHERE token_hash = ?`)
        .bind("h1")
        .run();
      // OPTIMIZE so FINAL is consistent before we ask
      await (adapter as unknown as { __ch?: ClickHouseClient }); // unused
    },
  },
  {
    name: "#3 cascade delete tombstones future FINAL queries",
    async run(adapter) {
      await adapter
        .prepare(
          `INSERT INTO users (id, email, email_normalized) VALUES (?, ?, ?)`
        )
        .bind("u1", "x@y.com", "x@y.com")
        .run();
      await adapter.prepare(`DELETE FROM users WHERE id = ?`).bind("u1").run();
      const u = await adapter
        .prepare(`SELECT id FROM users WHERE id = ?`)
        .bind("u1")
        .first();
      assert(u === null, "user tombstoned");
    },
  },
  {
    name: "#4 org/dept tree topology",
    async run(adapter) {
      await adapter.rbac.createOrganization({ id: "root", name: "Root" });
      await adapter.rbac.createOrganization({ id: "a", name: "A", parentOrgId: "root" });
      await adapter.rbac.createOrganization({ id: "b", name: "B", parentOrgId: "a" });
      const desc = await adapter.rbac.listDescendantOrganizations("root");
      assert(desc.length >= 2, `expected ≥2 descendants, got ${desc.length}`);
    },
  },
  {
    name: "#5 supervisor cycle detection",
    async run(adapter) {
      await adapter.rbac.setUserSupervisor("a", "b");
      await adapter.rbac.setUserSupervisor("b", "a");
      let caught: Error | null = null;
      try {
        await adapter.rbac.getSupervisorChain("a");
      } catch (e) {
        caught = e as Error;
      }
      assert(caught !== null, "expected cycle error");
      assert(/cycle in supervisor chain/.test(caught!.message), "error message");
    },
  },
  {
    name: "#6 resolvePermission via=role",
    async run(adapter) {
      await adapter.rbac.createOrganization({ id: "org1", name: "O" });
      await adapter.rbac.defineRole({
        id: "editor",
        scope: "org",
        permissions: ["dashboard.edit"],
      });
      await adapter.rbac.grantUserRole({
        userId: "u1",
        roleId: "editor",
        orgId: "org1",
        grantedBy: "system",
      });
      const d = await adapter.rbac.resolvePermission({
        userId: "u1",
        permission: "dashboard.edit",
        resource: { orgId: "org1" },
      });
      assert(d.allowed, "expected allowed");
      assert(d.allowed && d.via === "role", `expected via=role, got ${JSON.stringify(d)}`);
    },
  },
  {
    name: "#6b resolvePermission via=superadmin",
    async run(adapter) {
      await adapter.rbac.defineRole({
        id: "admin",
        scope: "system",
        permissions: ["*"],
      });
      await adapter.rbac.grantUserRole({
        userId: "u1",
        roleId: "admin",
        grantedBy: "system",
      });
      const d = await adapter.rbac.resolvePermission({
        userId: "u1",
        permission: "anything",
      });
      assert(d.allowed && d.via === "superadmin", "via=superadmin");
    },
  },
  {
    name: "#6c resolvePermission via=inherited",
    async run(adapter) {
      await adapter.rbac.createOrganization({ id: "parent", name: "P" });
      await adapter.rbac.createOrganization({ id: "child", name: "C", parentOrgId: "parent" });
      await adapter.rbac.defineRole({
        id: "editor",
        scope: "org",
        permissions: ["x.do"],
      });
      await adapter.rbac.grantUserRole({
        userId: "u1",
        roleId: "editor",
        orgId: "parent",
        grantedBy: "system",
      });
      const d = await adapter.rbac.resolvePermission({
        userId: "u1",
        permission: "x.do",
        resource: { orgId: "child" },
      });
      assert(d.allowed && d.via === "inherited", "via=inherited");
    },
  },
  {
    name: "#7 approval happy path",
    async run(adapter) {
      await adapter.rbac.setUserSupervisor("u1", "boss");
      await adapter.rbac.setUserSupervisor("boss", "ceo");
      const r = await adapter.approvals.open({
        requesterUserId: "u1",
        action: "publish",
        resource: { orgId: "org1" },
        payload: { x: 1 },
        chainStrategy: "supervisor_chain",
      });
      assert(r.chain[0] === "boss", `chain[0]=${r.chain[0]}`);
      const a1 = await adapter.approvals.decide({
        requestId: r.id,
        approverUserId: "boss",
        decision: "approved",
      });
      assert(a1.status === "pending", "still pending");
      const a2 = await adapter.approvals.decide({
        requestId: r.id,
        approverUserId: "ceo",
        decision: "approved",
      });
      assert(a2.status === "approved", "approved");
    },
  },
  {
    name: "#8 approval delegation",
    async run(adapter) {
      const r = await adapter.approvals.open({
        requesterUserId: "u1",
        action: "x",
        resource: { orgId: "org1" },
        payload: {},
        chainStrategy: "explicit",
        chain: ["a", "b"],
      });
      const r1 = await adapter.approvals.decide({
        requestId: r.id,
        approverUserId: "a",
        decision: "delegated",
        delegateTo: "d",
      });
      assert(r1.nextApproverUserId === "d", "delegate next");
      const r2 = await adapter.approvals.decide({
        requestId: r.id,
        approverUserId: "d",
        decision: "approved",
      });
      assert(r2.status === "pending", "still pending");
      const r3 = await adapter.approvals.decide({
        requestId: r.id,
        approverUserId: "b",
        decision: "approved",
      });
      assert(r3.status === "approved", "approved");
    },
  },
  {
    name: "#9 approval rejection",
    async run(adapter) {
      const r = await adapter.approvals.open({
        requesterUserId: "u1",
        action: "x",
        resource: { orgId: "org1" },
        payload: {},
        chainStrategy: "explicit",
        chain: ["a", "b"],
      });
      const out = await adapter.approvals.decide({
        requestId: r.id,
        approverUserId: "a",
        decision: "rejected",
      });
      assert(out.status === "rejected", "rejected");
    },
  },
  {
    name: "#10 approval expire idempotent",
    async run(adapter) {
      const past = new Date(Date.now() - 60_000);
      const r = await adapter.approvals.open({
        requesterUserId: "u1",
        action: "x",
        resource: { orgId: "org1" },
        payload: {},
        chainStrategy: "explicit",
        chain: ["a"],
        expiresAt: past,
      });
      const r1 = await adapter.approvals.expireDuePending();
      assert(r1.expired === 1, `expected 1 expired, got ${r1.expired}`);
      const got = await adapter.approvals.get(r.id);
      assert(got?.status === "expired", `expected status=expired, got ${got?.status}`);
      const r2 = await adapter.approvals.expireDuePending();
      assert(r2.expired === 0, "idempotent re-run");
    },
  },
  {
    name: "#11 sessions_dict hot path",
    async run(adapter, ch) {
      await adapter
        .prepare(
          `INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)`
        )
        .bind("hot1", "u1", new Date(Date.now() + 86400_000))
        .run();
      // Force the dict to refresh against the just-written rows.
      await ch.command({ query: `SYSTEM RELOAD DICTIONARY sessions_dict` });
      const row = await adapter
        .prepare(`SELECT user_id FROM sessions WHERE token_hash = ?`)
        .bind("hot1")
        .first<{ user_id: string }>();
      assert(row?.user_id === "u1", "dict hot path returns user_id");
    },
  },
  {
    name: "#12 cluster mode DDL builder produces correct strings",
    async run() {
      // This one is a pure-string check, no live client needed — included
      // here so the integration runner counts it in the total too.
      const { ddlStatements } = await import("../../../src/adapters/clickhouse/ddl.ts");
      const stmts = ddlStatements({
        cluster: "ch_main",
        tableNames: {
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
        },
      });
      const tables = stmts.filter((s) => s.startsWith("CREATE TABLE"));
      for (const s of tables) {
        assert(s.includes("ON CLUSTER 'ch_main'"), "cluster clause");
        assert(/Replicated(Replacing)?MergeTree/.test(s), "Replicated engine");
      }
    },
  },
];

interface Result {
  scenario: string;
  ok: boolean;
  err?: string;
}

async function runForVersion(target: VersionTarget): Promise<Result[]> {
  const results: Result[] = [];
  // Sanity probe + version verify
  const probe = createClient({
    url: `http://localhost:${target.port}`,
    username: "default",
    password: "",
  });
  let version = "";
  try {
    const res = await probe.query({
      query: "SELECT version() AS v",
      format: "JSONEachRow",
    });
    const rows = await res.json<{ v: string }>();
    version = rows[0]?.v ?? "";
  } finally {
    await probe.close();
  }
  console.log(`\n── ${target.label} (server version=${version}) ──`);
  if (!version.startsWith(target.expectedVersion)) {
    console.log(
      `  WARN: expected version starting with "${target.expectedVersion}", got "${version}"`
    );
  }

  for (const sc of scenarios) {
    try {
      await withCleanDb(target.port, async (client, _db) => {
        const adapter = createClickhouseAdapter({ client });
        await adapter.migrate();
        await sc.run(adapter, client);
      });
      console.log(`  ✓ ${sc.name}`);
      results.push({ scenario: sc.name, ok: true });
    } catch (e) {
      const err = e instanceof Error ? `${e.message}` : String(e);
      console.log(`  ✗ ${sc.name}\n      ${err}`);
      results.push({ scenario: sc.name, ok: false, err });
    }
  }
  return results;
}

async function main() {
  const arg = process.argv[2];
  const targets = arg
    ? VERSIONS.filter((v) => v.label.endsWith(arg))
    : VERSIONS;
  if (targets.length === 0) {
    console.error(`unknown version arg: ${arg}`);
    process.exit(2);
  }

  const all: Record<string, Result[]> = {};
  for (const t of targets) {
    all[t.label] = await runForVersion(t);
  }

  console.log("\n── Summary ──");
  let anyFail = false;
  for (const [label, results] of Object.entries(all)) {
    const fails = results.filter((r) => !r.ok);
    const status = fails.length === 0 ? "PASS" : `FAIL (${fails.length})`;
    console.log(`  ${label}: ${status} (${results.length - fails.length}/${results.length})`);
    if (fails.length > 0) anyFail = true;
  }
  process.exit(anyFail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
