import {
  exchangeAuthorizationCode,
  generateCodeVerifier,
  createS256CodeChallenge,
} from "../core/oauth.ts";
import type { OAuthProvider, OAuthTokens, OAuthUserProfile } from "../types.ts";

export interface GitHubProviderConfig {
  clientId: string;
  clientSecret: string;
  redirectURI: string;
  scopes?: string[];
}

interface GitHubUser {
  id: number;
  login: string;
  email: string | null;
  name: string | null;
  avatar_url: string | null;
}

const authorizationEndpoint = "https://github.com/login/oauth/authorize";
const tokenEndpoint = "https://github.com/login/oauth/access_token";

export function createGitHubProvider(config: GitHubProviderConfig): OAuthProvider & { codeVerifier: string } {
  const scopes = config.scopes ?? ["user:email"];
  let currentCodeVerifier = "";

  return {
    id: "github",
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
      url.searchParams.set("code_challenge_method", "S256");
      url.searchParams.set("code_challenge", codeChallenge);
      if (scopes.length > 0) {
        url.searchParams.set("scope", scopes.join(" "));
      }
      url.searchParams.set("redirect_uri", config.redirectURI);
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
        useBasicAuth: true,
      });
      return { accessToken: result.accessToken };
    },

    async getUserProfile(accessToken: string): Promise<OAuthUserProfile> {
      const response = await fetch("https://api.github.com/user", {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "User-Agent": "react-auth",
        },
      });
      if (!response.ok) {
        throw new Error(`GitHub API error: ${response.status}`);
      }
      const data = (await response.json()) as GitHubUser;

      // GitHub's /user endpoint returns the user's PUBLIC email, which can be
      // unverified. To know if the email is verified we need /user/emails which
      // requires the `user:email` scope (already in our default scopes).
      let emailVerified = false;
      let email: string | null = data.email;
      try {
        const emailsRes = await fetch("https://api.github.com/user/emails", {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "User-Agent": "react-auth",
          },
        });
        if (emailsRes.ok) {
          const emails = (await emailsRes.json()) as Array<{
            email: string;
            primary: boolean;
            verified: boolean;
          }>;
          const primary = emails.find((e) => e.primary) ?? emails[0];
          if (primary) {
            email = primary.email;
            emailVerified = primary.verified === true;
          }
        }
      } catch {
        // Fall back to /user-only data; emailVerified stays false.
      }

      return {
        id: String(data.id),
        email,
        emailVerified,
        name: data.name ?? data.login,
        avatarUrl: data.avatar_url,
      };
    },
  };
}
