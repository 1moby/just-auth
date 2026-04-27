import type {
  AuthConfig,
  AuthCallbacks,
  PagesConfig,
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

// Dummy hash used to ensure constant-time response for non-existent users (timing oracle prevention)
const DUMMY_PASSWORD_HASH = "00000000000000000000000000000000:0000000000000000000000000000000000000000000000000000000000000000";

/**
 * Constant-time string comparison to prevent timing side-channels.
 * Hashes both inputs with SHA-256 first so the comparison always operates
 * on fixed-length (32-byte) values, preventing length-based timing leaks.
 */
async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const ba = new Uint8Array(ha);
  const bb = new Uint8Array(hb);
  let result = 0;
  for (let i = 0; i < ba.length; i++) {
    result |= ba[i]! ^ bb[i]!;
  }
  return result === 0;
}

/** Escape a string for safe embedding in an HTML attribute value.
 *  Includes the backtick — some legacy parsers treat it as an attribute delimiter. */
function escapeHtmlAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/`/g, "&#96;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function generateId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Per-provider cookie names. Namespacing prevents one provider's flow from
 *  reading another's state/verifier when a user has parallel login tabs open. */
const PROVIDER_ID_RE = /^[a-zA-Z0-9_-]+$/;
function stateCookieName(providerId: string): string {
  if (!PROVIDER_ID_RE.test(providerId)) {
    throw new Error(`[just-auth] invalid provider id: ${providerId}`);
  }
  return `oauth_state_${providerId}`;
}
function verifierCookieName(providerId: string): string {
  if (!PROVIDER_ID_RE.test(providerId)) {
    throw new Error(`[just-auth] invalid provider id: ${providerId}`);
  }
  return `code_verifier_${providerId}`;
}

/** Build the two Set-Cookie headers that expire this provider's state and
 *  verifier cookies. Used on every handleCallback exit path (success + error). */
function clearedStateCookies(providerId: string, cookieConfig: CookieConfig): string[] {
  return [
    serializeStateCookie(stateCookieName(providerId), "", cookieConfig).replace(
      "Max-Age=600",
      "Max-Age=0"
    ),
    serializeStateCookie(verifierCookieName(providerId), "", cookieConfig).replace(
      "Max-Age=600",
      "Max-Age=0"
    ),
  ];
}

/** Build a JSON error response that ALSO clears the provider's state cookies.
 *  Use this on every handleCallback error path so leaked state can't be replayed. */
function jsonErrorWithStateClear(
  body: unknown,
  status: number,
  providerId: string,
  cookieConfig: CookieConfig
): Response {
  return responseWithCookies(JSON.stringify(body), {
    status,
    cookies: clearedStateCookies(providerId, cookieConfig),
    extraHeaders: { "Content-Type": "application/json" },
  });
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
  const safeUrl = escapeHtmlAttr(absoluteUrl);
  // JSON.stringify does not escape "/" — a URL containing "</script>" would break out
  // of the script context. Replace "</" with "<\/" which is valid JS but safe in HTML.
  const jsUrl = JSON.stringify(absoluteUrl).replace(/</g, "\\u003c");
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${safeUrl}"><title>Redirecting...</title></head><body><script>window.location.href=${jsUrl}</script><noscript><a href="${safeUrl}">Click here</a></noscript></body></html>`;
  return responseWithCookies(html, {
    status: 200,
    cookies,
    extraHeaders: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'none'; img-src 'none'; frame-ancestors 'none'",
      "Referrer-Policy": "no-referrer",
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
  allowEmailAccountLinking?: boolean;
  allowUnverifiedEmailLinking?: boolean;
  /** @deprecated Use `allowEmailAccountLinking`. */
  allowDangerousEmailAccountLinking?: boolean;
  rbac?: RbacConfig;
  passwordMinLength?: number;
  allowedEmails?: string[] | ((email: string) => boolean);
  onAuthSuccess?: (user: { id: string }, request: Request) => string | undefined;
  callbacks?: AuthCallbacks;
  pages?: PagesConfig;
}

/** Lowercase + trim for safe comparison. RFC 5321 declares the local-part
 *  case-sensitivity provider-defined, but in practice every modern provider
 *  treats it as case-insensitive. We normalize to avoid duplicate-account
 *  bypass and allowlist case-mismatch. */
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function isEmailAllowed(
  email: string | null,
  rule?: string[] | ((email: string) => boolean)
): boolean {
  if (!rule) return true;
  if (!email) return false;
  const normalized = normalizeEmail(email);
  if (typeof rule === "function") {
    try {
      return rule(normalized);
    } catch {
      // Throwing inside an allowedEmails function fails closed (deny).
      return false;
    }
  }
  return rule.some((pattern) => {
    const p = pattern.toLowerCase();
    return p.startsWith("@") ? normalized.endsWith(p) : normalized === p;
  });
}

/**
 * Verify the Origin header on state-changing requests as a secondary CSRF defense.
 * SameSite cookies are the primary defense, but older browsers may not support them,
 * and misconfiguring SameSite=none disables that protection entirely.
 * Returns true if the request is safe (same-origin or no Origin for non-browser clients).
 */
function verifyCsrfOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  // If no Origin header, check Referer as fallback (non-browser clients won't send either)
  if (!origin) {
    const referer = request.headers.get("referer");
    if (!referer) return true; // Non-browser clients (curl, server-to-server) — allow
    try {
      const refOrigin = new URL(referer).origin;
      const reqOrigin = new URL(request.url).origin;
      return refOrigin === reqOrigin;
    } catch {
      return false;
    }
  }
  try {
    const reqOrigin = new URL(request.url).origin;
    return origin === reqOrigin;
  } catch {
    return false;
  }
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

    // CSRF Origin check for all POST endpoints (defense-in-depth alongside SameSite cookies)
    if (request.method === "POST" && !verifyCsrfOrigin(request)) {
      return new Response(
        JSON.stringify({ error: "CSRF origin check failed" }),
        { status: 403, headers: { "Content-Type": "application/json" } }
      );
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
      serializeStateCookie(stateCookieName(providerId), state, cookieConfig),
    ];

    // For Google PKCE, store the code verifier (per-provider name).
    if ("codeVerifier" in provider && typeof provider.codeVerifier === "string") {
      cookies.push(
        serializeStateCookie(verifierCookieName(providerId), provider.codeVerifier, cookieConfig)
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
    const storedState = parseCookieValue(cookieHeader, stateCookieName(providerId));

    if (!code || !state || !storedState || !(await timingSafeEqual(state, storedState))) {
      return jsonErrorWithStateClear(
        { error: "Invalid OAuth state" },
        400,
        providerId,
        cookieConfig
      );
    }

    // Restore code verifier for PKCE providers (per-provider name).
    if ("codeVerifier" in provider) {
      const storedVerifier = parseCookieValue(cookieHeader, verifierCookieName(providerId));
      if (storedVerifier) {
        (provider as { codeVerifier: string }).codeVerifier = storedVerifier;
      }
    }

    try {
      const tokens = await provider.validateAuthorizationCode(code);
      const rawProfile = await provider.getUserProfile(tokens.accessToken);
      // Normalize the OAuth-provided email to lowercase for consistent lookups
      // and case-insensitive uniqueness against the local users.email column.
      const profile = {
        ...rawProfile,
        email: rawProfile.email ? normalizeEmail(rawProfile.email) : null,
      };

      // Email restriction check — reject before any account/session creation
      if (!isEmailAllowed(profile.email, config.allowedEmails)) {
        return jsonErrorWithStateClear(
          { error: "EmailNotAllowed", message: "This email domain is not permitted" },
          403,
          providerId,
          cookieConfig
        );
      }

      // Look up existing user (by account, then by email)
      let user = await queries.getUserByAccount(providerId, profile.id);
      let existingUserByEmail = null as Awaited<ReturnType<typeof queries.getUserByEmail>> | null;

      if (!user && profile.email) {
        existingUserByEmail = await queries.getUserByEmail(profile.email);
      }

      const linkingFlagSet = Boolean(
        config.allowEmailAccountLinking ?? config.allowDangerousEmailAccountLinking
      );
      // Linking is gated on the IdP marking the email verified, unless the
      // consumer has explicitly opted out via `allowUnverifiedEmailLinking`.
      // This blocks the account-takeover vector where a provider that doesn't
      // verify email (e.g. a misconfigured GitHub OAuth app, or a provider
      // that returns an unverified email) is used to link to an existing
      // user's account.
      const emailLinkingAllowed =
        linkingFlagSet &&
        (profile.emailVerified === true ||
          config.allowUnverifiedEmailLinking === true);

      const willLinkByEmail = !user && !!existingUserByEmail && emailLinkingAllowed;
      const existingUserId: string | null =
        user?.id ?? (willLinkByEmail ? existingUserByEmail!.id : null);

      // Reject email-collision before invoking signIn (preserves pre-0.3 behavior).
      // Two reject sub-cases: (a) flag is off, (b) flag on but email not verified.
      if (!user && existingUserByEmail && !emailLinkingAllowed) {
        const reason = linkingFlagSet ? "EmailNotVerified" : "OAuthAccountNotLinked";
        const message = linkingFlagSet
          ? "Identity provider has not verified this email; cannot link to existing account"
          : "Email already associated with another account";
        return jsonErrorWithStateClear(
          { error: reason, message },
          403,
          providerId,
          cookieConfig
        );
      }

      // Invoke signIn callback if configured.
      let userOverrides: Record<string, unknown> = {};
      if (config.callbacks?.signIn) {
        const ctx = {
          provider: providerId,
          profile: {
            ...profile,
            id: profile.id,
            email: profile.email,
            name: profile.name,
            avatarUrl: profile.avatarUrl,
          },
          account: {
            provider_id: providerId,
            provider_user_id: profile.id,
            access_token: tokens.accessToken,
            refresh_token: tokens.refreshToken,
            expires_at: tokens.expiresAt,
          },
          existingUserId,
          emailLinked: willLinkByEmail,
          request,
        };
        const result = await config.callbacks.signIn(ctx);
        if (!result.allow) {
          const rawError = config.pages?.error ?? "/";
          const errorPage = isSafeRedirect(rawError, request) ? rawError : "/";
          const reason = encodeURIComponent(result.reason ?? "SIGNIN_REJECTED");
          const sep = errorPage.includes("?") ? "&" : "?";
          return htmlRedirectWithCookies(
            `${errorPage}${sep}error=${reason}`,
            request,
            clearedStateCookies(providerId, cookieConfig)
          );
        }
        if (result.userOverrides) userOverrides = result.userOverrides;
      }

      // Link account to existing email-matched user.
      if (willLinkByEmail) {
        user = existingUserByEmail;
        await queries.createAccount({
          id: generateId(),
          userId: existingUserByEmail!.id,
          providerId,
          providerUserId: profile.id,
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken ?? null,
          expiresAt: tokens.expiresAt ?? null,
        });
      }

      // Create new user if still none matched.
      if (!user) {
        if (!config.oauthAutoCreateAccount) {
          return jsonErrorWithStateClear(
            { error: "AccountNotFound", message: "No account found. Contact an administrator to create one." },
            403,
            providerId,
            cookieConfig
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
        await queries.createUser(user, userOverrides);
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

      const { token } = await sessionManager.createSession(user.id);

      const rawRedirect = onAuthSuccess?.(user, request) ?? "/";
      const redirect = isSafeRedirect(rawRedirect, request) ? rawRedirect : "/";
      return htmlRedirectWithCookies(redirect, request, [
        serializeSessionCookie(cookieConfig, token, sessionMaxAge),
        ...clearedStateCookies(providerId, cookieConfig),
      ]);
    } catch (error) {
      console.error("[just-auth] OAuth callback error:", error);
      return jsonErrorWithStateClear(
        { error: "Authentication failed" },
        500,
        providerId,
        cookieConfig
      );
    }
  }

  // Session responses must never be cached by browser/CDN/proxy and must
  // not be MIME-sniffed. These headers apply to every /session response shape.
  const SESSION_HEADERS: Record<string, string> = {
    "Content-Type": "application/json",
    "Cache-Control": "no-store, no-cache, must-revalidate, private",
    Pragma: "no-cache",
    "X-Content-Type-Options": "nosniff",
  };

  async function handleSession(request: Request): Promise<Response> {
    const cookieHeader = request.headers.get("cookie");
    const token = parseSessionCookie(cookieConfig, cookieHeader);

    if (!token) {
      return new Response(JSON.stringify(null), {
        status: 200,
        headers: SESSION_HEADERS,
      });
    }

    const result = await sessionManager.validateSession(token);

    if (!result) {
      return responseWithCookies(JSON.stringify(null), {
        status: 200,
        cookies: [clearSessionCookie(cookieConfig)],
        extraHeaders: SESSION_HEADERS,
      });
    }

    // Session callback: if configured, its return value replaces the default body entirely.
    if (config.callbacks?.session) {
      const ctx = {
        session: {
          id: result.session.id,
          userId: result.session.userId,
          expiresAt: result.session.expiresAt.getTime(),
        },
        user: {
          id: result.user.id,
          email: result.user.email,
          name: result.user.name,
          avatarUrl: result.user.avatarUrl,
        },
      };
      const body = await config.callbacks.session(ctx);
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: SESSION_HEADERS,
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
      headers: SESSION_HEADERS,
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
      const { email: rawEmail, password, name } = body;

      if (!rawEmail || typeof rawEmail !== "string" || typeof password !== "string" || !password) {
        return new Response(
          JSON.stringify({ error: "Email and password are required" }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }

      // Normalize early so all downstream lookups + storage are case-folded.
      const email = normalizeEmail(rawEmail);

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

      // Compute the password hash UNCONDITIONALLY before checking if the user
      // exists. Otherwise the response time leaks "email taken" vs "available"
      // (existing-user path skips the ~150ms PBKDF2 work, the new-user path
      // doesn't). With the unconditional hash, both paths take comparable time.
      const passwordHash = await hashPassword(password);

      const existingUser = await queries.getUserByEmail(email);
      if (existingUser) {
        // Generic error to prevent email enumeration.
        return new Response(
          JSON.stringify({ error: "Registration failed" }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }

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
      console.error("[just-auth] Registration error:", error);
      return new Response(
        JSON.stringify({ error: "Registration failed" }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }
  }

  async function handleCredentialsLogin(request: Request): Promise<Response> {
    try {
      const body = await request.json() as { email?: string; password?: string };
      const { email: rawEmail, password } = body;

      if (!rawEmail || typeof rawEmail !== "string" || typeof password !== "string" || !password) {
        return new Response(
          JSON.stringify({ error: "Email and password are required" }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }
      const email = normalizeEmail(rawEmail);

      const user = await queries.getUserByEmailWithPassword(email);

      // Always run password verification to prevent timing-based user enumeration.
      // When user doesn't exist, verify against a dummy hash so the response time
      // is indistinguishable from a real verification.
      const hashToVerify = user?.passwordHash ?? DUMMY_PASSWORD_HASH;
      const valid = await verifyPassword(password, hashToVerify);

      if (!user || !user.passwordHash || !valid) {
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
      console.error("[just-auth] Login error:", error);
      return new Response(
        JSON.stringify({ error: "Login failed" }),
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

      // Block self-targeted role changes — a holder of `user:set-role` should
      // not be able to grant themselves additional roles. Out-of-band ops
      // (DB-level role assignment) must be used to bootstrap superadmins.
      if (body.userId === session.user.id) {
        return new Response(
          JSON.stringify({ error: "Cannot change your own role" }),
          { status: 403, headers: { "Content-Type": "application/json" } }
        );
      }

      // Helper: a caller can only grant a role whose permission set is a
      // (non-strict) subset of their own. This blocks tenant-admin → superadmin
      // privilege escalation in a single request.
      const callerPermSet = new Set(callerPerms);
      function canGrant(roleId: string): boolean {
        const targetPerms = resolvePermissions(roleId, config.rbac!);
        return targetPerms.every((p) => callerPermSet.has(p));
      }

      let finalRole: string;

      if (body.addRole || body.removeRole) {
        // Incremental: add or remove a single role
        const targetRole = body.addRole ?? body.removeRole!;
        // Validate BOTH addRole and removeRole exist in config — silently
        // no-op'ing on removeRole hid configuration mistakes.
        if (!config.rbac!.roles[targetRole]) {
          return new Response(
            JSON.stringify({ error: `Invalid role: ${targetRole}` }),
            { status: 400, headers: { "Content-Type": "application/json" } }
          );
        }
        if (body.addRole && !canGrant(body.addRole)) {
          return new Response(
            JSON.stringify({ error: `Cannot grant role with permissions you don't hold: ${body.addRole}` }),
            { status: 403, headers: { "Content-Type": "application/json" } }
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
        // Validate every role exists AND that the caller's perms include all
        // of its permissions.
        for (const r of rolesToSet) {
          if (!config.rbac!.roles[r]) {
            return new Response(
              JSON.stringify({ error: `Invalid role: ${r}` }),
              { status: 400, headers: { "Content-Type": "application/json" } }
            );
          }
          if (!canGrant(r)) {
            return new Response(
              JSON.stringify({ error: `Cannot grant role with permissions you don't hold: ${r}` }),
              { status: 403, headers: { "Content-Type": "application/json" } }
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
      console.error("[just-auth] Set role error:", error);
      return new Response(
        JSON.stringify({ error: "Failed to set role" }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }
  }

  return { handleRequest };
}
