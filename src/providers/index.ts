import type { OAuthProvider } from "../types.ts";

export { createGitHubProvider } from "./github.ts";
export { createGoogleProvider } from "./google.ts";
export { createLineProvider } from "./line.ts";

export function createProviderMap(
  providers: OAuthProvider[]
): Map<string, OAuthProvider> {
  const map = new Map<string, OAuthProvider>();
  for (const provider of providers) {
    map.set(provider.id, provider);
  }
  return map;
}
