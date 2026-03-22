import { encodeBase64url, encodeHex } from "./session.ts";

export function generateState(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return encodeBase64url(bytes);
}

export function generateCodeVerifier(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return encodeBase64url(bytes);
}

export async function createS256CodeChallenge(
  codeVerifier: string
): Promise<string> {
  const encoded = new TextEncoder().encode(codeVerifier);
  const hash = await crypto.subtle.digest("SHA-256", encoded);
  return encodeBase64url(new Uint8Array(hash));
}

export interface OAuthTokenResponse {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  id_token?: string;
}

export interface TokenResult {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}

function parseTokenResponse(data: OAuthTokenResponse): TokenResult {
  const result: TokenResult = {
    accessToken: data.access_token,
  };
  if (data.refresh_token) {
    result.refreshToken = data.refresh_token;
  }
  if (data.expires_in) {
    result.expiresAt = Date.now() + data.expires_in * 1000;
  }
  return result;
}

export async function exchangeAuthorizationCode(options: {
  tokenEndpoint: string;
  code: string;
  redirectURI: string;
  clientId: string;
  clientSecret: string;
  codeVerifier?: string;
  useBasicAuth?: boolean;
}): Promise<TokenResult> {
  const body = new URLSearchParams();
  body.set("grant_type", "authorization_code");
  body.set("code", options.code);
  body.set("redirect_uri", options.redirectURI);

  if (options.codeVerifier) {
    body.set("code_verifier", options.codeVerifier);
  }

  if (!options.useBasicAuth) {
    body.set("client_id", options.clientId);
    body.set("client_secret", options.clientSecret);
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
    "User-Agent": "react-auth",
  };

  if (options.useBasicAuth) {
    const credentials = btoa(`${options.clientId}:${options.clientSecret}`);
    headers["Authorization"] = `Basic ${credentials}`;
  }

  const response = await fetch(options.tokenEndpoint, {
    method: "POST",
    headers,
    body: body.toString(),
  });

  if (!response.ok) {
    let errorMessage = `Token exchange failed: ${response.status}`;
    try {
      const errorData = (await response.json()) as Record<string, unknown>;
      if (errorData.error) {
        errorMessage = `OAuth error: ${errorData.error}${errorData.error_description ? ` - ${errorData.error_description}` : ""}`;
      }
    } catch {}
    throw new Error(errorMessage);
  }

  const data = (await response.json()) as OAuthTokenResponse;
  if (!data.access_token) {
    throw new Error("Missing access_token in token response");
  }

  return parseTokenResponse(data);
}
