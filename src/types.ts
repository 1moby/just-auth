export interface User {
  id: string;
  email: string | null;
  name: string | null;
  avatarUrl: string | null;
  role?: string;
}

export interface Session {
  id: string;
  userId: string;
  expiresAt: Date;
}

export interface Account {
  id: string;
  userId: string;
  providerId: string;
  providerUserId: string;
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: number | null;
}

export interface SessionValidationResult {
  session: Session;
  user: User;
}

export interface OAuthProvider {
  id: string;
  createAuthorizationURL(state: string): URL | Promise<URL>;
  validateAuthorizationCode(code: string): Promise<OAuthTokens>;
  getUserProfile(accessToken: string): Promise<OAuthUserProfile>;
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}

export interface OAuthUserProfile {
  id: string;
  email: string | null;
  name: string | null;
  avatarUrl: string | null;
}

export interface DatabaseAdapter {
  prepare(sql: string): PreparedStatement;
  batch<T>(statements: (PreparedStatement | BoundStatement)[]): Promise<T[]>;
}

export interface PreparedStatement {
  bind(...params: unknown[]): BoundStatement;
}

export interface BoundStatement {
  run(): Promise<{ success: boolean }>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
}

export interface CookieOptions {
  name?: string;
  secure?: boolean;
  sameSite?: "lax" | "strict" | "none";
  domain?: string;
  path?: string;
}

export interface SessionOptions {
  maxAge?: number; // seconds, default 30 days
  refreshThreshold?: number; // seconds, default 15 days
}

export interface RoleDefinition {
  allow: Record<string, string[]>;
  deny?: Record<string, string[]>;
  inherits?: string[];
}

export interface RbacConfig {
  statements: Record<string, readonly string[]>;
  /** Role definitions. Use Record<string, string[]> (legacy), RoleDefinition, or "*" (all permissions). */
  roles: Record<string, Record<string, string[]> | RoleDefinition | "*">;
  defaultRole?: string;
}

export interface AuthConfig {
  providers: OAuthProvider[];
  database: DatabaseAdapter;
  basePath?: string; // default "/api/auth"
  cookie?: CookieOptions;
  session?: SessionOptions;
  secret?: string; // for signing state cookies
  credentials?: boolean;
  /** Allow self-registration via POST /register. Default: true (when credentials is true) */
  allowRegistration?: boolean;
  /** Allow OAuth login to auto-create user accounts. Default: false — users must exist first */
  oauthAutoCreateAccount?: boolean;
  allowDangerousEmailAccountLinking?: boolean;
  rbac?: RbacConfig;
  /** Prefix for database table names, e.g. "myapp_" → myapp_users, myapp_accounts, myapp_sessions */
  tablePrefix?: string;
  /** Minimum password length for credential registration. Default: 8 */
  passwordMinLength?: number;
  /** Restrict allowed emails. Array of domain strings (e.g. ["@1moby.com"]) or a function returning boolean. */
  allowedEmails?: string[] | ((email: string) => boolean);
}

export interface AuthInstance {
  auth(request: Request): Promise<SessionValidationResult | null>;
  handleRequest(request: Request): Promise<Response | null>;
  providers: Map<string, OAuthProvider>;
  sessionManager: SessionManager;
  hasPermission(request: Request, permission: string): Promise<boolean>;
  hasRole(request: Request, role: string): Promise<boolean>;
  getRoles(request: Request): Promise<string[]>;
}

export interface SessionManager {
  generateToken(): string;
  createSession(userId: string): Promise<{ session: Session; token: string }>;
  validateSession(token: string): Promise<SessionValidationResult | null>;
  invalidateSession(sessionId: string): Promise<void>;
}

export type SessionStatus = "loading" | "authenticated" | "unauthenticated";

export interface SessionContextValue {
  data: (SessionValidationResult & { accounts?: { providerId: string }[]; permissions?: string[] }) | null;
  status: SessionStatus;
  update(): Promise<void>;
}
