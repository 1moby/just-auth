import type {
  AuthConfig,
  OAuthProvider,
  SessionManager,
} from "../types.ts";
import { generateState } from "../core/oauth.ts";
import {
  type CookieConfig,
  serializeSessionCookie,
  clearSessionCookie,
  parseSessionCookie,
  serializeStateCookie,
  parseCookieValue,
} from "../core/cookie.ts";
import { hashPassword, verifyPassword } from "../core/password.ts";
import { resolvePermissions } from "../core/rbac.ts";
import type { RbacConfig } from "../types.ts";
import type { Queries } from "../db/queries.ts";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_PASSWORD_LENGTH = 128; // prevent PBKDF2 DoS with very long passwords

function generateId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Validate redirect URL is same-origin or relative path (prevents open redirect) */
function isSafeRedirect(url: string, request: Request): boolean {
  if (url.startsWith("/") && !url.startsWith("//")) return true;
  try {
    const parsed = new URL(url);
    const origin = new URL(request.url).origin;
    return parsed.origin === origin;
  } catch {
    return false;
  }
}

export interface HandlersConfig {
  providers: Map<string, OAuthProvider>;
  sessionManager: SessionManager;
  cookieConfig: CookieConfig;
  queries: Queries;
  basePath: string;
  sessionMaxAge: number;
  credentials?: boolean;
  allowRegistration?: boolean;
  oauthAutoCreateAccount?: boolean;
  allowDangerousEmailAccountLinking?: boolean;
  rbac?: RbacConfig;
  passwordMinLength?: number;
  allowedEmails?: string[] | ((email: string) => boolean);
  onAuthSuccess?: (user: { id: string }, request: Request) => string | undefined;
}

function isEmailAllowed(email: string | null, rule?: string[] | ((email: string) => boolean)): boolean {
  if (!rule) return true;
  if (!email) return false;
  if (typeof rule === "function") return rule(email);
  return rule.some((pattern) =>
    pattern.startsWith("@") ? email.endsWith(pattern) : email === pattern
  );
}

