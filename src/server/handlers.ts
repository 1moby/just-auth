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
import { resolvePermissions, parseRoles } from "../core/rbac.ts";
import type { RbacConfig } from "../types.ts";
import type { Queries } from "../db/queries.ts";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_PASSWORD_LENGTH = 128; // prevent PBKDF2 DoS with very long passwords

function generateId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Build a Response with multiple Set-Cookie headers using header tuples.
 * This avoids the comma-merging issue some frameworks have with Headers.append().
 */
function responseWithCookies(
  body: BodyInit | null,
  init: { status: number; cookies: string[]; extraHeaders?: Record<string, string> }
): Response {
  const tuples: [string, string][] = [];
  if (init.extraHeaders) {
    for (const [k, v] of Object.entries(init.extraHeaders)) {
      tuples.push([k, v]);
    }
  }
  for (const cookie of init.cookies) {
    tuples.push(["Set-Cookie", cookie]);
  }
  return new Response(body, { status: init.status, headers: tuples });
}

/**
 * Resolve a redirect URL to an absolute URL using proxy headers.
 * Handles X-Forwarded-Proto/Host for deployments behind reverse proxies.
 */
function resolveAbsoluteUrl(redirect: string, request: Request): string {
  if (redirect.startsWith("http")) return redirect;
  const proto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || "https";
  const host = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim()
    || request.headers.get("host") || "localhost";
  const base = `${proto === "http" && host.includes(".") ? "https" : proto}://${host}`;
  return `${base}${redirect}`;
}

/**
 * Return a 200 HTML page that sets cookies and redirects via meta refresh + JS.
 * This avoids the issue where reverse proxies (nginx, k8s, ALB) intercept 302
 * responses and follow them internally, causing Set-Cookie headers to be lost.
 * Same pattern as Auth.js/NextAuth.
 */
function htmlRedirectWithCookies(
  redirect: string,
  request: Request,
  cookies: string[]
): Response {
  const absoluteUrl = resolveAbsoluteUrl(redirect, request);
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${absoluteUrl}"><title>Redirecting...</title></head><body><script>window.location.href=${JSON.stringify(absoluteUrl)}</script><noscript><a href="${absoluteUrl}">Click here</a></noscript></body></html>`;
  return responseWithCookies(html, {
    status: 200,
    cookies,
    extraHeaders: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate",
    },
  });
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

    // POST /api/auth/logout
    if (subPath === "/logout" && request.method === "POST") {
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

    const cookies = [
      serializeStateCookie("oauth_state", state, cookieConfig),
    ];

    // For Google PKCE, store the code verifier
    if ("codeVerifier" in provider && typeof provider.codeVerifier === "string") {
      cookies.push(
        serializeStateCookie("code_verifier", provider.codeVerifier, cookieConfig)
      );
    }

    return htmlRedirectWithCookies(url.toString(), request, cookies);
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

      const rawRedirect = onAuthSuccess?.(user, request) ?? "/";
      const redirect = isSafeRedirect(rawRedirect, request) ? rawRedirect : "/";
      return htmlRedirectWithCookies(redirect, request, [
        serializeSessionCookie(cookieConfig, token, sessionMaxAge),
        // Clear state cookies
        serializeStateCookie("oauth_state", "", { ...cookieConfig }).replace("Max-Age=600", "Max-Age=0"),
        serializeStateCookie("code_verifier", "", { ...cookieConfig }).replace("Max-Age=600", "Max-Age=0"),
      ]);
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
      return responseWithCookies(JSON.stringify(null), {
        status: 200,
        cookies: [clearSessionCookie(cookieConfig)],
        extraHeaders: { "Content-Type": "application/json" },
      });
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

    return responseWithCookies(JSON.stringify({ ok: true }), {
      status: 200,
      cookies: [clearSessionCookie(cookieConfig)],
      extraHeaders: { "Content-Type": "application/json" },
    });
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

      return responseWithCookies(
        JSON.stringify({ user: { id: userId, email, name: name ?? null, avatarUrl: null } }),
        {
          status: 200,
          cookies: [serializeSessionCookie(cookieConfig, token, sessionMaxAge)],
          extraHeaders: { "Content-Type": "application/json" },
        }
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

      return responseWithCookies(
        JSON.stringify({ user: { id: user.id, email: user.email, name: user.name, avatarUrl: user.avatarUrl } }),
        {
          status: 200,
          cookies: [serializeSessionCookie(cookieConfig, token, sessionMaxAge)],
          extraHeaders: { "Content-Type": "application/json" },
        }
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
      const body = await request.json() as {
        userId?: string;
        role?: string;
        roles?: string[];
        addRole?: string;
        removeRole?: string;
      };
      if (!body.userId) {
        return new Response(
          JSON.stringify({ error: "userId is required" }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }

      let finalRole: string;

      if (body.addRole || body.removeRole) {
        // Incremental: add or remove a single role
        const targetRole = body.addRole ?? body.removeRole!;
        if (body.addRole && !config.rbac!.roles[targetRole]) {
          return new Response(
            JSON.stringify({ error: `Invalid role: ${targetRole}` }),
            { status: 400, headers: { "Content-Type": "application/json" } }
          );
        }
        // Get current roles from user
        const user = await queries.getUserById(body.userId);
        if (!user) {
          return new Response(
            JSON.stringify({ error: "User not found" }),
            { status: 404, headers: { "Content-Type": "application/json" } }
          );
        }
        const currentRoles = parseRoles(user.role ?? config.rbac!.defaultRole ?? "user");
        if (body.addRole) {
          if (!currentRoles.includes(body.addRole)) {
            currentRoles.push(body.addRole);
          }
        } else {
          const idx = currentRoles.indexOf(body.removeRole!);
          if (idx !== -1) currentRoles.splice(idx, 1);
        }
        finalRole = currentRoles.join(",") || config.rbac!.defaultRole || "user";
      } else {
        // Set exact roles
        const rolesToSet = body.roles ?? (body.role ? [body.role] : null);
        if (!rolesToSet || rolesToSet.length === 0) {
          return new Response(
            JSON.stringify({ error: "role, roles, addRole, or removeRole is required" }),
            { status: 400, headers: { "Content-Type": "application/json" } }
          );
        }
        // Validate all roles
        for (const r of rolesToSet) {
          if (!config.rbac!.roles[r]) {
            return new Response(
              JSON.stringify({ error: `Invalid role: ${r}` }),
              { status: 400, headers: { "Content-Type": "application/json" } }
            );
          }
        }
        finalRole = rolesToSet.join(",");
      }

      await queries.updateUserRole(body.userId, finalRole);

      return new Response(
        JSON.stringify({ user: { id: body.userId, role: finalRole } }),
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
