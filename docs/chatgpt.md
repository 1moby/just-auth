# Lightweight Auth.js Alternatives for Next.js on Cloudflare Workers and D1

## Why this problem is unusually “tight” on Cloudflare edge

Running auth inside an edge deployment on Cloudflare means you’re simultaneously optimizing for (a) restrictive artifact sizes and (b) the Web-standards runtime surface (especially when you want to avoid Node-only packages and heavyweight ORMs). With the OpenNext Cloudflare adapter, Worker upload limits are a practical ceiling you will hit during “auth + DB + app” bundling, not a theoretical one: the OpenNext docs call out a 3 MiB gzipped Worker limit on the Free plan and 10 MiB on Paid plans, and recommend analyzing the produced bundle when you exceed those thresholds. citeturn20search14turn20search1

Cloudflare has also publicly described how ecosystem improvements (including better Node compatibility in Workers and a raised Worker size limit) are key to running more full-featured apps on Workers; their OpenNext adapter post explicitly notes the Worker size limit bump (e.g., from 1 MiB to 3 MiB on Free, and from 10 MiB to 15 MiB for Paid plans). citeturn20search10turn20search3

If you ever need to run auth code in a true “Edge runtime” (as opposed to “a Worker that happens to run near users”), remember that some platforms enforce very small per-function code size limits after gzip (for example, Vercel’s Edge runtime limits vary by plan and can be as low as 1 MB compressed). citeturn20search6turn20search25

That makes “very fast” not just about request latency; it’s also about: keeping dependency graphs shallow, avoiding Node polyfills, and minimizing cold-start and initialization work. Next.js itself warns that serverless functions can take “hundreds of milliseconds” to boot before processing requests, which is exactly the kind of overhead you try to avoid when you choose edge-like architectures. citeturn20search9

## The ecosystem split: protocol-only primitives vs NextAuth-like batteries

Next.js’s own guidance frames authentication as three separable concerns—authentication (identity proof), session management (state across requests), and authorization (access decisions)—which is a helpful lens for building a “protocol-only” minimal stack instead of adopting a monolithic auth framework. citeturn21search10turn21search28

### Protocol-only building blocks that are edge-friendly

Two “protocol-first” libraries show up repeatedly in edge-focused discussions because they are Web-API-centric and avoid Node-specific assumptions:

- **Arctic** positions itself as a collection of OAuth 2.0 clients for popular providers, supports only the authorization code flow, and is built on the Fetch API (a strong indicator it’s aiming at Workers/Deno/Bun and similar runtimes). citeturn16search4turn5search0  
- **oauth4webapi** explicitly presents itself as a low-level OAuth 2 / OpenID Connect client API focusing on modern best practices while using capabilities common across browser/non-browser runtimes, which aligns well with Workers constraints. citeturn7search6turn17search9

For cryptography and token work in edge runtimes, **jose** is a common choice, and its size can be kept relatively small compared with ORMs and larger auth stacks. citeturn7search7turn19search14

Finally, **Oslo** has become “the modular replacement story” around the Lucia ecosystem. The older `oslo` meta-package repository is archived/deprecated in favor of the newer Oslo project packages (for example `@oslojs/crypto`), which emphasize runtime-agnostic, zero-third-party-dependency building blocks. citeturn21search0turn21search7turn21search19

### DB access primitives that keep you in “raw SQL mode”

If “raw SQL (or SQL-first) on D1” is a hard requirement, **Kysely** is notable because it’s explicitly positioned as a thin, predictable abstraction over SQL, allows raw SQL when needed, has zero dependencies, and aims to run in any JS environment including Cloudflare Workers. citeturn21search1

Cloudflare’s own D1 “community projects” documentation highlights a community D1 dialect for Kysely and also points to “workers-qb” as a zero-dependency query builder designed to keep the speed benefits of raw queries while standardizing access. citeturn21search5

### NextAuth-like frameworks (or “auth servers”) that target edge

Among projects attempting to be “NextAuth-ish” while staying practical for edge, one option stands out as both actively developed and Cloudflare-aware today:

- **Better Auth** markets itself as a full authentication framework, but it has a strong edge story: it lists integrations for multiple environments (including Cloudflare Workers-style Request/Response) and has specific optimization guidance for bundle size. citeturn7search12turn12search13turn6search0

