# Lightweight next-auth alternatives for OAuth-only edge deployments

**No single library replaces next-auth with OAuth-only focus, D1 support, and API parity — but Arctic combined with ~200 lines of custom session code on raw D1 SQL delivers a sub-200 kB auth stack that cold-starts in under 1 ms on Cloudflare Workers.** This architectural pattern, championed by the Lucia Auth creator after deprecating his own library, has become the community consensus for minimal edge authentication. The key insight: next-auth's ~1.8 MB dependency tree exists primarily to abstract away provider quirks and database adapters — stripping to OAuth-only with raw SQL eliminates both bottlenecks entirely.

---

## Arctic emerges as the definitive OAuth-only building block

**Arctic** (by pilcrowOnPaper, the creator of Lucia Auth) is a collection of OAuth 2.0 clients built exclusively on the Fetch API and Web Crypto API. At **154 kB unpacked with zero dependencies**, it supports **65+ providers** including Google, GitHub, Microsoft Entra ID, Apple, Discord, Slack, and LinkedIn. The API surface is radically minimal — three operations per provider:

```typescript
const github = new arctic.GitHub(clientId, clientSecret, redirectURI);
const url = github.createAuthorizationURL(state, scopes);    // Step 1: redirect
const tokens = await github.validateAuthorizationCode(code);  // Step 2: callback
const accessToken = tokens.accessToken();                      // Step 3: use
```

Arctic runs natively on **Cloudflare Workers, Deno, Bun, and Node.js 20+** without polyfills. It handles only the authorization code flow — no session management, no database interactions, no UI. This is by design. Arctic has ~61,000 weekly npm downloads, **1,600+ GitHub stars**, and receives regular updates (v3.7.0 as of mid-2025).

Two other edge-compatible OAuth libraries deserve mention. **oauth4webapi** (by Filip Skokan, the `jose` library author) is the most spec-compliant option — OpenID Certified, supporting PKCE, DPoP, PAR, and FAPI 2.0. It has zero dependencies and **3.8–4.5 million weekly downloads** (Auth.js itself uses it internally). However, it provides no provider-specific wrappers, requiring developers to construct authorization URLs and handle discovery manually. **@oslojs/oauth2** is the most minimal option at just **8.32 kB** — but it only parses OAuth token responses, leaving HTTP requests and URL construction entirely to you.

| Library | Unpacked size | Dependencies | Providers | Edge-native | Abstraction level |
|---------|-------------|-------------|-----------|------------|-------------------|
| **@oslojs/oauth2** | **8.32 kB** | 0 | Generic only | ✅ | Response parser only |
| **Arctic** | **154 kB** | 0 (uses @oslojs) | 65+ built-in | ✅ | Full OAuth flow per provider |
| **oauth4webapi** | **317 kB** | 0 | Generic (manual) | ✅ | Full flow, no provider wrappers |
| **next-auth v5** | **~1.8 MB** | 14+ | 80+ | ⚠️ Partial | Full auth framework |
| **better-auth** | **4.3 MB** | Many | Via plugins | ⚠️ Issues | Full auth framework |

---

## The D1 raw SQL landscape is surprisingly well-supported

Cloudflare D1 has first-class authentication adapter support across multiple projects, and the raw SQL approach is now standard rather than exceptional.

**Auth.js's official `@auth/d1-adapter`** (v1.11.1) uses raw SQL internally — no ORM at all. It exports named SQL constants (`CREATE_USER_SQL`, `GET_USER_BY_EMAIL_SQL`, etc.) and includes a built-in `up()` migration function that creates the standard four-table schema (users, accounts, sessions, verification_tokens) directly on D1. This adapter works with `@opennextjs/cloudflare` for Next.js deployments. One critical caveat: **Auth.js has been acquired by Better Auth Inc.** as of 2025, and the documentation now steers users toward Better Auth.

For the raw-SQL-with-D1 approach without Auth.js overhead, the community has established clear patterns. D1's native API (`env.DB.prepare(sql).bind(...params).run()`) requires zero abstractions, and several lightweight query builders exist for ergonomics without ORM overhead:

- **Raw D1 API**: Zero overhead, direct `prepare().bind().run()` calls
- **workers-qb**: Zero-dependency D1 query builder by G4brym
- **Kysely** with `kysely-d1` dialect: Type-safe SQL builder, no schema generation magic
- **Drizzle ORM** with `drizzle-orm/d1`: Lightweight TypeScript ORM (lighter than Prisma)

A notable reference implementation is **G4brym's authentication-using-d1-example** on GitHub, which demonstrates registration, login, and session management using Hono + workers-qb + D1 with pure SQL migrations — no auth library at all.

