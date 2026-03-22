import type { AuthConfig, AuthInstance } from "./types.ts";
import { createAuth } from "./server/auth.ts";
import { createHandlers } from "./server/handlers.ts";
import { createProviderMap } from "./providers/index.ts";
import { resolvePermissions } from "./core/rbac.ts";

export function createReactAuth(config: AuthConfig): AuthInstance {
  const basePath = config.basePath ?? "/api/auth";
  const sessionMaxAge = config.session?.maxAge ?? 30 * 86400;
  const { auth, cookieConfig, sessionManager, queries } = createAuth(config);
  const providerMap = createProviderMap(config.providers);
  const { handleRequest } = createHandlers({
    providers: providerMap,
    sessionManager,
    cookieConfig,
    queries,
    basePath,
    sessionMaxAge,
    credentials: config.credentials,
    allowRegistration: config.allowRegistration,
    oauthAutoCreateAccount: config.oauthAutoCreateAccount,
    allowDangerousEmailAccountLinking: config.allowDangerousEmailAccountLinking,
    passwordMinLength: config.passwordMinLength,
    allowedEmails: config.allowedEmails,
    rbac: config.rbac,
  });

  async function hasPermission(request: Request, permission: string): Promise<boolean> {
    if (!config.rbac) return false;
    const result = await auth(request);
    if (!result) return false;
    const role = result.user.role ?? config.rbac.defaultRole;
    if (!role) return false;
    const permissions = resolvePermissions(role, config.rbac);
    return permissions.includes(permission);
  }

  async function hasRole(request: Request, role: string): Promise<boolean> {
    const result = await auth(request);
    if (!result) return false;
    const userRole = result.user.role ?? config.rbac?.defaultRole;
    return userRole === role;
  }

  return {
    auth,
    handleRequest,
    providers: providerMap,
    sessionManager,
    hasPermission,
    hasRole,
  };
}

// Re-export everything
export type {
  AuthConfig,
  AuthInstance,
  User,
  Session,
  Account,
  SessionValidationResult,
  OAuthProvider,
  OAuthTokens,
  OAuthUserProfile,
  DatabaseAdapter,
  PreparedStatement,
  BoundStatement,
  CookieOptions,
  SessionOptions,
  SessionManager,
  SessionStatus,
  SessionContextValue,
  RbacConfig,
} from "./types.ts";

export { createGitHubProvider } from "./providers/github.ts";
export type { GitHubProviderConfig } from "./providers/github.ts";
export { createGoogleProvider } from "./providers/google.ts";
export type { GoogleProviderConfig } from "./providers/google.ts";
export { createLineProvider } from "./providers/line.ts";
export type { LineProviderConfig } from "./providers/line.ts";

export { migrate, SCHEMA_STATEMENTS, INDEX_STATEMENTS } from "./db/migrate.ts";
export type { MigrateOptions } from "./db/migrate.ts";
export { createQueries, resolveTableNames } from "./db/queries.ts";
export type { Queries, TableNames } from "./db/queries.ts";
export { hashPassword, verifyPassword } from "./core/password.ts";
export { resolvePermissions } from "./core/rbac.ts";

export {
  generateSessionToken,
  hashToken,
  createSessionManager,
} from "./core/session.ts";
export {
  resolveCookieConfig,
  serializeSessionCookie,
  clearSessionCookie,
  parseSessionCookie,
} from "./core/cookie.ts";