On the community side, there are also “auth-as-a-service you self-host” repos like **OpenPass** that describe a NextAuth-like data model and offer a React `useSession()`-style SDK. However, repositories like this often optimize for “auth backend product” completeness (providers, admin, JWT/cookie strategies) rather than Cloudflare-D1-first minimalism, and may be far less mature than mainstream libraries. citeturn23view1

There are also Cloudflare-native user/session frameworks (for example, a two-Worker split using KV for session state and D1 for user persistence), but these are not Next.js-native nor NextAuth-API-compatible out of the box. citeturn23view0

image_group{"layout":"carousel","aspect_ratio":"16:9","query":["Cloudflare Workers architecture diagram","Cloudflare D1 database logo","Next.js server components diagram","OAuth 2.0 authorization code flow diagram"],"num_per_query":1}

## Cloudflare D1 + raw SQL: what “compatible” really means

At the lowest level, D1 access from Workers is built around prepared statements (`prepare`), parameter binding (`bind`), and execution methods; Cloudflare’s Workers Binding API documentation describes this flow directly. citeturn24search1

Two D1-specific constraints are especially relevant to auth libraries:

1. **Atomic multi-statement work is generally done via `batch()`**. Cloudflare’s D1 database docs state that batched statements are SQL transactions and that failures roll back the sequence. citeturn24search4  
2. **You should assume “interactive transaction” semantics are not available the way they are in traditional server DB drivers**, which is why tooling and libraries often route multi-step atomicity through `batch()` or other platform-specific constructs. Better Auth’s Cloudflare-focused release notes explicitly call out that D1 does not support interactive transactions and that it uses `batch()` for atomicity. citeturn24search24turn6search0

Those constraints strongly favor libraries that:
- Either use D1’s native API directly (raw SQL-friendly), or  
- Have an adapter/dialect that is explicitly D1-aware (not “SQLite in name only”).

### Baseline: Auth.js D1 adapter is already raw-SQL oriented

Even though your goal is to find alternatives, it helps to treat Auth.js’s D1 adapter as the baseline for “what good looks like” in D1/SQL terms.

Auth.js’s D1 adapter documentation provides a migration helper that yields the schema (users, accounts, sessions, verification_tokens) as SQL statements intended to be executed against D1. citeturn0search15turn4search23  
It also flags limitations such as table prefix configuration not being supported in the D1 adapter. citeturn0search14

### Better Auth: native Cloudflare D1 support, plus an escape hatch to raw SQL

Better Auth’s 1.5 release notes explicitly claim “first-class” Cloudflare D1 support: you can pass the D1 binding directly, with auto-detection and a built-in dialect for query execution, batching, and introspection. citeturn6search0turn24search24

On the “raw SQL” axis, there are two important compatibility points:

- Better Auth’s adapter story includes “other relational databases” via Kysely dialects, meaning it is architected around a SQL-first core rather than requiring a specific heavyweight ORM. citeturn6search1turn6search2  
- There is documented community guidance that you can implement a custom DB adapter (CRUD/transaction-like methods) using raw SQL clients, which provides an explicit path if you want to bypass any ORM/query-builder layer. citeturn6search3

Better Auth also describes how its config can map table/column names (modelName/fields) and extend schemas, which matters if you want compatibility with an existing NextAuth-like schema or a minimal subset. citeturn6search9turn6search2

### Lucia Auth: technically workable on D1, but no longer a “reliable library choice”

Lucia’s older D1 adapter documentation shows a clean pattern: because D1 bindings are only available at runtime, you create the auth instance per request and use the D1 adapter from `@lucia-auth/adapter-sqlite`. citeturn22search4turn22search8

However, Lucia v3 is explicitly slated for deprecation (by March 2025), and the maintainer’s announcement makes it clear the project is shifting from “library” to “learning resource,” with adapters being deprecated and examples/docs no longer actively updated. citeturn5search0turn5search3  
Given your requirement of “most reliable,” this deprecation status is a hard blocker for recommending Lucia as the core dependency for a new production codebase—even if the patterns remain valuable. citeturn5search16turn5search9

### Evidence of community “mini schema” implementations on D1

