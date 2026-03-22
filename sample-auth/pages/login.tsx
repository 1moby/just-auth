import React, { useState } from "react";
import { signIn, signUp } from "../../src/client/index.ts";
import { useSession } from "../../src/client/index.ts";

function GoogleIcon() {
  return (
    <svg className="btn-icon" viewBox="0 0 24 24" fill="none">
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
    </svg>
  );
}

function LineIcon() {
  return (
    <svg className="btn-icon" viewBox="0 0 24 24" fill="#06C755">
      <path d="M24 10.304c0-5.369-5.383-9.738-12-9.738-6.616 0-12 4.369-12 9.738 0 4.814 4.269 8.846 10.036 9.608.391.084.922.258 1.057.592.121.303.079.778.039 1.085l-.171 1.027c-.053.303-.242 1.186 1.039.647 1.281-.54 6.911-4.069 9.428-6.967C23.024 14.396 24 12.458 24 10.304zM8.497 12.934H6.395a.397.397 0 0 1-.397-.396V8.498c0-.219.177-.396.397-.396.22 0 .397.177.397.396v3.644h1.705c.22 0 .397.177.397.396a.397.397 0 0 1-.397.396zm1.906-.396a.397.397 0 0 1-.794 0V8.498c0-.219.177-.396.397-.396.22 0 .397.177.397.396v4.04zm4.501 0a.396.396 0 0 1-.281.38.394.394 0 0 1-.439-.131l-2.235-3.044v2.795a.397.397 0 0 1-.794 0V8.498a.396.396 0 0 1 .281-.38.396.396 0 0 1 .439.131l2.235 3.044V8.498c0-.219.177-.396.397-.396.22 0 .397.177.397.396v4.04zm3.098-2.539a.397.397 0 0 1 0 .793h-1.705v1.35h1.705c.22 0 .397.177.397.396a.397.397 0 0 1-.397.396h-2.102a.397.397 0 0 1-.396-.396V8.498c0-.219.177-.396.396-.396h2.102c.22 0 .397.177.397.396a.397.397 0 0 1-.397.396h-1.705v1.106h1.705z"/>
    </svg>
  );
}

export function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [isRegister, setIsRegister] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const { update } = useSession();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      let res: Response;
      if (isRegister) {
        res = await signUp({ email, password, name: name || undefined });
      } else {
        res = await signIn("credentials", { email, password }) as Response;
      }
      if (res.ok) {
        await update();
      } else {
        const body = await res.json();
        setError(body.error || "Authentication failed");
      }
    } catch {
      setError("Network error");
    }
    setLoading(false);
  }

  return (
    <div className="container">
      <div className="card">
        <h1>Welcome</h1>
        <p className="subtitle">Sign in to continue to the dashboard</p>

        <button className="btn btn-google" onClick={() => signIn("google")}>
          <GoogleIcon />
          Continue with Google
        </button>

        <button className="btn btn-line" onClick={() => signIn("line")}>
          <LineIcon />
          Continue with LINE
        </button>

        <div className="divider" />

        <h3>{isRegister ? "Create Account" : "Sign in with Email"}</h3>
        <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {isRegister && (
            <input
              type="text"
              placeholder="Name (optional)"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="input"
            />
          )}
          <input
            type="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            className="input"
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            className="input"
          />
          {error && <p style={{ color: "#ef4444", margin: 0, fontSize: 14 }}>{error}</p>}
          <button type="submit" className="btn" disabled={loading}>
            {loading ? "Loading..." : isRegister ? "Create Account" : "Sign In"}
          </button>
        </form>
        <p style={{ textAlign: "center", marginTop: 8, fontSize: 14 }}>
          {isRegister ? "Already have an account?" : "Don't have an account?"}{" "}
          <a href="#" onClick={(e) => { e.preventDefault(); setIsRegister(!isRegister); setError(null); }}>
            {isRegister ? "Sign in" : "Create one"}
          </a>
        </p>
      </div>

      <div className="card">
        <h2>About this Demo</h2>
        <p>
          This is a sample app demonstrating <code>@1moby/just-auth</code> — a lightweight,
          zero-dependency, edge-native auth library. It uses Web Crypto API for OAuth + PKCE,
          raw SQL for session storage, and provides a familiar React API.
        </p>
        <p>
          Accounts with the same email are automatically linked. Sign in with email/password,
          then sign in with Google/LINE using the same email — they'll share one user account.
        </p>
      </div>
    </div>
  );
}
