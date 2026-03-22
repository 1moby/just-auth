import {
  generateCodeVerifier,
  createS256CodeChallenge,
  exchangeAuthorizationCode,
} from "../core/oauth.ts";
import type { OAuthProvider, OAuthTokens, OAuthUserProfile } from "../types.ts";

export interface GoogleProviderConfig {
  clientId: string;
  clientSecret: string;
  redirectURI: string;
  scopes?: string[];
}

interface GoogleUser {
  sub: string;
  email: string;
  name: string;
  picture: string;
}

const authorizationEndpoint = "https://accounts.google.com/o/oauth2/v2/auth";
const tokenEndpoint = "https://oauth2.googleapis.com/token";

export function createGoogleProvider(config: GoogleProviderConfig): OAuthProvider & { codeVerifier: string } {
  const scopes = config.scopes ?? ["openid", "profile", "email"];
  let currentCodeVerifier = "";

  return {
    id: "google",
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
      url.searchParams.set("redirect_uri", config.redirectURI);
      url.searchParams.set("state", state);
      url.searchParams.set("code_challenge_method", "S256");
      url.searchParams.set("code_challenge", codeChallenge);
      if (scopes.length > 0) {
        url.searchParams.set("scope", scopes.join(" "));
      }
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
        expiresAt: result.expiresAt,
      };
    },

    async getUserProfile(accessToken: string): Promise<OAuthUserProfile> {
      const response = await fetch(
        "https://openidconnect.googleapis.com/v1/userinfo",
        {
          headers: { Authorization: `Bearer ${accessToken}` },
        }
      );
      if (!response.ok) {
        throw new Error(`Google API error: ${response.status}`);
      }
      const data = (await response.json()) as GoogleUser;
      return {
        id: data.sub,
        email: data.email,
        name: data.name,
        avatarUrl: data.picture,
      };
    },
  };
}
