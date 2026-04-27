# ClickHouse Adapter + RBAC Graph + Approval Flow — 0.4.0

> Backward-compatible additive feature. Existing `DatabaseAdapter` shape, `RbacConfig`, `createReactAuth`, all current adapters, and all 309 existing tests must remain unchanged.

**Goal:** Add a ClickHouse adapter that doubles as a host for two new in-package APIs: a multi-org/department/supervisor RBAC graph and an approval-flow state machine.

**Architecture:**
- New module `src/adapters/clickhouse/` exporting `createClickhouseAdapter({ client, ... })`.
- Returns the existing `DatabaseAdapter` shape (so `createReactAuth({ database: ... })` works) **plus** three extra members: `rbac` (graph + permission engine), `approvals` (state machine), `migrate()` (idempotent DDL).
- All RBAC + approval data lives in *new* tables. No changes to `users`/`accounts`/`sessions` schema beyond what existing core SQL already produces.
- Token hashing matches `core/session.ts:hashToken` (SHA-256 hex).
- All ClickHouse queries use named params (`{name:Type}`); never string-interpolate values.
- All hot reads use `FINAL` on `ReplacingMergeTree`. Hottest path (session-by-token) is also exposed via `sessions_dict` Dictionary.
- When `cluster` is provided, every DDL gets `ON CLUSTER` and engines wrap to `Replicated*`.

**Tech stack:** TypeScript, Bun test, `@clickhouse/client` (peer dependency).

**Out of scope:** changes to `pgAdapter`/`bunSqliteAdapter`/etc., changes to existing `RbacConfig`-style RBAC, UI, notifications, data migration scripts.

---

## File structure

```
src/adapters/clickhouse/
├── index.ts                    # createClickhouseAdapter() — the only export
├── types.ts                    # CHClient interface, Organization, Department, etc.
├── ddl.ts                      # DDL string builders, cluster-aware
├── adapter-core.ts             # DatabaseAdapter (prepare/bind/run/first/all) translation
├── sql-translator.ts           # ?-style SQL → CH named-params + JOINs that CH can handle
├── queries/
│   ├── rbac.ts                 # SQL strings for RBAC reads/writes
│   └── approvals.ts            # SQL strings for approval reads/writes
├── rbac.ts                     # RbacApi factory (org tree, dept tree, supervisor, resolvePermission)
├── approvals.ts                # ApprovalsApi factory (open/decide/list/expire state machine)
├── cycle-detect.ts             # cycle-safe traversal helpers (org tree, supervisor chain)
└── migrate.ts                  # migrate() — runs DDL idempotently, cluster-aware

tests/adapters/clickhouse/
├── helpers/mock-ch.ts          # in-memory ClickHouseClient that simulates ReplacingMergeTree FINAL
├── adapter-roundtrip.test.ts   # spec test #1 (round-trip auth)
├── email-uniqueness.test.ts    # spec test #2
├── cascade-delete.test.ts      # spec test #3
├── org-dept-tree.test.ts       # spec test #4
├── cycle-detect.test.ts        # spec test #5
├── permission-resolve.test.ts  # spec test #6
├── approval-happy-path.test.ts # spec test #7
├── approval-delegation.test.ts # spec test #8
├── approval-rejection.test.ts  # spec test #9
├── approval-expire.test.ts     # spec test #10
├── sessions-dict.test.ts       # spec test #11
└── cluster-mode.test.ts        # spec test #12
```

Backward-compat surface: re-export `createClickhouseAdapter` from `src/index.ts` (no path break — adapter ID `@1moby/just-auth/adapters/clickhouse`). Add `./adapters/clickhouse` entry to `package.json` `exports`.

---

## Phases (in execution order)

Each phase ends with a green test run + commit. Phases are sequential because later phases consume earlier ones.

### Phase A — `CHClient` interface + mock client + adapter scaffold (≈30 lines code, ≈80 lines mock)

**Files:** `src/adapters/clickhouse/types.ts`, `tests/adapters/clickhouse/helpers/mock-ch.ts`.

The `@clickhouse/client` API surface we need (kept minimal so we can mock it):

```ts
export interface CHClient {
  query(args: { query: string; query_params?: Record<string, unknown>; format?: 'JSONEachRow' | 'JSON' }): Promise<{ json<T = Record<string, unknown>>(): Promise<T[]> }>;
  command(args: { query: string; query_params?: Record<string, unknown> }): Promise<void>;
  insert(args: { table: string; values: Record<string, unknown>[]; format?: 'JSONEachRow' }): Promise<void>;
}
```

