export function signIn(
  provider: string,
  options?: { email?: string; password?: string; redirectTo?: string },
  basePath = "/api/auth"
): void | Promise<Response> {
  if (provider === "credentials") {
    return fetch(`${basePath}/callback/credentials`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ email: options?.email, password: options?.password }),
    });
  }
  window.location.href = `${basePath}/login/${provider}`;
}

export async function signUp(
  options: { email: string; password: string; name?: string },
  basePath = "/api/auth"
): Promise<Response> {
  return fetch(`${basePath}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(options),
  });
}

export async function signOut(basePath = "/api/auth"): Promise<void> {
  await fetch(`${basePath}/logout`, {
    method: "POST",
    credentials: "same-origin",
  });
  window.location.href = "/";
}