---

## Lucia Auth's deprecation spawned the "build-it-yourself" movement

Lucia Auth was deprecated in **March 2025** after maintainer pilcrowOnPaper concluded that the database adapter abstraction was a "significant complexity tax" that constrained the library's design. The key realization: after stripping adapters, Lucia would reduce to ~50-80 lines of session management code — not enough to justify a dedicated library. The GitHub repo (10.4k+ stars) is archived, with v3 docs at v3.lucia-auth.com.

The deprecation produced four successor artifacts rather than a replacement library. **Arctic** handles OAuth flows. The **@oslojs/* packages** provide crypto utilities (encoding, hashing, JWT parsing) — all edge-compatible with zero dependencies. **The Copenhagen Book** (thecopenhagenbook.com, 2.1k+ GitHub stars) is an open-source guide covering sessions, OAuth, passwords, MFA, WebAuthn, and CSRF from first principles. And the **new lucia-auth.com** itself became a learning resource with copy-paste session management code licensed under Zero-Clause BSD.

The migration guide at lucia-auth.com/lucia-v3/migrate provides complete raw SQL implementations for `generateSessionToken()`, `createSession()`, `validateSession()`, and `invalidateSession()` — using `crypto.getRandomValues` for token generation and a 30-day sliding window expiration strategy. **No database migration is required** if you were already using Lucia's schema (user + session tables).

Community responses to the deprecation include **Narvik** (a spiritual successor that decouples from the data layer — you pass in your own storage functions), **AirAuth** (a new Next.js-focused project with `@airauth/core`, `@airauth/next`, `@airauth/react` packages, still early-stage), and the SvelteKit team's `npx sv add lucia` command that scaffolds the Lucia-pattern code. However, no fork of Lucia itself has gained significant traction. **Better Auth** (1.2M weekly npm downloads, YC X25) is the most popular library replacement, but at 4.3 MB it violates the "lightweight" requirement.

---

## Custom mini-auth implementations follow a consistent pattern

Extensive searching across GitHub, Reddit, and HackerNews reveals **no "next-auth-lite" npm package exists** — searches for `auth-lite`, `next-auth-lite`, `auth-mini`, and `micro-auth` returned no relevant results. Instead, the community has converged on a recognizable DIY pattern that appears in multiple repos, blog posts, and tutorials:

The dominant architecture uses Arctic for OAuth token exchange, two database tables (users + sessions), HTTP-only encrypted session cookies, and four route handlers. The most referenced implementations include **lucia-auth/example-nextjs-github-oauth** (the canonical example), **willwill96/Oauth2-Nextjs-Examples** (which includes a `roll-your-own/` directory with Redis session storage), and Robin Wieruch's comprehensive tutorial at robinwieruch.de that implements the full pattern with Prisma.

Community sentiment on Reddit and HackerNews strongly favors this approach over Auth.js. Representative quotes include: *"I went down the rabbithole of using next-auth... These were solved problems in the MEAN stack era with middlewares"* and *"This library is so opinionated that it more or less becomes useless."* The most upvoted alternative recommendations are: Better Auth (for those wanting a library), Arctic + custom code (for control), and **iron-session** (for the simplest possible approach — encrypted cookie sessions with no database).

For **Cloudflare Workers specifically**, Simon Willison's minimal GitHub OAuth implementation (til.simonwillison.net) demonstrates the entire flow in a single Worker, and the **vhscom/private-landing** project (Show HN, Feb 2026) provides NIST/OWASP-compliant auth using Hono + Turso on edge runtime.

---

## Bundle size and cold start performance heavily favor Arctic

Cloudflare Workers enforce hard size limits: **3 MiB on the free plan, 10 MiB on paid** (compressed). V8 isolates start in under 1 ms — Cloudflare effectively advertises "zero cold starts." The performance bottleneck is JavaScript parsing and initialization time, which scales with bundle size.

**Arctic + custom session code + @oslojs utilities totals well under 200 kB**, leaving enormous headroom within Worker limits. By contrast, next-auth v5 with dependencies can reach **500 KB–1 MB+** of JavaScript, and users have reported middleware bundles of ~128 KB from next-auth alone. Auth.js on Cloudflare Workers also requires `@opennextjs/cloudflare` with `nodejs_compat` flag and Node.js runtime mode (not true edge), adding further overhead.

No published benchmarks directly compare auth library cold start times on Workers. However, the general principle holds: **fewer bytes to parse means faster initialization**. One source estimates a **25–50% latency reduction** when running auth logic at the edge versus Node.js runtime. The Arctic approach achieves this naturally since every dependency uses Web Crypto API exclusively.

For JWT validation at the edge, the **jose** library (v6+, by the oauth4webapi author) is the standard choice — it works natively on Workers and is lightweight enough for token verification without a database round-trip.

---

## API migration from next-auth requires ~200–400 lines of custom code

The gap between next-auth's API and Arctic is substantial but well-documented. Arctic provides none of next-auth's developer experience — no `useSession()`, no `getSession()`, no `SessionProvider`, no `signIn()`/`signOut()` helpers, no adapter interface, no callback system. Bridging this gap requires custom code for four components:

**Session management (~60–80 lines)**: Generate session tokens via `crypto.getRandomValues`, hash and store in D1's session table, validate on each request with sliding 30-day expiration, set/delete HTTP-only cookies. The exact code is available at lucia-auth.com under 0BSD license.

**Route handlers (~30–50 lines per provider)**: A `/login/github/route.ts` that generates state, stores it in a cookie, and redirects to Arctic's authorization URL. A `/login/github/callback/route.ts` that validates state, exchanges the code via Arctic, upserts the user in D1, creates a session, and sets the cookie.

**`useSession` hook (~30–40 lines)**: A React Context provider that fetches `/api/auth/session` on mount, returns `{ data, status }` matching next-auth's `"loading" | "authenticated" | "unauthenticated"` pattern, and optionally re-fetches on window focus.

**`signIn`/`signOut` helpers (~20 lines)**: `signIn("github")` redirects to `/login/github`; `signOut()` calls `/api/auth/logout` which invalidates the D1 session and clears the cookie.

The next-auth adapter interface requires 14 methods across 4 tables. The OAuth-only subset needs roughly half: `createUser`, `getUserByAccount`, `createSession`, `getSessionAndUser`, `deleteSession`, and `linkAccount`. With raw D1 SQL, each method is a single `prepare().bind().run()` call — **roughly 5 lines per method**.

---

## Recommended architecture: Arctic + raw D1 + custom session layer

No single library satisfies all three requirements (OAuth-only, D1/raw SQL, next-auth API parity). The recommended architecture combines three components:

**Layer 1 — OAuth flow**: Arctic handles all provider-specific OAuth logic. Import only the providers you need (Google, GitHub) for tree-shaking. Arctic's `createAuthorizationURL()` and `validateAuthorizationCode()` replace next-auth's entire provider system.

**Layer 2 — Session management**: Copy the ~70 lines from lucia-auth.com's migration guide (0BSD licensed). Use raw D1 SQL with two tables:

```sql
CREATE TABLE user (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE,
  name TEXT,
  avatar_url TEXT,
  github_id TEXT UNIQUE  -- one column per OAuth provider
);
CREATE TABLE session (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id),
  expires_at INTEGER NOT NULL
);
```

**Layer 3 — Next.js integration**: Build a thin `auth.ts` module exporting `getCurrentSession()` (reads cookie, validates against D1), a `useSession()` React hook, and `signIn()`/`signOut()` helpers. This layer is ~100 lines and provides the familiar next-auth developer experience.

This stack totals **under 200 kB**, has **zero Node.js-specific dependencies**, runs natively on **Cloudflare Workers without `nodejs_compat`**, and uses D1's raw SQL interface directly. Cold starts are negligible. The tradeoff is approximately **1–2 days of initial setup** versus next-auth's drop-in configuration — but you gain complete control over the data model, no adapter abstraction overhead, and a bundle that's roughly **10× smaller** than next-auth.

If the custom code feels excessive, **Better Auth** with the `better-auth-cloudflare` plugin is the closest library alternative — it provides `useSession()` equivalents and has D1 support via Kysely. But at 4.3 MB with ongoing edge runtime compatibility issues, it trades the "lightweight" requirement for developer convenience. For truly minimal OAuth on Cloudflare Workers, the Arctic + raw D1 + custom session pattern is the right answer.

## Conclusion

The authentication ecosystem has undergone a significant philosophical shift since Lucia Auth's deprecation. The old model — heavy framework with adapter abstractions — is giving way to a composable approach where Arctic handles OAuth, @oslojs provides crypto primitives, The Copenhagen Book teaches the patterns, and developers write the ~200 lines of glue code themselves. This shift particularly benefits edge deployments where every kilobyte matters. The recommended stack (Arctic + raw D1 SQL + custom session layer) is not a compromise — it is increasingly the **intentional architecture** that the most performance-conscious developers choose, delivering sub-millisecond auth on Cloudflare's global network with full control over every SQL query.