You asked specifically for GitHub evidence of minimal subsets that mirror NextAuth’s Users/Accounts/Sessions database model. One concrete example is a repo that includes a `schema.sql` labeled “NextAuth.js required tables for D1,” defining `users`, `accounts`, `sessions`, and `verification_tokens` with the typical NextAuth column names (`sessionToken`, `providerAccountId`, etc.). citeturn23view2

This kind of schema file is valuable even if you don’t adopt the surrounding app, because it demonstrates “raw SQL on D1” patterns and reinforces that the NextAuth schema can be implemented directly without an ORM. citeturn23view2turn24search21

## “NextAuth API parity”: what is feasible to match quickly

### What NextAuth exposes in practice

For most Next.js apps, “instant replacement” tends to mean preserving three touchpoints:

- A client hook: `useSession()` (typically used under a provider component like `<SessionProvider>`). citeturn2search25turn2search7  
- A server/client session fetch method: `getSession()` style behavior (server-friendly access to current user/session). citeturn2search13turn2search7  
- A single configuration object passed to an initializer (v5+ is a rewrite, but the pattern remains “one auth entrypoint that produces handlers + helpers”). citeturn2search35turn4search25

Also relevant for performance: NextAuth’s SessionProvider/client hook approach has been reported (by users) to produce multiple session-fetch requests even when the hook isn’t used, which can matter if you’re trying to be “very fast” on cold loads. citeturn3search9

### Better Auth’s surface area vs NextAuth’s surface area

Better Auth offers both a server-side `getSession` capability and client-side access patterns that look familiar to NextAuth users:

- Its docs show a client `getSession` method and a server-side `auth.api.getSession({ headers })` pattern (which is particularly compatible with Next.js App Router where you can get request headers). citeturn2search10turn2search21  
- It has a framework-aware mounting story for Next.js via request handlers (for example, exporting `GET`/`POST` handlers for a catch-all auth route). citeturn7search12turn2search18  
- It also describes a client library that standardizes methods/hooks across framework integrations, which is the closest conceptual parallel to “next-auth/react” in terms of DX. citeturn8search7turn2search10

What Better Auth does **not** offer (as a strict drop-in) is direct API compatibility with `NextAuth({ ...options })` configuration shape. The conceptual mapping is “possible” (providers, session strategy, callbacks), but the config object is different, and NextAuth’s provider adapter ecosystem is a major part of that shape. citeturn2search35turn7search12

### Protocol-only stacks and parity

If you choose the truly minimalist path—e.g., `oauth4webapi` or Arctic for OAuth/OIDC plus raw SQL for session persistence—you’ll get excellent runtime control and minimal dependency footprint, but you will have to build your own `useSession`/`getSession` ergonomics. citeturn7search6turn16search4turn21search10

The good news is that “session management as a small library” is viable; the bad news is that edge compatibility is subtle. For example, iron-session is often cited as Edge-friendly, but there are real reports that `session.save()` in Next.js middleware fails due to Edge Response object differences, illustrating the kind of mismatch you must design around if you want middleware-based session refresh. citeturn21search2turn21search6

## Performance findings that matter for “very fast” auth on Workers

### Bundle size: concrete numbers for protocol primitives

When your auth layer is “protocol-only,” bundle cost is often dominated by crypto, OIDC/OAuth parsing, and whatever session code you add.

Two useful reference points from Bundlephobia:

- `oauth4webapi@3.8.3`: ~51.4 kB minified / ~14.0 kB min+gzip. citeturn7search2  
- `jose@6.1.0`: ~66.5 kB minified / ~16.9 kB min+gzip. citeturn7search7  

These sizes are typically “cheap enough” to fit comfortably under Worker limits if you’re careful elsewhere, especially compared to ORM-like dependencies that are often the main size offenders in edge bundles. citeturn20search14turn20search6

### Bundle size: what Better Auth does to support edge constraints

Better Auth explicitly documents a “minimal” entrypoint (`better-auth/minimal`) intended to reduce bundle size by excluding Kysely (which Better Auth says is only needed when using direct database connections). This is directly aligned with your requirement to minimize cold-start and bundle pressure—especially if you plan to use an adapter mode or an external DB layer. citeturn12search13turn6search2

There is also direct community signal that bundle size changes are tracked and sometimes controversial (for example, a reported ~4.5 kB client bundle growth between minor versions), which suggests performance is an active concern rather than an afterthought. citeturn8search13

