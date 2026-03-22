import type { AuthConfig, SessionValidationResult, SessionManager } from "../types.ts";
import {
  resolveCookieConfig,
  parseSessionCookie,
  type CookieConfig,
} from "../core/cookie.ts";
import { createSessionManager } from "../core/session.ts";
import { createQueries, type Queries } from "../db/queries.ts";

export function createAuth(config: AuthConfig) {
  const cookieConfig = resolveCookieConfig(config.cookie);
  const queries = createQueries(config.database, config.tablePrefix);
  const sessionManager = createSessionManager(queries, config.session);

  async function auth(
    request: Request
  ): Promise<SessionValidationResult | null> {
    const cookieHeader = request.headers.get("cookie");
    const token = parseSessionCookie(cookieConfig, cookieHeader);
    if (!token) return null;
    return sessionManager.validateSession(token);
  }

  return {
    auth,
    cookieConfig,
    sessionManager,
    queries,
    config,
  };
}
