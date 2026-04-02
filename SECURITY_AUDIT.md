# Security Audit Report — @1moby/just-auth

**Date:** 2026-04-02
**Auditor:** Automated security review (Claude)
**Scope:** Full codebase — OAuth, sessions, cookies, credentials, RBAC, database layer
**Test result after fixes:** 285/285 tests passing (including 90 dedicated security tests)

---

## Summary Table

| # | Severity | Vulnerability | File | Status |
|---|----------|--------------|------|--------|
| 1 | **MEDIUM** | Script injection via `</script>` in HTML redirect | `src/server/handlers.ts` | **Fixed** |
| 2 | **MEDIUM** | Error message leak in `handleSetRole` | `src/server/handlers.ts` | **Fixed** |
| 3 | **MEDIUM** | No secondary CSRF defense for POST endpoints | `src/server/handlers.ts` | **Fixed** |
| 4 | **LOW** | Missing Content-Security-Policy on HTML redirects | `src/server/handlers.ts` | **Fixed** |
| 5 | **LOW** | `timingSafeEqual` early return on length mismatch | `src/server/handlers.ts` | **Fixed** |
| 6 | **MEDIUM** | OAuth access/refresh tokens stored in plaintext | `src/db/queries.ts` | Needs discussion |
| 7 | **LOW** | No rate limiting on auth endpoints | `src/server/handlers.ts` | By design (app layer) |
| 8 | **INFO** | Fragile cookie clearing via string replace | `src/server/handlers.ts` | Noted |

---

## Detailed Findings

### 1. MEDIUM — Script Injection via `</script>` in HTML Redirect