export function createHandlers(config: HandlersConfig) {
  const {
    providers,
    sessionManager,
    cookieConfig,
    queries,
    basePath,
    sessionMaxAge,
    onAuthSuccess,
  } = config;

  async function handleRequest(request: Request): Promise<Response | null> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (!path.startsWith(basePath)) return null;

    const subPath = path.slice(basePath.length);

    // GET /api/auth/session
    if (subPath === "/session" && request.method === "GET") {
      return handleSession(request);
    }

    // GET /api/auth/logout
    if (subPath === "/logout") {
      return handleLogout(request);
    }

    // POST /api/auth/register (disabled when allowRegistration is false)
    if (subPath === "/register" && request.method === "POST" && config.credentials && config.allowRegistration !== false) {
      return handleRegister(request);
    }

    // POST /api/auth/callback/credentials
    if (subPath === "/callback/credentials" && request.method === "POST" && config.credentials) {
      return handleCredentialsLogin(request);
    }

    // POST /api/auth/role (requires rbac + user:set-role permission)
    if (subPath === "/role" && request.method === "POST" && config.rbac) {
      return handleSetRole(request);
    }

    // GET /api/auth/login/:provider
    const loginMatch = subPath.match(/^\/login\/([^/]+)$/);
    if (loginMatch && request.method === "GET") {
      return handleLogin(request, loginMatch[1]!);
    }

    // GET /api/auth/callback/:provider
    const callbackMatch = subPath.match(/^\/callback\/([^/]+)$/);
    if (callbackMatch && request.method === "GET") {
      return handleCallback(request, callbackMatch[1]!);
    }

    return null;
  }

  async function handleLogin(
    request: Request,
    providerId: string
  ): Promise<Response> {
    const provider = providers.get(providerId);
    if (!provider) {
      return new Response(JSON.stringify({ error: "Unknown provider" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    const state = generateState();
    const url = await provider.createAuthorizationURL(state);

    const headers = new Headers();
    headers.set("Location", url.toString());
    headers.append(
      "Set-Cookie",
      serializeStateCookie("oauth_state", state, cookieConfig)
    );

    // For Google PKCE, store the code verifier
    if ("codeVerifier" in provider && typeof provider.codeVerifier === "string") {
      headers.append(
        "Set-Cookie",
        serializeStateCookie("code_verifier", provider.codeVerifier, cookieConfig)
      );
    }

    return new Response(null, { status: 302, headers });
  }

  async function handleCallback(
    request: Request,
    providerId: string
  ): Promise<Response> {
    const provider = providers.get(providerId);
    if (!provider) {
      return new Response(JSON.stringify({ error: "Unknown provider" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    const url = new URL(request.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const cookieHeader = request.headers.get("cookie");
    const storedState = parseCookieValue(cookieHeader, "oauth_state");

    if (!code || !state || !storedState || state !== storedState) {
      return new Response(JSON.stringify({ error: "Invalid OAuth state" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Restore code verifier for PKCE providers
    if ("codeVerifier" in provider) {
      const storedVerifier = parseCookieValue(cookieHeader, "code_verifier");
      if (storedVerifier) {
        (provider as { codeVerifier: string }).codeVerifier = storedVerifier;
      }
    }

    try {
      const tokens = await provider.validateAuthorizationCode(code);
      const profile = await provider.getUserProfile(tokens.accessToken);

      // Email restriction check — reject before any account/session creation
      if (!isEmailAllowed(profile.email, config.allowedEmails)) {
        return new Response(
          JSON.stringify({ error: "EmailNotAllowed", message: "This email domain is not permitted" }),
          { status: 403, headers: { "Content-Type": "application/json" } }
        );
      }

      // Upsert user + account
      let user = await queries.getUserByAccount(providerId, profile.id);

      if (!user) {
        if (profile.email) {
          const existingUser = await queries.getUserByEmail(profile.email);
          if (existingUser) {
            if (config.allowDangerousEmailAccountLinking) {
              user = existingUser;
              await queries.createAccount({
                id: generateId(),
                userId: existingUser.id,
                providerId,
                providerUserId: profile.id,
                accessToken: tokens.accessToken,
                refreshToken: tokens.refreshToken ?? null,
                expiresAt: tokens.expiresAt ?? null,
              });
            } else {
              return new Response(
                JSON.stringify({ error: "OAuthAccountNotLinked", message: "Email already associated with another account" }),
                { status: 403, headers: { "Content-Type": "application/json" } }
              );
            }
          }
        }

        if (!user) {
          // Auto-create is opt-in. By default, OAuth login requires an existing account.
          if (!config.oauthAutoCreateAccount) {
            return new Response(
              JSON.stringify({ error: "AccountNotFound", message: "No account found. Contact an administrator to create one." }),
              { status: 403, headers: { "Content-Type": "application/json" } }
            );
          }
          const userId = generateId();
          const defaultRole = config.rbac?.defaultRole;
          user = {
            id: userId,
            email: profile.email,
            name: profile.name,
            avatarUrl: profile.avatarUrl,
            role: defaultRole ?? undefined,
          };
          await queries.createUser(user);
          await queries.createAccount({
            id: generateId(),
            userId,
            providerId,
            providerUserId: profile.id,
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken ?? null,
            expiresAt: tokens.expiresAt ?? null,
          });
        }
      }

      const { token } = await sessionManager.createSession(user.id);

      const headers = new Headers();
      const rawRedirect = onAuthSuccess?.(user, request) ?? "/";
      headers.set("Location", isSafeRedirect(rawRedirect, request) ? rawRedirect : "/");
      headers.append(
        "Set-Cookie",
        serializeSessionCookie(cookieConfig, token, sessionMaxAge)
      );
      // Clear state cookies
      headers.append(
        "Set-Cookie",
        serializeStateCookie("oauth_state", "", { ...cookieConfig })
          .replace("Max-Age=600", "Max-Age=0")
      );

      return new Response(null, { status: 302, headers });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "OAuth callback failed";
      return new Response(JSON.stringify({ error: message }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  async function handleSession(request: Request): Promise<Response> {
    const cookieHeader = request.headers.get("cookie");
    const token = parseSessionCookie(cookieConfig, cookieHeader);

    if (!token) {
      return new Response(JSON.stringify(null), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    const result = await sessionManager.validateSession(token);

    if (!result) {
      const headers = new Headers();
      headers.set("Content-Type", "application/json");
      headers.append("Set-Cookie", clearSessionCookie(cookieConfig));
      return new Response(JSON.stringify(null), { status: 200, headers });
    }

    const accounts = await queries.getAccountsByUserId(result.user.id);
    const accountList = accounts.map((a) => ({ providerId: a.providerId }));

    const responseData: Record<string, unknown> = {
      user: result.user,
      session: { expiresAt: result.session.expiresAt },
      accounts: accountList,
    };

    if (config.rbac && result.user.role) {
      responseData.permissions = resolvePermissions(result.user.role, config.rbac);
    }

    return new Response(JSON.stringify(responseData), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  async function handleLogout(request: Request): Promise<Response> {
    const cookieHeader = request.headers.get("cookie");
    const token = parseSessionCookie(cookieConfig, cookieHeader);

    if (token) {
      const result = await sessionManager.validateSession(token);
      if (result) {
        await sessionManager.invalidateSession(result.session.id);
      }
    }

    const headers = new Headers();
    headers.set("Location", "/");
    headers.append("Set-Cookie", clearSessionCookie(cookieConfig));

    return new Response(null, { status: 302, headers });
  }

  async function handleRegister(request: Request): Promise<Response> {
    try {
      const body = await request.json() as { email?: string; password?: string; name?: string };
      const { email, password, name } = body;

      if (!email || !password) {
        return new Response(
          JSON.stringify({ error: "Email and password are required" }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }

      if (!EMAIL_RE.test(email)) {
        return new Response(
          JSON.stringify({ error: "Invalid email format" }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }

      if (!isEmailAllowed(email, config.allowedEmails)) {
        return new Response(
          JSON.stringify({ error: "EmailNotAllowed", message: "This email domain is not permitted" }),
          { status: 403, headers: { "Content-Type": "application/json" } }
        );
      }

      const minLen = config.passwordMinLength ?? 8;
      if (password.length < minLen) {
        return new Response(
          JSON.stringify({ error: `Password must be at least ${minLen} characters` }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }

      if (password.length > MAX_PASSWORD_LENGTH) {
        return new Response(
          JSON.stringify({ error: `Password must not exceed ${MAX_PASSWORD_LENGTH} characters` }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }

      const existingUser = await queries.getUserByEmail(email);
      if (existingUser) {
        // Generic error to prevent email enumeration
        return new Response(
          JSON.stringify({ error: "Registration failed" }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }

      const passwordHash = await hashPassword(password);
      const userId = generateId();
      const defaultRole = config.rbac?.defaultRole;
      const user = { id: userId, email, name: name ?? null, avatarUrl: null, role: defaultRole ?? undefined };

      await queries.createUserWithPassword({ ...user, passwordHash });
      await queries.createAccount({
        id: generateId(),
        userId,
        providerId: "credentials",
        providerUserId: email,
        accessToken: null,
        refreshToken: null,
        expiresAt: null,
      });

      const { token } = await sessionManager.createSession(userId);

      const headers = new Headers();
      headers.set("Content-Type", "application/json");
      headers.append(
        "Set-Cookie",
        serializeSessionCookie(cookieConfig, token, sessionMaxAge)
      );

      return new Response(
        JSON.stringify({ user: { id: userId, email, name: name ?? null, avatarUrl: null } }),
        { status: 200, headers }
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Registration failed";
      return new Response(
        JSON.stringify({ error: message }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }
  }

  async function handleCredentialsLogin(request: Request): Promise<Response> {
    try {
      const body = await request.json() as { email?: string; password?: string };
      const { email, password } = body;

      if (!email || !password) {
        return new Response(
          JSON.stringify({ error: "Email and password are required" }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }

      const user = await queries.getUserByEmailWithPassword(email);
      if (!user || !user.passwordHash) {
        return new Response(
          JSON.stringify({ error: "Invalid email or password" }),
          { status: 401, headers: { "Content-Type": "application/json" } }
        );
      }

      const valid = await verifyPassword(password, user.passwordHash);
      if (!valid) {
        return new Response(
          JSON.stringify({ error: "Invalid email or password" }),
          { status: 401, headers: { "Content-Type": "application/json" } }
        );
      }

      const { token } = await sessionManager.createSession(user.id);

      const headers = new Headers();
      headers.set("Content-Type", "application/json");
      headers.append(
        "Set-Cookie",
        serializeSessionCookie(cookieConfig, token, sessionMaxAge)
      );

      return new Response(
        JSON.stringify({ user: { id: user.id, email: user.email, name: user.name, avatarUrl: user.avatarUrl } }),
        { status: 200, headers }
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Login failed";
      return new Response(
        JSON.stringify({ error: message }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }
  }

  async function handleSetRole(request: Request): Promise<Response> {
    const cookieHeader = request.headers.get("cookie");
    const token = parseSessionCookie(cookieConfig, cookieHeader);
    if (!token) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { "Content-Type": "application/json" },
      });
    }

    const session = await sessionManager.validateSession(token);
    if (!session) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { "Content-Type": "application/json" },
      });
    }

    const callerPerms = resolvePermissions(session.user.role ?? "user", config.rbac!);
    if (!callerPerms.includes("user:set-role")) {
      return new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403, headers: { "Content-Type": "application/json" },
      });
    }

    try {
      const body = await request.json() as { userId?: string; role?: string };
      if (!body.userId || !body.role) {
        return new Response(
          JSON.stringify({ error: "userId and role are required" }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }

      if (!config.rbac!.roles[body.role]) {
        return new Response(
          JSON.stringify({ error: `Invalid role: ${body.role}` }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }

      await queries.updateUserRole(body.userId, body.role);

      return new Response(
        JSON.stringify({ user: { id: body.userId, role: body.role } }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to set role";
      return new Response(
        JSON.stringify({ error: message }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }
  }

  return { handleRequest };
}