### Cloudflare limits + cold start: why “fewer deps” is often the winning strategy

On Cloudflare Workers via OpenNext, keep the Worker gzipped size limit (3 MiB Free / 10 MiB Paid per OpenNext docs) as the primary constraint, and treat any dependency that drags in Node polyfills as suspect. citeturn20search14turn20search1

When you consider platform behavior like serverless boot time (hundreds of ms) and edge size caps, the fastest auth stack is usually the one that:
- avoids big transitive dependencies,
- keeps auth endpoints simple (cookie parsing + D1 lookup),
- and avoids re-instantiating heavy objects per request. citeturn20search9turn24search1turn24search14

This is also why SQL-first tooling like Kysely and direct D1 prepared statements are attractive: they keep you close to the platform, reduce dependency graphs, and offer a straightforward performance mental model. citeturn21search1turn24search1turn21search5

## Synthesis and recommendation: the best match to “auth-only, D1/SQL, NextAuth-ish APIs”

### Recommended “small-footprint + reliable” choice: Better Auth with native D1, plus a thin NextAuth-compat layer in your app

Based on the constraints you gave (Cloudflare Workers + D1, raw SQL preference, very fast, and high NextAuth API parity), **Better Auth (v1.5+) is the closest option that is both:**
- actively maintained,
- explicitly Cloudflare D1-aware (binding passed directly, D1 dialect, batch usage),
- and already provides `useSession`/`getSession`-style primitives that reduce migration pain. citeturn6search0turn2search10turn2search21

To keep it “auth-only” and lightweight, the most relevant architectural pattern is:

- Use Better Auth’s minimal build where applicable to reduce server bundle cost. citeturn12search13turn20search14  
- Use its Cloudflare D1 support so you’re not forced into Prisma-like tooling that tends to be incompatible or heavy in edge runtimes. citeturn6search0turn20search25turn24search2  
- Implement **a compatibility shim** at your app boundary that exposes the three NextAuth-like touchpoints your code actually uses:
  - a `useSession()` hook (delegate to Better Auth’s client hook),
  - a `getSession()` function (delegate to Better Auth’s client/server getSession),
  - and a single exported “auth object” pattern (even if the underlying configuration differs). citeturn8search7turn2search10turn7search12  

This approach usually yields the highest “instant replacement” value because most app code touches only those three surfaces, not the full NextAuth provider/callback surface. citeturn2search25turn2search13turn2search35

### Best “pure protocol + maximal minimalism” pattern: oauth4webapi or Arctic + raw D1 tables that mirror NextAuth

If you are willing to trade DX for maximal control and minimal bundle size, the most future-proof pattern (especially given Lucia’s deprecation) is:

- **OAuth/OIDC** via `oauth4webapi` (or provider-specific clients via Arctic). citeturn7search6turn16search4  
- **Crypto/JWT/JWKS** via `jose` or modular Oslo packages where appropriate. citeturn7search7turn21search7turn21search19  
- **Sessions in D1** using raw SQL tables that intentionally mirror the NextAuth schema (Users, Accounts, Sessions, Verification Tokens), with atomic multi-step writes batched via `DB.batch()`. citeturn23view2turn24search4turn24search1  

This is also where your “mini-next-auth” requirement is most naturally satisfied: you can literally adopt the minimal schema (as demonstrated in community `schema.sql` examples) and implement only:
- `createSession(userId)`,
- `getSession(sessionToken)`,
- `linkAccount(provider, providerAccountId, userId)`,
- and `getUserByAccount(provider, providerAccountId)`. citeturn23view2turn24search21  

From there, implement a tiny NextAuth-like API facade (`useSession` calling `/api/auth/session`, `getSession` reading cookies on the server, and one config object controlling cookie names and providers). This follows Next.js’s own “separate authentication from session management” framing, and it keeps the dependency set extremely small. citeturn21search10turn20search14turn7search2

### Why Lucia is not recommended as the core, even though the design is relevant

Lucia’s patterns (DB-backed sessions, small core, “instantiate per request” for D1 bindings) remain educationally valuable. citeturn22search4turn22search17  
But the explicit deprecation plan for Lucia v3 and its adapters makes it a poor fit for your “most reliable” requirement, especially when you’re building a foundational auth layer. citeturn5search0turn5search3