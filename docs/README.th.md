# react-auth

ไลบรารี Authentication สำหรับ React ที่เบาและทำงานบน Edge Runtime ได้ — ทางเลือกแทน NextAuth

ใช้ [Arctic](https://arcticjs.dev/) สำหรับ OAuth, raw SQL สำหรับ D1/SQLite และ API ที่คุ้นเคยแบบ NextAuth (`useSession`, `SessionProvider`, `signIn`, `signOut`)

## คุณสมบัติ

- รองรับ OAuth 2.0 + PKCE ผ่าน Arctic (65+ providers)
- มี provider สำเร็จรูป: Google, GitHub, LINE
- รองรับ Email/Password (credentials) authentication ด้วย PBKDF2-SHA256 (Web Crypto API, ไม่ต้องพึ่ง dependency เพิ่ม)
- Account linking อัตโนมัติโดยใช้ email เป็น key — login จากหลาย provider ด้วย email เดียวกันจะเชื่อมเป็น user เดียว
- RBAC (Role-Based Access Control) แบบ optional — กำหนด role + permissions ใน config, ไม่ต้องสร้างตารางเพิ่ม
- NextAuth-compatible: `allowDangerousEmailAccountLinking`, `OAuthAccountNotLinked` error, `signIn("credentials")`, `signUp()`
- Session management แบบ sliding window (30 วัน, ต่ออายุเมื่อเหลือ < 15 วัน)
- Hash session token ด้วย SHA-256 ก่อนเก็บใน DB (Copenhagen Book pattern)
- ใช้ raw SQL ที่เข้ากันได้กับ Cloudflare D1, bun:sqlite, หรือ SQLite driver ใดก็ได้
- React client: `SessionProvider`, `useSession()`, `signIn()`, `signOut()`, `signUp()`
- Server: `auth(request)` สำหรับตรวจสอบ session, `handleRequest(request)` สำหรับ route handler
- Framework-agnostic — ทำงานกับ standard `Request`/`Response`
- ขนาดเล็ก ไม่พึ่ง Node.js-specific dependencies

## ติดตั้ง

```bash
bun add react-auth
```

Dependencies ที่จำเป็น (ติดตั้งอัตโนมัติ):
- `arctic` — OAuth 2.0 client
- `@oslojs/crypto` — SHA-256 hashing
- `@oslojs/encoding` — Base64url encoding

## เริ่มต้นใช้งาน

### 1. ตั้งค่า Database

react-auth ใช้ 3 ตาราง — รัน migration อัตโนมัติหรือสร้างเองก็ได้:

```sql
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE,
  name TEXT,
  avatar_url TEXT,
  password_hash TEXT,
  role TEXT NOT NULL DEFAULT 'user'
);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  provider_user_id TEXT NOT NULL,
  access_token TEXT,
  refresh_token TEXT,
  expires_at INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_accounts_provider ON accounts(provider_id, provider_user_id);
CREATE INDEX IF NOT EXISTS idx_accounts_user ON accounts(user_id);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
```

### 2. ตั้งค่า Server

```ts
import {
  createReactAuth,
  createGoogleProvider,
  createLineProvider,
  createGitHubProvider,
  migrate,
} from "react-auth";

// สร้าง database adapter (ตัวอย่างสำหรับ Cloudflare D1)
function createD1Adapter(db: D1Database): DatabaseAdapter {
  return {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          const stmt = db.prepare(sql).bind(...params);
          return {
            async run() {
              await stmt.run();
              return { success: true };
            },
            async first<T>() {
              return await stmt.first<T>();
            },
            async all<T>() {
              const result = await stmt.all<T>();
              return { results: result.results };
            },
          };
        },
      };
    },
    async batch(statements) {
      for (const stmt of statements) await stmt.run();
      return [];
    },
  };
}

// รัน migration (ครั้งเดียว)
await migrate(db);

// สร้าง auth instance
const auth = createReactAuth({
  providers: [
    createGoogleProvider({
      clientId: env.AUTH_GOOGLE_ID,
      clientSecret: env.AUTH_GOOGLE_SECRET,
      redirectURI: "https://example.com/api/auth/callback/google",
    }),
    createLineProvider({
      clientId: env.LINE_CLIENT_ID,
      clientSecret: env.LINE_CLIENT_SECRET,
      redirectURI: "https://example.com/api/auth/callback/line",
    }),
    createGitHubProvider({
      clientId: env.AUTH_GITHUB_ID,
      clientSecret: env.AUTH_GITHUB_SECRET,
      redirectURI: "https://example.com/api/auth/callback/github",
    }),
  ],
  database: db,
  cookie: { secure: true },

  // เปิดใช้ email/password authentication
  credentials: true,

  // เปิดใช้การเชื่อมบัญชีอัตโนมัติด้วย email เดียวกัน
  allowDangerousEmailAccountLinking: true,
});

// จัดการ auth routes
const response = await auth.handleRequest(request);
if (response) return response;
```

### 3. ป้องกัน Server Routes

```ts
// ตรวจสอบ session ในทุก route handler
const session = await auth.auth(request);
if (!session) {
  return new Response("Unauthorized", { status: 401 });
}
console.log(session.user); // { id, email, name, avatarUrl }
```

### 4. React Client

```tsx
import { SessionProvider, useSession, signIn, signOut } from "react-auth/client";

// ครอบ app ด้วย SessionProvider
function App() {
  return (
    <SessionProvider basePath="/api/auth">
      <YourApp />
    </SessionProvider>
  );
}

// ใช้ในทุก component
function Profile() {
  const { data, status } = useSession();

  if (status === "loading") return <p>กำลังโหลด...</p>;
  if (status === "unauthenticated") return <button onClick={() => signIn("google")}>เข้าสู่ระบบ</button>;

  return (
    <div>
      <p>สวัสดี, {data.user.name}</p>
      <button onClick={() => signOut()}>ออกจากระบบ</button>
    </div>
  );
}
```

### 5. Email/Password Authentication

```tsx
import { signIn, signUp } from "react-auth/client";

// สมัครสมาชิก
const res = await signUp({ email: "user@example.com", password: "secret123", name: "ชื่อ" });
if (res.ok) {
  // สมัครสำเร็จ — session cookie ถูกตั้งค่าอัตโนมัติ
}

// เข้าสู่ระบบด้วย email/password
const res = await signIn("credentials", { email: "user@example.com", password: "secret123" });
if (res.ok) {
  // เข้าสู่ระบบสำเร็จ
}
```

### 6. Account Linking (การเชื่อมบัญชี)

เมื่อเปิด `allowDangerousEmailAccountLinking: true`:
- ผู้ใช้สมัครด้วย email/password → login ด้วย Google (email เดียวกัน) → บัญชีจะเชื่อมอัตโนมัติ
- Session endpoint จะส่ง `accounts` array กลับมาด้วย แสดง provider ทั้งหมดที่เชื่อมอยู่

```tsx
const { data } = useSession();
// data.accounts = [{ providerId: "credentials" }, { providerId: "google" }]
```

เมื่อปิด (default) จะส่ง error `OAuthAccountNotLinked` เมื่อ email ซ้ำกับ provider อื่น

### 7. RBAC (Role-Based Access Control)

เปิดใช้โดยเพิ่ม `rbac` config:

```ts
const auth = createReactAuth({
  // ...existing config...
  rbac: {
    statements: {
      post: ["create", "read", "update", "delete"],
      user: ["list", "ban", "set-role"],
    },
    roles: {
      user: { post: ["read"] },
      editor: { post: ["create", "read", "update"] },
      admin: "*",  // wildcard = ทุก permission
    },
    defaultRole: "user",
  },
});
```

**Server-side:**
```ts
// ตรวจสอบ permission
const canEdit = await auth.hasPermission(request, "post:update");  // boolean
const isAdmin = await auth.hasRole(request, "admin");              // boolean
```

**Client-side:**
```tsx
import { usePermission, useRole } from "react-auth/client";

function PostEditor() {
  const canEdit = usePermission("post:update");
  if (!canEdit) return <p>ไม่มีสิทธิ์</p>;
  return <Editor />;
}

function AdminPanel() {
  const isAdmin = useRole("admin");
  if (!isAdmin) return null;
  return <AdminDashboard />;
}
```

**Admin endpoint:**
```ts
// POST /api/auth/role — ต้องมี user:set-role permission
fetch("/api/auth/role", {
  method: "POST",
  body: JSON.stringify({ userId: "target-user-id", role: "admin" }),
});
```

- Permissions กำหนดใน code (type-safe) ไม่ต้องสร้างตารางเพิ่ม
- เมื่อไม่ได้เปิด `rbac` config จะไม่มี overhead ใดๆ
- Migration เพิ่ม `role` column อัตโนมัติ (idempotent — เปิดใช้ทีหลังได้)

## Database Schema

```
┌─────────────────────────┐
│         users           │
├─────────────────────────┤
│ id             TEXT    PK  │
│ email          TEXT  UQ    │
│ name           TEXT        │
│ avatar_url     TEXT        │
│ password_hash  TEXT        │
│ role           TEXT  DF    │
└──────────┬─────────────────┘
           │ 1
           │
           │ N
┌──────────┴──────────────┐     ┌─────────────────────────┐
│       accounts          │     │       sessions          │
├─────────────────────────┤     ├─────────────────────────┤
│ id               TEXT PK│     │ id          TEXT    PK  │
│ user_id          TEXT FK│──┐  │ user_id     TEXT    FK  │──┐
│ provider_id      TEXT   │  │  │ expires_at  INTEGER     │  │
│ provider_user_id TEXT   │  │  └─────────────────────────┘  │
│ access_token     TEXT   │  │                               │
│ refresh_token    TEXT   │  └───────────────┐               │
│ expires_at       INTEGER│                  │               │
└─────────────────────────┘                  ▼               ▼
                                         users.id        users.id

Indexes:
  idx_accounts_provider  ON accounts(provider_id, provider_user_id)
  idx_accounts_user      ON accounts(user_id)
  idx_sessions_user      ON sessions(user_id)
```

- **users** — ข้อมูลผู้ใช้ สร้างอัตโนมัติตอน OAuth login ครั้งแรก
- **accounts** — เชื่อมผู้ใช้กับ OAuth provider (1 user มีหลาย provider ได้)
- **sessions** — session token ที่ hash แล้ว พร้อมเวลาหมดอายุ

## Auth Routes

react-auth สร้าง route เหล่านี้อัตโนมัติ (default basePath: `/api/auth`):

| Route | Method | คำอธิบาย |
|-------|--------|----------|
| `/api/auth/login/:provider` | GET | redirect ไปหน้า OAuth ของ provider |
| `/api/auth/callback/:provider` | GET | รับ callback จาก provider, สร้าง session |
| `/api/auth/callback/credentials` | POST | เข้าสู่ระบบด้วย email/password (ต้องเปิด `credentials: true`) |
| `/api/auth/register` | POST | สมัครสมาชิกด้วย email/password (ต้องเปิด `credentials: true`) |
| `/api/auth/session` | GET | ส่งคืนข้อมูล session + linked accounts + permissions (JSON) |
| `/api/auth/role` | POST | ตั้ง role ของ user (ต้องมี `user:set-role` permission, ต้องเปิด `rbac`) |
| `/api/auth/logout` | GET | ลบ session และ redirect กลับ `/` |

## Session Management

- Token สร้างจาก 32 random bytes, encode เป็น base64url
- เก็บใน DB เป็น SHA-256 hash (ไม่เก็บ token ดิบ)
- Cookie: `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`
- Sliding window: session อายุ 30 วัน, ต่ออายุอัตโนมัติเมื่อเหลือ < 15 วัน
- State cookie สำหรับ OAuth CSRF protection (อายุ 10 นาที)
- PKCE code verifier เก็บใน cookie สำหรับ Google/LINE

## ตั้งค่าได้

```ts
createReactAuth({
  providers: [...],
  database: db,

  // เปลี่ยน base path (default: "/api/auth")
  basePath: "/auth",

  // ตั้งค่า cookie
  cookie: {
    name: "my_session",      // default: "auth_session"
    secure: true,            // default: true
    sameSite: "lax",         // default: "lax"
    domain: ".example.com",  // สำหรับ subdomain sharing
    path: "/",               // default: "/"
  },

  // ตั้งค่า session
  session: {
    maxAge: 60 * 86400,          // 60 วัน (default: 30 วัน)
    refreshThreshold: 20 * 86400, // ต่ออายุเมื่อเหลือ 20 วัน (default: 15 วัน)
  },
});
```

## SessionProvider Options

```tsx
<SessionProvider
  basePath="/api/auth"        // ต้องตรงกับ server basePath
  refetchOnWindowFocus={true} // โหลด session ใหม่เมื่อกลับมาที่ tab (default: true)
>
  <App />
</SessionProvider>
```

## ตัวอย่างการใช้งานกับ Cloudflare Workers

ดูตัวอย่างเต็มได้ที่ `sample-auth/` directory

```ts
// worker.ts
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const db = createD1Adapter(env.DB);

    if (!migrated) {
      await migrate(db);
      migrated = true;
    }

    const auth = createReactAuth({
      providers: [
        createGoogleProvider({
          clientId: env.AUTH_GOOGLE_ID,
          clientSecret: env.AUTH_GOOGLE_SECRET,
          redirectURI: `${env.BASE_URL}/api/auth/callback/google`,
        }),
      ],
      database: db,
      cookie: { secure: true },
    });

    const authResponse = await auth.handleRequest(request);
    if (authResponse) return authResponse;

    return env.ASSETS.fetch(request);
  },
};
```

wrangler.jsonc:
```jsonc
{
  "name": "my-app",
  "main": "worker.ts",
  "assets": {
    "directory": "./dist",
    "binding": "ASSETS",
    "not_found_handling": "single-page-application",
    "run_worker_first": ["/api/*"]
  },
  "d1_databases": [{
    "binding": "DB",
    "database_name": "my-auth-db",
    "database_id": "your-database-id"
  }]
}
```

## Demo

[https://sample-auth.anu.workers.dev](https://sample-auth.anu.workers.dev)

## โครงสร้างโปรเจค

```
react-auth/
├── src/
│   ├── index.ts              # createReactAuth() main entry
│   ├── types.ts              # TypeScript types ทั้งหมด
│   ├── core/
│   │   ├── session.ts        # Token generation, session CRUD
│   │   └── cookie.ts         # Cookie serialization/parsing
│   ├── providers/
│   │   ├── index.ts          # Provider registry
│   │   ├── github.ts         # GitHub OAuth
│   │   ├── google.ts         # Google OAuth + PKCE
│   │   └── line.ts           # LINE OAuth + PKCE
│   ├── db/
│   │   ├── schema.sql        # SQL schema
│   │   ├── queries.ts        # Raw SQL query functions
│   │   └── migrate.ts        # Auto migration
│   ├── server/
│   │   ├── auth.ts           # auth() helper
│   │   └── handlers.ts       # Route handlers
│   └── client/
│       ├── index.ts          # Client exports
│       ├── session-context.tsx  # SessionProvider + useSession
│       └── actions.ts          # signIn() / signUp() / signOut()
├── tests/                    # bun:test (122 tests)
├── sample-auth/              # ตัวอย่าง Cloudflare Worker app
└── docs/                     # เอกสารเพิ่มเติม
```

## ทดสอบ

```bash
bun test
```

122 tests ผ่านทั้งหมด ครอบคลุม session, cookie, database queries, providers, handlers, auth, migration, credentials, account linking, password hashing, RBAC

## Exports

```ts
// Main
import { createReactAuth, migrate } from "react-auth";

// Providers
import { createGoogleProvider, createGitHubProvider, createLineProvider } from "react-auth";

// Client (React)
import { SessionProvider, useSession, signIn, signUp, signOut, usePermission, useRole } from "react-auth/client";

// Password utilities
import { hashPassword, verifyPassword } from "react-auth";

// RBAC
import { resolvePermissions } from "react-auth";
import type { RbacConfig } from "react-auth";

// Types
import type {
  AuthConfig, AuthInstance, User, Session, Account,
  DatabaseAdapter, OAuthProvider, SessionManager,
  SessionContextValue, SessionStatus,
} from "react-auth";
```

## License

MIT
