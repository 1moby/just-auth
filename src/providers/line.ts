import {
  generateCodeVerifier,
  createS256CodeChallenge,
  exchangeAuthorizationCode,
} from "../core/oauth.ts";
import type { OAuthProvider, OAuthTokens, OAuthUserProfile } from "../types.ts";

export interface LineProviderConfig {
  clientId: string;
  clientSecret: string;
  redirectURI: string;
  scopes?: string[];
}

interface LineUser {
  userId: string;
  displayName: string;
  pictureUrl?: string;
}

const authorizationEndpoint = "https://access.line.me/oauth2/v2.1/authorize";
const tokenEndpoint = "https://api.line.me/oauth2/v2.1/token";

export function createLineProvider(config: LineProviderConfig): OAuthProvider & { codeVerifier: string } {
  const scopes = config.scopes ?? ["openid", "profile", "email"];
  let currentCodeVerifier = "";

  return {
    id: "line",
    get codeVerifier() {
      return currentCodeVerifier;
    },
    set codeVerifier(value: string) {
      currentCodeVerifier = value;
    },

    async createAuthorizationURL(state: string): Promise<URL> {
      currentCodeVerifier = generateCodeVerifier();
      const codeChallenge = await createS256CodeChallenge(currentCodeVerifier);
      const url = new URL(authorizationEndpoint);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", config.clientId);
      url.searchParams.set("state", state);
      if (scopes.length > 0) {
        url.searchParams.set("scope", scopes.join(" "));
      }
      url.searchParams.set("redirect_uri", config.redirectURI);
      url.searchParams.set("code_challenge_method", "S256");
      url.searchParams.set("code_challenge", codeChallenge);
      return url;
    },

    async validateAuthorizationCode(code: string): Promise<OAuthTokens> {
      const result = await exchangeAuthorizationCode({
        tokenEndpoint,
        code,
        redirectURI: config.redirectURI,
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        codeVerifier: currentCodeVerifier,
      });
      return {
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        expiresAt: result.expiresAt,
      };
    },

    async getUserProfile(accessToken: string): Promise<OAuthUserProfile> {
      const response = await fetch("https://api.line.me/v2/profile", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!response.ok) {
        throw new Error(`LINE API error: ${response.status}`);
      }
      const data = (await response.json()) as LineUser;
      return {
        id: data.userId,
        email: null, // LINE profile API doesn't return email directly
        name: data.displayName,
        avatarUrl: data.pictureUrl ?? null,
      };
    },
  };
}