- **Location:** `src/server/handlers.ts:htmlRedirectWithCookies` (line ~93)
- **Risk:** `JSON.stringify()` does not escape forward slashes. A redirect URL containing `</script>` (e.g., from a developer's `onAuthSuccess` callback returning a path with user-controlled query params) would break out of the `<script>` tag in the HTML redirect page, enabling XSS. Example: `/callback?x=</script><script>alert(document.cookie)</script>` would close the legitimate script block and inject attacker-controlled JavaScript.
- **Fix applied:** All `<` characters in the JSON-serialized URL are now escaped as `\u003c` (valid JS Unicode escape, safe in HTML). This prevents `</script>` from appearing in the script context regardless of the URL content.

### 2. MEDIUM — Error Message Leak in `handleSetRole`

- **Location:** `src/server/handlers.ts:handleSetRole` catch block (line ~638)
- **Risk:** Internal error messages (database errors, type errors, stack traces) were directly exposed to the client via `error.message`. An attacker could trigger errors to learn about database structure, adapter implementation, or internal endpoints. Example: a malformed request could cause a TypeError that reveals column names or table structure.
- **Fix applied:** Replaced `error.message` with a generic `"Failed to set role"` string. The full error is now logged server-side via `console.error` for debugging. This matches the pattern already used in `handleRegister` and `handleCredentialsLogin`.

### 3. MEDIUM — No Secondary CSRF Defense for POST Endpoints

- **Location:** `src/server/handlers.ts:handleRequest` (all POST routes)
- **Risk:** All state-changing POST endpoints (`/logout`, `/register`, `/callback/credentials`, `/role`) relied solely on `SameSite=Lax` cookies for CSRF protection. This fails in two scenarios: (a) the library user configures `sameSite: "none"` (allowed by the API), removing all browser CSRF protection; (b) older browsers (pre-2020) that don't support `SameSite` cookies. An attacker could craft a cross-origin form POST to these endpoints and the session cookie would be sent.
- **Fix applied:** Added `verifyCsrfOrigin()` check before all POST route handlers. This validates the `Origin` header (or `Referer` as fallback) matches the request's origin. Non-browser clients (no Origin/Referer) are allowed through, maintaining compatibility with server-to-server usage and curl.

### 4. LOW — Missing Content-Security-Policy on HTML Redirects

- **Location:** `src/server/handlers.ts:htmlRedirectWithCookies` (line ~97)
- **Risk:** The HTML redirect pages contained an inline `<script>` tag for `window.location.href` but had no Content-Security-Policy header. While the pages are transient and the redirect URL is validated, a missing CSP means any injected content would execute without restriction. Combined with Finding #1 (before fix), this would have enabled full XSS exploitation.
- **Fix applied:** Added `Content-Security-Policy: default-src 'none'; script-src 'unsafe-inline'; style-src 'none'; img-src 'none'; frame-ancestors 'none'`. This restricts the page to only execute inline scripts (needed for the redirect), blocks all external resource loading, and prevents framing.

### 5. LOW — `timingSafeEqual` Early Return on Length Mismatch

- **Location:** `src/server/handlers.ts:timingSafeEqual` (line ~27)
- **Risk:** The original implementation returned `false` immediately when input lengths differed, leaking length information through response timing. While not exploitable in the current OAuth state comparison (both values are always 43-character base64url-encoded 32-byte arrays), this is fragile: if the function were reused for comparing user-supplied tokens of variable length, an attacker could determine the expected token length through timing analysis.
- **Fix applied:** Both inputs are now hashed with SHA-256 before comparison, normalizing them to fixed 32-byte values. This eliminates any length-based timing leak regardless of input sizes. The function is now async (SHA-256 via Web Crypto API), and the single call site in `handleCallback` was updated accordingly.

### 6. MEDIUM — OAuth Access/Refresh Tokens Stored in Plaintext

- **Location:** `src/db/queries.ts:createAccount` (line ~186)
- **Risk:** OAuth access tokens and refresh tokens are stored as plaintext in the `accounts` table. If the database is compromised (SQL injection elsewhere, backup leak, insider threat), an attacker gains direct access to users' OAuth provider accounts (GitHub, Google, LINE). Refresh tokens are especially dangerous as they provide persistent access.
- **Fix applied:** None — **needs discussion**. Encrypting tokens at rest requires a server-side encryption key, which introduces key management complexity (key rotation, secure storage, per-environment keys). Options:
  - (a) Add AES-GCM encryption using Web Crypto API with a user-provided `tokenEncryptionKey` config option
  - (b) Document the risk and recommend database-level encryption (e.g., Cloudflare D1 encryption at rest, PostgreSQL pgcrypto)
  - (c) Omit storing tokens entirely (only store what's needed for auth, not API access)

### 7. LOW — No Rate Limiting on Auth Endpoints

- **Location:** All auth endpoints in `src/server/handlers.ts`
- **Risk:** No rate limiting on `/register`, `/callback/credentials`, or `/role` endpoints. An attacker could perform credential stuffing or brute-force attacks. The PBKDF2 cost (600k iterations) provides some protection by making each attempt expensive, but doesn't prevent distributed attacks.
- **Fix applied:** None — **by design**. Rate limiting is an application-level concern that depends on the deployment environment (Cloudflare Rate Limiting, nginx `limit_req`, application middleware). The library intentionally leaves this to the consumer. Recommended: document rate limiting guidance in the README.

### 8. INFO — Fragile Cookie Clearing via String Replace

- **Location:** `src/server/handlers.ts:handleCallback` (line ~342)
- **Risk:** State cookies are cleared using `.replace("Max-Age=600", "Max-Age=0")` on the serialized cookie string. If `serializeStateCookie` ever changes its format (e.g., different Max-Age value, different attribute order), this replacement would silently fail and the state cookies would persist for their full 10-minute lifetime. Not a security vulnerability per se, but could lead to stale state cookies being present during subsequent OAuth flows.
- **Fix applied:** None — noted for future improvement. A dedicated `clearStateCookie(name, config)` function would be more robust.

---

## What Was Already Secure (Positive Findings)

The codebase demonstrates strong security practices across most areas:

| Area | Implementation | Assessment |
|------|---------------|------------|
| **Password hashing** | PBKDF2-SHA256, 600k iterations, 16-byte random salt | Meets NIST SP 800-132 (2024) |
| **Password comparison** | `constantTimeEqual()` on Uint8Array in `password.ts` | Correct constant-time implementation |
| **Session tokens** | 32 random bytes (256 bits entropy), base64url | Sufficient entropy, no predictability |
| **Session storage** | SHA-256 hash stored, not plaintext token | DB breach doesn't expose valid tokens |
| **Session expiry** | Server-side validation + sliding window (30d/15d) | Not relying on cookie TTL alone |
| **Cookie security** | `HttpOnly`, `Secure`, `SameSite=Lax`, `__Host-` prefix | Best-practice defaults |
| **OAuth state** | 32 random bytes, HttpOnly cookie, 10-min TTL | Strong CSRF protection for OAuth flow |
| **PKCE** | S256 code challenge on all providers (Google, GitHub, LINE) | Prevents authorization code interception |
| **SQL injection** | All queries use parameterized `?` placeholders with `.bind()` | No string interpolation of user input |
| **Table prefix** | Validated with `/^[a-zA-Z0-9_]*$/` regex | Prevents SQL injection via prefix |
| **Open redirect** | `isSafeRedirect()` checks same-origin or relative path | Blocks external redirect via `onAuthSuccess` |
| **HTML escaping** | `escapeHtmlAttr()` for HTML attribute contexts | Prevents XSS in meta refresh `content` |
| **Timing oracle** | Dummy hash verification for non-existent users | Login timing doesn't reveal user existence |
| **User enumeration** | Generic error messages for login/registration failures | No email existence disclosure |
| **Password DoS** | `MAX_PASSWORD_LENGTH = 128` enforced at handler level | Prevents PBKDF2 CPU exhaustion |
| **Error messages** | Generic errors in login/register (only leaked in `handleSetRole` — now fixed) | No internal detail disclosure |
| **Security headers** | `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store` | Strong header set on redirect pages |

---

## Test Coverage

**285 tests passing** across 17 test files (including 5 dedicated security test files with 90 security-specific tests).

> **Note:** This project uses session tokens (not JWT) and Origin-header CSRF verification (not token-based), so JWT and token-based CSRF test categories are not applicable.

| Category | File | Tests | What's Covered |
|----------|------|-------|----------------|
| **OAuth** | `tests/security-oauth.test.ts` | 26 | Open redirect prevention (14 malicious URL variants: `https://evil.com`, `//evil.com`, `legit.com.evil.com`, `javascript:`, `data:`, encoded), safe redirect acceptance, state param randomness/uniqueness/rejection (missing/tampered/no-code/no-cookie), state cookie HttpOnly + TTL, PKCE verifier generation, S256 challenge consistency, GitHub/Google provider PKCE params, code_verifier cookie storage, fresh verifier per request |
| **Session** | `tests/security-session.test.ts` | 17 | Cookie flags (HttpOnly, Secure, SameSite=Lax/Strict, `__Host-` prefix, Path=/), token entropy (256-bit, base64url), SHA-256 hash storage (not plaintext), session ID rotation on login, expired session rejection (server-side), sliding window extension, session invalidation on logout, cookie clearing |
| **CSRF** | `tests/security-csrf.test.ts` | 10 | Cross-origin POST rejection on all endpoints (logout, register, credentials, role), subdomain/port/scheme mismatch rejection, Referer fallback (cross-origin rejected, same-origin allowed), non-browser client bypass (no Origin/Referer), GET requests bypass CSRF check |
| **Enumeration** | `tests/security-enumeration.test.ts` | 8 | Identical status/body/error for non-existent user vs wrong password, generic registration error for duplicate email, timing oracle prevention (dummy PBKDF2 for ghost users), no internal detail leaks in errors, constant-time comparison meta-test (grep for `===`/`==` near hash/token patterns), presence of `timingSafeEqual`/`constantTimeEqual` in source |
| **Injection** | `tests/security-injection.test.ts` | 19 | SQL injection in login email (10 payloads: `' OR 1=1 --`, `'; DROP TABLE`, `UNION SELECT`, etc.), SQL injection in registration email, SQL payload in password field (hashed not interpolated), parameterized query meta-test (no non-table interpolation in SQL), table prefix validation (blocks `'; DROP TABLE`), NoSQL-style injection (`{$gt:""}`, null, array), XSS payload storage (literal not executed) |
| **XSS/Headers** | `tests/security.test.ts` | 10 | `</script>` injection prevention (`\u003c` escaping), HTML attribute escaping, security headers (CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Cache-Control), error message leak prevention (OAuth callback, set-role endpoint) |

### Not Tested (by design)

| Category | Reason |
|----------|--------|
| **JWT** | Project uses session tokens, not JWT — no JWT code exists to test |
| **Token-based CSRF** | Project uses Origin header verification, not CSRF tokens |
| **Rate limiting** | Intentionally left to the application layer (Finding #7) |
| **Token encryption at rest** | Not yet implemented (Finding #6 — needs discussion) |

---

## Recommendations (Not Vulnerabilities)

1. **Document rate limiting guidance** — Add a section to README explaining that consumers should implement rate limiting at the proxy/middleware layer for `/register` and `/callback/credentials`.
2. **Add `clearStateCookie()` helper** — Replace the fragile `.replace("Max-Age=600", "Max-Age=0")` pattern with a dedicated function.
3. **Consider token encryption at rest** — For high-security deployments, add optional AES-GCM encryption for stored OAuth tokens.
4. **Add session revocation API** — Expose `deleteUserSessions(userId)` as a public API method so consumers can revoke all sessions on password change or account compromise.
5. **Log security events** — Emit structured events for failed logins, CSRF blocks, and OAuth errors to enable security monitoring.
