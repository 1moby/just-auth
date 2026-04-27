# ClickHouse adapter example

Runnable wiring of `@1moby/just-auth/adapters/clickhouse` against a real ClickHouse instance, plus the integration matrix used to verify version compatibility.

## Run the demo server

```bash
docker compose -f examples/clickhouse/docker-compose.yml up -d
bun add @clickhouse/client
CH_URL=http://localhost:8126 \
AUTH_GOOGLE_ID=... AUTH_GOOGLE_SECRET=... \
bun examples/clickhouse/server.ts
```

The server listens on `:3000`. Hit `/api/auth/login/google` to start an OAuth flow against the latest CH (port 8126). Switch `CH_URL` to `:8124` or `:8125` to target the 24.x / 25.x containers instead.

## Containers

`docker-compose.yml` runs three CH versions side-by-side so the integration runner can sweep all of them in parallel:

| Service | CH version | HTTP port | Native TCP |
| --- | --- | --- | --- |
| `ch24` | `clickhouse/clickhouse-server:24.8` | `8124` | `9024` |
| `ch25` | `clickhouse/clickhouse-server:25.3` | `8125` | `9025` |
| `ch26` | `clickhouse/clickhouse-server:25.10` | `8126` | `9026` |

(`ch26` tracks the latest stable on the 25.x branch — when 26.x ships LTS, bump the image tag.)

## Run the integration matrix

The matrix runner exercises all 13 spec scenarios against each live version and prints a per-version pass/fail summary.

```bash
docker compose -f examples/clickhouse/docker-compose.yml up -d

# all three
bun tests/integration/clickhouse/run.ts

# one version at a time
bun tests/integration/clickhouse/run.ts 24
bun tests/integration/clickhouse/run.ts 25
bun tests/integration/clickhouse/run.ts 26

docker compose -f examples/clickhouse/docker-compose.yml down -v
```

The runner creates an ephemeral database per scenario and drops it on completion, so re-runs are idempotent.

## What the unit tests cover vs. integration

`tests/adapters/clickhouse/clickhouse.test.ts` runs against an in-memory mock client that simulates `ReplacingMergeTree FINAL` semantics and `dictGet`. It catches logic errors fast (no Docker needed). The integration matrix in `tests/integration/clickhouse/run.ts` is the real-CH compatibility check — run it whenever you change DDL, SQL strings, or the date / param wire format.

## Add to your CI

```yaml
- name: ClickHouse compat
  run: |
    docker compose -f examples/clickhouse/docker-compose.yml up -d
    sleep 10  # or wait-for-healthy
    bun tests/integration/clickhouse/run.ts
    docker compose -f examples/clickhouse/docker-compose.yml down -v
```

The unit suite (`bun test`) still runs without Docker.