Mock client semantics:
- `command(query)` records the DDL. For `CREATE TABLE` it registers a table with `engine`, `version_col`, `order_by`. For `CREATE DICTIONARY` it registers a refresh closure.
- `insert(table, values)` appends rows including framework-managed `_deleted` and timestamp columns.
- `query(...)` is a tiny SQL parser supporting only the patterns we actually use: `SELECT … FROM <t> [FINAL] WHERE … {param:Type} … [ORDER BY …] [LIMIT N]`, `dictGet('sessions_dict', 'col', tuple({param:String}))`. Anything else throws — we want to *fail loudly* on unmocked SQL, not silently return empty.
- For `FINAL`, the mock does the per-key max-by-version reduction (mirroring `ReplacingMergeTree`) and filters `_deleted=0`.

Commit: `feat(ch): scaffold ClickHouse types + in-memory mock client`.

### Phase B — DDL builders, cluster-aware (no migrate() yet)

**Files:** `src/adapters/clickhouse/ddl.ts`.

Function `ddlStatements({ database, cluster, tableNames }) → string[]` returns the 9 CREATE TABLE statements + 1 CREATE DICTIONARY statement. When `cluster` is set:
- Every `CREATE TABLE` becomes `CREATE TABLE IF NOT EXISTS … ON CLUSTER '<cluster>'`.
- Every engine `ReplacingMergeTree(updated_at)` wraps to `ReplicatedReplacingMergeTree('/clickhouse/tables/{installation}/{cluster}/{shard}/<table>', '{replica}', updated_at)` (CH macros — string interpolation of cluster name only after a strict `[a-zA-Z_][a-zA-Z0-9_]*` check; macros stay as literals).
- `MergeTree` (approval_decisions) wraps to `ReplicatedMergeTree('/clickhouse/tables/.../approval_decisions', '{replica}')`.

Pure-functional, no side effects. Unit test: snapshot the produced DDL with and without cluster.

Commit: `feat(ch): add cluster-aware DDL builders`.

### Phase C — `migrate()`

**Files:** `src/adapters/clickhouse/migrate.ts`.

`migrate(client, opts) → void`. Iterates `ddlStatements()` and calls `client.command(...)` for each. Idempotent (relies on `IF NOT EXISTS`). Logs `auth.ch.migrate.run` with `elapsedMs` per statement and a final `auth.ch.migrate.done`.

Test: against the mock client, call `migrate(); migrate()` — second call is a no-op (mock tracks `IF NOT EXISTS`).

Commit: `feat(ch): add migrate() with idempotent DDL`.

### Phase D — `DatabaseAdapter` translation layer

**Files:** `src/adapters/clickhouse/adapter-core.ts`, `src/adapters/clickhouse/sql-translator.ts`.

The framework's existing queries (in `src/db/queries.ts`) emit SQL with `?` placeholders against tables `users`/`accounts`/`sessions`. We need to:

