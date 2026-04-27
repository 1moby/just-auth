import type { CookieOptions } from "../types.ts";

const DEFAULT_COOKIE_NAME = "__Host-auth_session";

export interface CookieConfig {
  name: string;
  secure: boolean;
  sameSite: "lax" | "strict" | "none";
  domain?: string;
  path: string;
}

/** A cookie named `__Host-…` is silently rejected by browsers when Domain is
 *  set or Path != "/". A cookie named `__Secure-…` only requires Secure.
 *  When the consumer's config conflicts with the prefix, downgrade rather
 *  than ship a name the browser will refuse to set. */
function reconcilePrefix(name: string, domain: string | undefined, path: string): string {
  if (name.startsWith("__Host-") && (domain || path !== "/")) {
    const downgraded = "__Secure-" + name.slice("__Host-".length);
    if (typeof console !== "undefined") {
      console.warn(
        `[just-auth] cookie name "${name}" requires no Domain and Path=/; ` +
        `auto-downgrading to "${downgraded}" because Domain or Path is set.`
      );
    }
    return downgraded;
  }
  return name;
}

export function resolveCookieConfig(options?: CookieOptions): CookieConfig {
  const path = options?.path ?? "/";
  const domain = options?.domain;
  const requestedName = options?.name ?? DEFAULT_COOKIE_NAME;
  return {
    name: reconcilePrefix(requestedName, domain, path),
    secure: options?.secure ?? true,
    sameSite: options?.sameSite ?? "lax",
    domain,
    path,
  };
}

export function serializeSessionCookie(
  config: CookieConfig,
  token: string,
  maxAge: number
): string {
  const parts = [
    `${config.name}=${token}`,
    `HttpOnly`,
    `Path=${config.path}`,
    `Max-Age=${maxAge}`,
    `SameSite=${capitalize(config.sameSite)}`,
  ];
  if (config.secure) parts.push("Secure");
  // RFC: __Host- prefix forbids Domain. We've already auto-downgraded the
  // name in resolveCookieConfig if a domain is set, so this guard is belt-
  // and-suspenders.
  if (config.domain && !config.name.startsWith("__Host-")) {
    parts.push(`Domain=${config.domain}`);
  }
  return parts.join("; ");
}

export function clearSessionCookie(config: CookieConfig): string {
  return serializeSessionCookie(config, "", 0);
}

export function parseSessionCookie(
  config: CookieConfig,
  cookieHeader: string | null
): string | null {
  if (!cookieHeader) return null;
  const prefix = `${config.name}=`;
  const cookies = cookieHeader.split(";");
  for (const cookie of cookies) {
    const trimmed = cookie.trim();
    if (trimmed.startsWith(prefix)) {
      const value = trimmed.slice(prefix.length);
      return value || null;
    }
  }
  return null;
}

export function serializeStateCookie(
  name: string,
  value: string,
  config: CookieConfig
): string {
  const parts = [
    `${name}=${value}`,
    `HttpOnly`,
    `Path=${config.path}`,
    `Max-Age=600`, // 10 minutes
    `SameSite=${capitalize(config.sameSite)}`,
  ];
  if (config.secure) parts.push("Secure");
  if (config.domain) parts.push(`Domain=${config.domain}`);
  return parts.join("; ");
}

export function parseCookieValue(
  cookieHeader: string | null,
  name: string
): string | null {
  if (!cookieHeader) return null;
  const prefix = `${name}=`;
  const cookies = cookieHeader.split(";");
  for (const cookie of cookies) {
    const trimmed = cookie.trim();
    if (trimmed.startsWith(prefix)) {
      const value = trimmed.slice(prefix.length);
      return value || null;
    }
  }
  return null;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
