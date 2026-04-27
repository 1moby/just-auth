/**
 * Minimal example: createReactAuth on a ClickHouse-backed adapter.
 * Run a local CH first via examples/clickhouse/docker-compose.yml.
 */
import { createClient } from "@clickhouse/client";
import { createClickhouseAdapter } from "../../src/adapters/clickhouse/index.ts";
import { createReactAuth, createGoogleProvider } from "../../src/index.ts";

const ch = createClient({
  url: process.env.CH_URL ?? "http://localhost:8123",
  username: process.env.CH_USER ?? "default",
  password: process.env.CH_PASSWORD ?? "",
  database: process.env.CH_DATABASE ?? "just_auth",
});

const adapter = createClickhouseAdapter({
  client: ch,
  // cluster: "ch_main", // uncomment for replicated mode
  logger: {
    info: (event, fields) => console.log(JSON.stringify({ event, ...fields })),
    warn: (event, fields) => console.warn(JSON.stringify({ event, ...fields })),
    error: (event, fields) => console.error(JSON.stringify({ event, ...fields })),
  },
});

await adapter.migrate();
console.log("CH migrated.");

const auth = createReactAuth({
  database: adapter,
  providers: [
    createGoogleProvider({
      clientId: process.env.AUTH_GOOGLE_ID!,
      clientSecret: process.env.AUTH_GOOGLE_SECRET!,
      redirectURI: "http://localhost:3000/api/auth/callback/google",
    }),
  ],
  oauthAutoCreateAccount: true,
  allowEmailAccountLinking: true,
});

// ── Example: bootstrap an org + role ─────────────────────────────────
await adapter.rbac.createOrganization({ id: "acme", name: "Acme Inc." });
await adapter.rbac.defineRole({
  id: "editor",
  scope: "org",
  permissions: ["dashboard.edit", "dashboard.read"],
});

// Serve auth routes
Bun.serve({
  port: 3000,
  fetch(req) {
    return auth.handleRequest(req).then((res) => res ?? new Response("not found", { status: 404 }));
  },
});
console.log("Listening on http://localhost:3000");
