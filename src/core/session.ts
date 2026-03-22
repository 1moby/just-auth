import type {
  Session,
  SessionManager,
  SessionValidationResult,
} from "../types.ts";
import type { Queries } from "../db/queries.ts";

const DAY_MS = 86400 * 1000;

export function generateSessionToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return encodeBase64url(bytes);
}

export async function hashToken(token: string): Promise<string> {
  const encoded = new TextEncoder().encode(token);
  const hash = await crypto.subtle.digest("SHA-256", encoded);
  return encodeHex(new Uint8Array(hash));
}

export function encodeBase64url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function encodeHex(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i]!.toString(16).padStart(2, "0");
  }
  return hex;
}

export function createSessionManager(
  queries: Queries,
  options?: { maxAge?: number; refreshThreshold?: number }
): SessionManager {
  const maxAgeMs = (options?.maxAge ?? 30 * 86400) * 1000;
  const refreshThresholdMs = (options?.refreshThreshold ?? 15 * 86400) * 1000;

  return {
    generateToken: generateSessionToken,

    async createSession(
      userId: string
    ): Promise<{ session: Session; token: string }> {
      const token = generateSessionToken();
      const sessionId = await hashToken(token);
      const expiresAt = Date.now() + maxAgeMs;

      await queries.insertSession({
        id: sessionId,
        userId,
        expiresAt,
      });

      return {
        session: {
          id: sessionId,
          userId,
          expiresAt: new Date(expiresAt),
        },
        token,
      };
    },

    async validateSession(
      token: string
    ): Promise<SessionValidationResult | null> {
      const sessionId = await hashToken(token);
      const result = await queries.getSessionAndUser(sessionId);

      if (!result) return null;

      const now = Date.now();
      const expiresAtMs = result.session.expiresAt.getTime();

      // Session expired
      if (now >= expiresAtMs) {
        await queries.deleteSession(sessionId);
        return null;
      }

      // Sliding window: extend if less than threshold remaining
      if (expiresAtMs - now < refreshThresholdMs) {
        const newExpiresAt = now + maxAgeMs;
        await queries.updateSessionExpiry(sessionId, newExpiresAt);
        result.session.expiresAt = new Date(newExpiresAt);
      }

      return result;
    },

    async invalidateSession(sessionId: string): Promise<void> {
      await queries.deleteSession(sessionId);
    },
  };
}