1. Translate `?` placeholders to CH named params (`{p0:String}, {p1:String}, …`) with type inference from the bound JS values (string→String, number→Int64, Date→DateTime64(3,'UTC'), null→Nullable(...)).
2. Rewrite framework table names through the configured `tableNames` map.
3. For `INSERT … VALUES (?, ?, ?)` — parse columns + values, route to `client.insert({ table, values })` (CH's bulk insert API), not `command`.
4. For `SELECT` / `UPDATE` / `DELETE` — route to `client.query` / `client.command`. **For SELECTs from any of our `ReplacingMergeTree` tables, automatically inject `FINAL` after the table reference.** This is the key OLAP-as-OLTP guarantee — the framework's existing queries don't know about FINAL but the adapter can transparently add it.
5. UPDATE → emit a fresh row with `_deleted=0` and bumped `updated_at`. ReplacingMergeTree wins-by-version handles it.
6. DELETE → emit a row with `_deleted=1` and bumped `updated_at` ("tombstone"). Future FINAL queries filter it out.

The rewrite is mechanical SQL string editing. Document each transformation in code with a one-line comment.

Tests: spec test #1 — round-trip auth using `createReactAuth({ database: createClickhouseAdapter({ client: mockCh }) })`. Verifies the framework's existing user/session queries land on the right CH operations.

Commit: `feat(ch): translate DatabaseAdapter to ClickHouse named-params + auto-FINAL`.

### Phase E — Email uniqueness + cascade delete

**Files:** `src/adapters/clickhouse/queries/users.ts`, `src/adapters/clickhouse/cascade.ts`.

Email uniqueness check: framework queries via `getUserByEmail` already use a `SELECT … WHERE email = ?` shape. Our adapter rewrites that to `SELECT … FROM users FINAL WHERE email = {p0:String} AND _deleted = 0 LIMIT 1`. The "two parallel inserts" race is a residual — document it explicitly in the README.

Cascade delete: when the framework calls `deleteUser(userId)`, the adapter emits tombstone rows for that user across `users`, `accounts`, `sessions`, and `user_role_grants`. Sequential commands; document the race window between any two of them. Surface a structured log `auth.ch.cascade.delete` with per-table counts.

Tests: spec tests #2, #3.

Commit: `feat(ch): cascade-delete + email-unique semantics on top of CH FINAL`.

### Phase F — Org / Department / Supervisor types + queries

**Files:** `src/adapters/clickhouse/types.ts` (extend), `src/adapters/clickhouse/queries/rbac.ts`, `src/adapters/clickhouse/cycle-detect.ts`.

Types added: `Organization`, `Department`, `EffectiveRole`, `PermissionDecision`, `ApprovalRequest`, `ApprovalStatus`.

Cycle-safe traversal: a generic helper `traverseGraph(rootId, fetchParent, { maxDepth })` that uses a `Set<string>` of visited ids and throws `Error('cycle in <kind> at id <X>')` when it sees an id twice. Used by:
- `getSupervisorChain(userId)` — walks `users.supervisor_user_id`.
- `listDescendantOrganizations(parentId)` — BFS across `organizations.parent_org_id`.
- Department descendants — BFS across `departments.parent_dept_id`.

Tests: spec tests #4 (org/dept tree topology), #5 (cycle detection raises a clear error).

Commit: `feat(ch-rbac): org + department + supervisor graph queries with cycle detection`.

### Phase G — Roles + grants + `resolvePermission`

**Files:** `src/adapters/clickhouse/rbac.ts`.

`RbacApi` factory wires the CH client to:
- `defineRole`, `grantUserRole`, `revokeUserRole` — write through.
- `listEffectiveRoles(userId, { orgId, deptId, includeInherited })` — collect direct grants, walk org tree if `includeInherited`, fold into `EffectiveRole[]` with `via` set to the source.
- **`resolvePermission(args)`** — the hot path. Implementation order spec'd:
  1. `superadmin` — user has system-scope role with `permissions: ['*']` → allow.
  2. *Explicit deny* — any grant whose role JSON has `deny: ['<perm>']` matching → deny with reason.
  3. Direct role on the resource org/dept that grants the permission → allow `via: 'role'`.
  4. Role inherited up the org tree → allow `via: 'inherited'`.
  5. Role on user's home org → allow `via: 'home_org'`.
  6. Supervisor-chain delegation: walk up `supervisor_user_id`; if any supervisor has the permission, allow `via: 'supervisor'`.
  7. Default deny.

`PermissionDecision` returned with `via`, `rolesUsed: string[]`, and on deny a `reason: string`.

Logs: `auth.ch.rbac.permission.allow` / `.deny` with `userId`, `permission`, `via`, `rolesUsed`, `elapsedMs`.

Tests: spec test #6 — one assertion per `via` outcome (role / inherited / supervisor / home_org / superadmin / deny).

Commit: `feat(ch-rbac): roles + grants + resolvePermission with via tracking`.

### Phase H — Approval flow

**Files:** `src/adapters/clickhouse/approvals.ts`, `src/adapters/clickhouse/queries/approvals.ts`.

`ApprovalsApi`:

`open(args)`:
- Compute `chain` based on `chainStrategy`:
  - `supervisor_chain` → `getSupervisorChain(requesterUserId, { maxDepth: chainMaxDepth ?? 5 })`.
  - `role_holders` → query users with `requiredRoleId` granted in the resource's org/dept (limit + ORDER BY `created_at` to make the result deterministic).
  - `explicit` → use the provided `chain` verbatim. Validate: non-empty, no duplicates, no cycles (walking each id's supervisor chain — a self-cycle is an error).
- Insert `approval_requests` row with `chain` frozen, `current_step=0`, `status='pending'`. UUID v4 for `id`.
- Log `auth.ch.approval.open`.

`decide(args)`:
- Idempotent on `(requestId, approverUserId)`. Re-call returns the existing decision row's resulting state without re-writing.
- Read `approval_requests FINAL` for `id`. If status not `pending` → return current state with no write.
- If `chain[current_step] !== approverUserId` → throw `Error('not current approver')`. (Document: an out-of-order approval is treated as an error, not a deny.)
- Branch by `decision`:
  - `approved` → append `approval_decisions` row. If `current_step+1 >= chain.length`, write a new `approval_requests` row with `status='approved'`. Else bump `current_step`.
  - `rejected` → append decision row. Write new `approval_requests` row with `status='rejected'`. Terminal.
  - `delegated` → require `delegateTo`. Append decision row. Write new request row with `chain.toSpliced(current_step, 0, delegateTo)` (delegate slots in *at* current step), `current_step` unchanged. Status stays `pending`. (Spec #8: next `decide(approved)` from the delegate then advances.)

`expireDuePending(now)`:
- `SELECT id FROM approval_requests FINAL WHERE status='pending' AND expires_at < now AND _deleted=0`.
- For each, write a tombstone-style row (same id, `status='expired'`, bumped `updated_at`).
- Idempotent: a re-run finds the rows already `expired`, skips.

`get(id)`, `listForApprover(userId, { status })`, `listForRequester(userId, { status })` — straightforward FINAL reads.

Tests: spec tests #7-10.

Commit: `feat(ch-approvals): open/decide/list/expire with frozen chains and delegation`.

### Phase I — `sessions_dict` hot path

**Files:** `src/adapters/clickhouse/adapter-core.ts` (extend session lookup).

When `sessionManager.findValid(token)` runs, the adapter first tries `dictGet('sessions_dict', 'user_id', tuple({tokenHash:String}))`. If hit and not expired, return. Else fall back to `SELECT … FROM sessions FINAL WHERE token_hash = ?`. Both paths log: `.lookup_hit` (dict), `.lookup_miss` (dict miss; fallback hit), or `.expired`.

Tests: spec test #11 — assert dictGet path is used and stays in sync (mock implements LIFETIME refresh by re-running the source query).

Commit: `feat(ch): session lookup via sessions_dict hot path with FINAL fallback`.

### Phase J — Cluster mode wiring + cluster test

**Files:** verify Phase B already produces `ON CLUSTER`; add wiring through `createClickhouseAdapter({ cluster })` so `migrate()` produces clustered DDL.

Tests: spec test #12 — assert `migrate()` issues `ON CLUSTER 'foo'` DDL when cluster is set, and engines are `Replicated*`.

Commit: `feat(ch): wire cluster option through createClickhouseAdapter to migrate()`.

### Phase K — `package.json` exports + `src/index.ts` re-export

Add `./adapters/clickhouse` to `package.json` `exports` (matching existing adapter pattern). Add a `peerDependenciesMeta` entry for `@clickhouse/client` (optional). The package itself stays zero-runtime-dep; consumers that don't use the CH adapter pay nothing.

Update `src/index.ts` re-exports for the new types (`Organization`, `Department`, `EffectiveRole`, `PermissionDecision`, `ApprovalRequest`, `ApprovalStatus`).

Commit: `chore(exports): wire clickhouse adapter into package exports`.

### Phase L — README + example

**Files:** `README.md`, `examples/clickhouse/README.md`, `examples/clickhouse/docker-compose.yml`, `examples/clickhouse/server.ts`.

README adds a section "ClickHouse adapter (experimental)". Documents:
- The OLTP-on-OLAP trade-off (FINAL cost, dictionary freshness window of ≤15s).
- Email-uniqueness residual race.
- Cascade-delete inter-table window.
- That existing `RbacConfig`-style RBAC continues to work; the graph RBAC is *additive*.
- Approval flow as a pure data + state machine API; no transport baked in.

`examples/clickhouse/`: `docker-compose.yml` for CH 26.x, `server.ts` showing `createReactAuth({ database: createClickhouseAdapter({ client }) })`, the same adapter providing `.rbac` and `.approvals`.

Commit: `docs: ClickHouse adapter section + example`.

### Phase M — Version bump + final test run + merge

`package.json`: `0.3.0 → 0.4.0` (minor — purely additive). Full `bun test` + `bun run build`. Merge to main, tag `v0.4.0`, push.

Commit: `chore: bump version to 0.4.0`.

---

## Honest scope notes

- **Mock-driven tests are real but limited.** They prove our query strings are well-formed and our state machine logic is correct. They do *not* prove ClickHouse 24.x/25.x/26.x semantics match (e.g., `tuple()` syntax in `dictGet`, named-param type inference, `ON CLUSTER` macro expansion). The `examples/clickhouse/` docker-compose lets you / CI validate against a real CH instance before publish.
- **The 12 spec tests are scoped to the mock.** Each test name calls out which behavior it's validating. Failures against real CH should be reported in a follow-up patch.
- **Backward compatibility verified by:** running the existing 309 tests after every phase. None should break, since we only add files.
- **Peer dep policy:** `@clickhouse/client` is a peer dep with `"optional": true`. Consumers not using the CH adapter never see it.

---

## Self-review

- Spec coverage: all three deliverables (adapter, RBAC, approvals) plus all 12 test scenarios are mapped to phases.
- No placeholders.
- Type names consistent across phases (`PermissionDecision`, `ApprovalStatus`, `EffectiveRole`).
- Backward-compat: no edits to `src/types.ts` `AuthConfig`, no edits to existing adapters, no edits to `src/core/rbac.ts`, no edits to `createReactAuth`.
- File-structure sanity: each file < 400 lines target, splits along query / engine / state-machine boundaries.
