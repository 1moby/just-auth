# ClickHouse adapter example

Validate the `@1moby/just-auth/adapters/clickhouse` adapter against a real ClickHouse instance.

## Run

```bash
docker compose -f examples/clickhouse/docker-compose.yml up -d
bun add @clickhouse/client
AUTH_GOOGLE_ID=... AUTH_GOOGLE_SECRET=... bun examples/clickhouse/server.ts
```

The server listens on `:3000`. Hit `/api/auth/login/google` to start the OAuth flow.

## What this validates

The unit tests in `tests/adapters/clickhouse/` use an in-memory mock that simulates `ReplacingMergeTree FINAL` and dictionary semantics. This example is the integration check against a real ClickHouse 26.x server. Run it before publishing if you've touched anything that produces SQL or DDL.

## CI

Add the docker-compose service to your CI matrix and run `bun test` against the live CH. The mock-only tests still run without it.
