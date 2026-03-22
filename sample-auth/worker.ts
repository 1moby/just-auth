import { createReactAuth, createGoogleProvider, createLineProvider, migrate } from "../src/index.ts";
import type { DatabaseAdapter, PreparedStatement, BoundStatement } from "../src/types.ts";

interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  AUTH_GOOGLE_ID: string;
  AUTH_GOOGLE_SECRET: string;
  LINE_CLIENT_ID: string;
  LINE_CLIENT_SECRET: string;
  BASE_URL: string;
}

function createD1Adapter(db: D1Database): DatabaseAdapter {
  return {
    prepare(sql: string): PreparedStatement {
      return {
        bind(...params: unknown[]): BoundStatement {
          const stmt = db.prepare(sql).bind(...params);
          return {
            async run() {
              await stmt.run();
              return { success: true };
            },
            async first<T = Record<string, unknown>>(): Promise<T | null> {
              return await stmt.first<T>();
            },
            async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
              const result = await stmt.all<T>();
              return { results: result.results };
            },
          };
        },
      };
    },
    async batch(statements: BoundStatement[]): Promise<unknown[]> {
      const results: unknown[] = [];
      for (const stmt of statements) {
        results.push(await stmt.run());
      }
      return results;
    },
  };
}

let migrated = false;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const db = createD1Adapter(env.DB);
    const baseUrl = env.BASE_URL || "https://sample-auth.anu-1moby.workers.dev";

    if (!migrated) {
      await migrate(db);
      migrated = true;
    }

    const auth = createReactAuth({
      providers: [
        createGoogleProvider({
          clientId: env.AUTH_GOOGLE_ID || "",
          clientSecret: env.AUTH_GOOGLE_SECRET || "",
          redirectURI: `${baseUrl}/api/auth/callback/google`,
        }),
        createLineProvider({
          clientId: env.LINE_CLIENT_ID || "",
          clientSecret: env.LINE_CLIENT_SECRET || "",
          redirectURI: `${baseUrl}/api/auth/callback/line`,
        }),
      ],
      database: db,
      cookie: {
        secure: true,
      },
      credentials: true,
      allowDangerousEmailAccountLinking: true,
      oauthAutoCreateAccount: true,
      rbac: {
        statements: {
          post: ["create", "read", "update", "delete"],
          user: ["list", "ban", "set-role"],
        },
        roles: {
          user: {
            post: ["read"],
          },
          admin: "*",
        },
        defaultRole: "user",
      },
    });

    // Try auth routes first
    const authResponse = await auth.handleRequest(request);
    if (authResponse) return authResponse;

    // Protected API routes
    const url = new URL(request.url);

    if (url.pathname === "/api/me") {
      const session = await auth.auth(request);
      if (!session) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
      const canManageUsers = await auth.hasPermission(request, "user:set-role");
      return Response.json({
        user: session.user,
        session: {
          id: session.session.id,
          expiresAt: session.session.expiresAt,
        },
        canManageUsers,
      });
    }

    // Let Cloudflare Assets handle static files (SPA mode)
    return env.ASSETS.fetch(request);
  },
};
