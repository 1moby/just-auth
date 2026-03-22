import type { CookieOptions } from "../types.ts";

const DEFAULT_COOKIE_NAME = "auth_session";

export interface CookieConfig {
  name: string;
  secure: boolean;
  sameSite: "lax" | "strict" | "none";
  domain?: string;
  path: string;
}

export function resolveCookieConfig(options?: CookieOptions): CookieConfig {
  return {
    name: options?.name ?? DEFAULT_COOKIE_NAME,
    secure: options?.secure ?? true,
    sameSite: options?.sameSite ?? "lax",
    domain: options?.domain,
    path: options?.path ?? "/",
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
  if (config.domain) parts.push(`Domain=${config.domain}`);
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
