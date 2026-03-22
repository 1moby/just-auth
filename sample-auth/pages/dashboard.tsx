import React, { useState } from "react";
import { useSession, signOut } from "../../src/client/index.ts";

export function DashboardPage() {
  const { data } = useSession();
  const [apiResult, setApiResult] = useState<string | null>(null);
  const [apiLoading, setApiLoading] = useState(false);

  if (!data) return null;

  const { user } = data;
  const initial = (user.name ?? user.email ?? "?")[0]!.toUpperCase();

  return (
    <div className="container">
      <div className="card">
        <div className="badge">Authenticated</div>
        <div className="user-info">
          {user.avatarUrl ? (
            <img src={user.avatarUrl} alt="" className="avatar" />
          ) : (
            <div className="avatar-placeholder">{initial}</div>
          )}
          <div className="user-details">
            <h2>{user.name ?? "User"}</h2>
            <p>{user.email ?? "No email"}</p>
          </div>
        </div>

        <div className="divider" />

        <h3>Session Info</h3>
        <p>
          User ID: <code>{user.id}</code>
        </p>
        {data.session?.expiresAt && (
          <p>
            Expires: <code>{new Date(data.session.expiresAt).toLocaleString()}</code>
          </p>
        )}

        <div className="divider" />

        <h3>RBAC</h3>
        <p>
          Role: <code>{user.role ?? "none"}</code>
        </p>
        {data.permissions && data.permissions.length > 0 && (
          <>
            <p>Permissions:</p>
            <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {data.permissions.map((p, i) => (
                <li key={i} style={{ padding: "2px 0" }}>
                  <code>{p}</code>
                </li>
              ))}
            </ul>
          </>
        )}

        <div className="divider" />

        <h3>Server-side Auth Check</h3>
        <p>
          <code>GET /api/me</code> — protected route using <code>auth.auth(request)</code>
        </p>
        <button
          className="btn"
          style={{ marginBottom: 8 }}
          onClick={async () => {
            setApiLoading(true);
            try {
              const res = await fetch("/api/me", { credentials: "same-origin" });
              const json = await res.json();
              setApiResult(JSON.stringify(json, null, 2));
            } catch (e: any) {
              setApiResult(`Error: ${e.message}`);
            }
            setApiLoading(false);
          }}
        >
          {apiLoading ? "Loading..." : "Call /api/me"}
        </button>
        {apiResult && (
          <pre><code>{apiResult}</code></pre>
        )}

        <div className="divider" />

        <h3>Linked Accounts</h3>
        {data.accounts && data.accounts.length > 0 ? (
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {data.accounts.map((a, i) => (
              <li key={i} style={{ padding: "4px 0" }}>
                <code>{a.providerId}</code>
              </li>
            ))}
          </ul>
        ) : (
          <p>No linked accounts</p>
        )}

        <div className="divider" />

        <button className="btn btn-logout" onClick={() => signOut()}>
          Sign Out
        </button>
      </div>

      <div className="card">
        <h2>@1moby/just-auth</h2>
        <p>Zero-dependency, edge-native auth library for React.</p>

        <div className="divider" />

        <h3>Features</h3>
        <ul style={{ lineHeight: 1.8, paddingLeft: 20 }}>
          <li>OAuth 2.0 + PKCE (Google, GitHub, LINE)</li>
          <li>Email/password with PBKDF2-SHA256</li>
          <li>Session management (sliding window)</li>
          <li>Account linking by email</li>
          <li>RBAC — role-based access control</li>
          <li>Table prefix support (<code>tablePrefix: "myapp_"</code>)</li>
          <li>Email/domain restriction (<code>allowedEmails</code>)</li>
          <li>Route permission middleware (<code>createAuthMiddleware</code>)</li>
          <li>Security hardened — timing-safe comparison, password length limits, open redirect protection</li>
        </ul>

        <div className="divider" />

        <h3>Database Adapters</h3>
        <p>Bring your own driver — only the adapter you import gets bundled:</p>
        <pre><code>{`import { createD1Adapter } from "@1moby/just-auth/adapters/d1"
import { createBunSQLiteAdapter } from "@1moby/just-auth/adapters/bun-sqlite"
import { createPgAdapter } from "@1moby/just-auth/adapters/pg"
import { createMySQLAdapter } from "@1moby/just-auth/adapters/mysql"
import { createBunSQLAdapter } from "@1moby/just-auth/adapters/bun-sql"`}</code></pre>

        <div className="divider" />

        <h3>Quick Start</h3>
        <pre><code>{`bun add @1moby/just-auth`}</code></pre>
        <p style={{ marginTop: 12 }}>
          Full documentation, examples, and API reference on GitHub:
        </p>
        <p>
          <a href="https://github.com/1moby/just-auth" target="_blank" rel="noopener noreferrer" style={{ fontWeight: 600 }}>
            github.com/1moby/just-auth
          </a>
        </p>
      </div>
    </div>
  );
}
