import type { AuthInstance } from "../types.ts";

export interface AuthMiddlewareConfig {
  /** Paths that don't require authentication (exact or glob with trailing *) */
  publicPaths?: string[];
  /** Where to redirect unauthenticated users. Default: "/login" */
  loginRedirect?: string;
  /** Map route patterns to required permissions. Pattern supports trailing * for prefix matching. */
  routePermissions?: Record<string, string>;
  /** Custom handler when permission is denied. Default: 403 JSON response */
  onForbidden?: (request: Request) => Response | Promise<Response>;
  /** File extensions to skip (always public). Default: common static file extensions */
  staticExtensions?: string[];
}

const DEFAULT_STATIC_EXT = [
  ".js", ".css", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico",
  ".woff", ".woff2", ".ttf", ".eot", ".map", ".json",
];

function matchPattern(pattern: string, pathname: string): boolean {
  if (pattern === pathname) return true;
  if (pattern.endsWith("/*")) {
    const prefix = pattern.slice(0, -1); // "/admin/*" → "/admin/"
    return pathname.startsWith(prefix) || pathname === prefix.slice(0, -1);
  }
  return false;
}

function isStaticFile(pathname: string, extensions: string[]): boolean {
  const dot = pathname.lastIndexOf(".");
  if (dot === -1) return false;
  return extensions.includes(pathname.slice(dot));
}

export function createAuthMiddleware(
  auth: AuthInstance,
  config: AuthMiddlewareConfig = {}
) {
  const {
    publicPaths = [],
    loginRedirect = "/login",
    routePermissions = {},
    onForbidden,
    staticExtensions = DEFAULT_STATIC_EXT,
  } = config;

  /**
   * Returns null if the request should proceed (authenticated + authorized).
   * Returns a Response (redirect or 403) if the request should be blocked.
   */
  async function handle(request: Request): Promise<Response | null> {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // Skip static files
    if (isStaticFile(pathname, staticExtensions)) return null;

    // Skip public paths
    for (const publicPath of publicPaths) {
      if (matchPattern(publicPath, pathname)) return null;
    }

    // Check authentication
    const session = await auth.auth(request);
    if (!session) {
      return new Response(null, {
        status: 302,
        headers: { Location: loginRedirect },
      });
    }

    // Check route permissions
    for (const [pattern, permission] of Object.entries(routePermissions)) {
      if (matchPattern(pattern, pathname)) {
        const hasPermission = await auth.hasPermission(request, permission);
        if (!hasPermission) {
          if (onForbidden) return onForbidden(request);
          return new Response(
            JSON.stringify({ error: "Forbidden", message: `Missing permission: ${permission}` }),
            { status: 403, headers: { "Content-Type": "application/json" } }
          );
        }
      }
    }

    // Authorized — proceed
    return null;
  }

  return { handle };
}
