import { createReactAuth, createGoogleProvider, createLineProvider, migrate } from "../src/index.ts";
import { createSQLiteAdapter } from "./db-adapter.ts";
import index from "./index.html";

const db = createSQLiteAdapter("./auth.db");

// Run migrations on startup
await migrate(db);

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";

const auth = createReactAuth({
  providers: [
    createGoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID ?? "",
      clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
      redirectURI: `${BASE_URL}/api/auth/callback/google`,
    }),
    createLineProvider({
      clientId: process.env.LINE_CLIENT_ID ?? "",
      clientSecret: process.env.LINE_CLIENT_SECRET ?? "",
      redirectURI: `${BASE_URL}/api/auth/callback/line`,
    }),
  ],
  database: db,
  cookie: {
    secure: BASE_URL.startsWith("https"),
  },
});

Bun.serve({
  port: 3000,
  routes: {
    "/": index,
    "/login": index,
    "/dashboard": index,
  },
  async fetch(request) {
    // Try auth routes first
    const authResponse = await auth.handleRequest(request);
    if (authResponse) return authResponse;

    // Serve index.html for all other routes (SPA fallback)
    return new Response("Not found", { status: 404 });
  },
  development: {
    hmr: true,
    console: true,
  },
});

console.log("Server running at http://localhost:3000");
console.log("");
console.log("OAuth Callback URLs:");
console.log(`  Google: ${BASE_URL}/api/auth/callback/google`);
console.log(`  LINE:   ${BASE_URL}/api/auth/callback/line`);
