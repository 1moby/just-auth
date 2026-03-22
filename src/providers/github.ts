import { exchangeAuthorizationCode } from "../core/oauth.ts";
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

export function createGitHubProvider(config: GitHubProviderConfig): OAuthProvider {
  const scopes = config.scopes ?? ["user:email"];

  return {
    id: "github",

    createAuthorizationURL(state: string): URL {
      const url = new URL(authorizationEndpoint);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", config.clientId);
      url.searchParams.set("state", state);
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
      return {
        id: String(data.id),
        email: data.email,
        name: data.name ?? data.login,
        avatarUrl: data.avatar_url,
      };
    },
  };
}
