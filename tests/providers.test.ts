import { describe, it, expect } from "bun:test";
import { createGitHubProvider } from "../src/providers/github.ts";
import { createGoogleProvider } from "../src/providers/google.ts";
import { createProviderMap } from "../src/providers/index.ts";

describe("GitHub Provider", () => {
  const provider = createGitHubProvider({
    clientId: "test-client-id",
    clientSecret: "test-client-secret",
    redirectURI: "http://localhost:3000/api/auth/callback/github",
  });

  it("should have the id 'github'", () => {
    expect(provider.id).toBe("github");
  });

  it("should create an authorization URL", async () => {
    const url = await provider.createAuthorizationURL("test-state");
    expect(url).toBeInstanceOf(URL);
    expect(url.hostname).toBe("github.com");
    expect(url.pathname).toContain("authorize");
    expect(url.searchParams.get("state")).toBe("test-state");
    expect(url.searchParams.get("client_id")).toBe("test-client-id");
  });

  it("should include PKCE code_challenge in URL", async () => {
    const url = await provider.createAuthorizationURL("state");
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("should expose codeVerifier", async () => {
    await provider.createAuthorizationURL("state");
    expect(provider.codeVerifier).toBeTruthy();
    expect(typeof provider.codeVerifier).toBe("string");
  });

  it("should include scopes in authorization URL", async () => {
    const url = await provider.createAuthorizationURL("state");
    const scope = url.searchParams.get("scope");
    expect(scope).toContain("user:email");
  });

  it("should support custom scopes", async () => {
    const customProvider = createGitHubProvider({
      clientId: "id",
      clientSecret: "secret",
      redirectURI: "http://localhost:3000/cb",
      scopes: ["read:user", "read:org"],
    });
    const url = await customProvider.createAuthorizationURL("state");
    const scope = url.searchParams.get("scope");
    expect(scope).toContain("read:user");
    expect(scope).toContain("read:org");
  });
});

describe("Google Provider", () => {
  const provider = createGoogleProvider({
    clientId: "test-google-id",
    clientSecret: "test-google-secret",
    redirectURI: "http://localhost:3000/api/auth/callback/google",
  });

  it("should have the id 'google'", () => {
    expect(provider.id).toBe("google");
  });

  it("should create an authorization URL", async () => {
    const url = await provider.createAuthorizationURL("test-state");
    expect(url).toBeInstanceOf(URL);
    expect(url.hostname).toBe("accounts.google.com");
    expect(url.searchParams.get("state")).toBe("test-state");
    expect(url.searchParams.get("client_id")).toBe("test-google-id");
  });

  it("should include PKCE code_challenge in URL", async () => {
    const url = await provider.createAuthorizationURL("state");
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("should include openid scope", async () => {
    const url = await provider.createAuthorizationURL("state");
    const scope = url.searchParams.get("scope");
    expect(scope).toContain("openid");
  });

  it("should expose codeVerifier", async () => {
    await provider.createAuthorizationURL("state");
    expect(provider.codeVerifier).toBeTruthy();
    expect(typeof provider.codeVerifier).toBe("string");
  });
});

describe("Provider Map", () => {
  it("should create a map from provider array", () => {
    const github = createGitHubProvider({
      clientId: "id",
      clientSecret: "secret",
      redirectURI: "http://localhost/cb",
    });
    const google = createGoogleProvider({
      clientId: "id",
      clientSecret: "secret",
      redirectURI: "http://localhost/cb",
    });
    const map = createProviderMap([github, google]);
    expect(map.size).toBe(2);
    expect(map.get("github")).toBe(github);
    expect(map.get("google")).toBe(google);
  });

  it("should return undefined for unknown provider", () => {
    const map = createProviderMap([]);
    expect(map.get("unknown")).toBeUndefined();
  });
});
