# RBAC (Role-Based Access Control)

react-auth มีระบบ RBAC แบบ optional — กำหนด role และ permissions ใน code config โดยไม่ต้องสร้างตารางเพิ่ม

## วิธีเปิดใช้งาน

เพิ่ม `rbac` ใน `createReactAuth()` config:

```ts
const auth = createReactAuth({
  providers: [...],
  database: db,
  rbac: {
    // กำหนด resource และ action ที่เป็นไปได้ทั้งหมด
    statements: {
      post: ["create", "read", "update", "delete"],
      user: ["list", "ban", "set-role"],
      comment: ["create", "delete"],
    },
    // กำหนดว่า role ไหนมี permission อะไรบ้าง
    roles: {
      user: {
        post: ["read"],
        comment: ["create"],
      },
      editor: {
        post: ["create", "read", "update"],
        comment: ["create", "delete"],
      },
      admin: "*",  // wildcard = ทุก permission
    },
    // role เริ่มต้นสำหรับ user ใหม่ (default: "user")
    defaultRole: "user",
  },
});
```

เมื่อไม่ได้เปิด `rbac` config — ไม่มี overhead ใดๆ, ไม่มี role ใน session response, ไม่มี /api/auth/role endpoint

## Database

เพิ่มแค่ 1 column: `role TEXT NOT NULL DEFAULT 'user'` ในตาราง `users`

Migration รันอัตโนมัติ (idempotent) — สามารถเปิด RBAC ทีหลังได้ โดยเรียก `migrate(db)` ตามปกติ

```sql
ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user';
```

ไม่มีตาราง permissions — permissions ถูก resolve จาก config ตอน runtime

## Server API

### auth(request)

เมื่อเปิด RBAC, `auth(request)` จะ return user ที่มี `role`:

```ts
const session = await auth.auth(request);
console.log(session.user.role); // "editor"
```

### hasPermission(request, permission)

ตรวจสอบว่า user มี permission ที่กำหนดหรือไม่:

```ts
const canEdit = await auth.hasPermission(request, "post:update");
if (!canEdit) {
  return new Response("Forbidden", { status: 403 });
}
```

### hasRole(request, role)

ตรวจสอบ role โดยตรง:

```ts
const isAdmin = await auth.hasRole(request, "admin");
```

### POST /api/auth/role

Endpoint สำหรับเปลี่ยน role ของ user — ต้องมี `user:set-role` permission:

```ts
// Request
POST /api/auth/role
Content-Type: application/json
Cookie: auth_session=...

{ "userId": "target-user-id", "role": "editor" }

// Response (200)
{ "user": { "id": "target-user-id", "role": "editor" } }

// Response (403) — ถ้าไม่มี user:set-role permission
{ "error": "Forbidden" }

// Response (400) — ถ้า role ไม่ถูกต้อง
{ "error": "Invalid role: superadmin" }
```

## Session Endpoint

`GET /api/auth/session` response เมื่อเปิด RBAC:

```json
{
  "user": { "id": "...", "email": "...", "name": "...", "avatarUrl": null, "role": "editor" },
  "session": { "expiresAt": "..." },
  "accounts": [{ "providerId": "google" }],
  "permissions": ["post:create", "post:read", "post:update", "comment:create", "comment:delete"]
}
```

## Client API

### useSession()

Session context มี `permissions` array:

```tsx
const { data } = useSession();
// data.user.role = "editor"
// data.permissions = ["post:create", "post:read", ...]
```

### usePermission(permission)

```tsx
import { usePermission } from "react-auth/client";

function PostEditor() {
  const canEdit = usePermission("post:update");
  if (!canEdit) return <p>ไม่มีสิทธิ์</p>;
  return <Editor />;
}
```

### useRole(role)

```tsx
import { useRole } from "react-auth/client";

function AdminPanel() {
  const isAdmin = useRole("admin");
  if (!isAdmin) return null;
  return <AdminDashboard />;
}
```

## Permission Format

Permissions ใช้รูปแบบ `resource:action`:

```
post:create
post:read
post:update
post:delete
user:list
user:ban
user:set-role
comment:create
comment:delete
```

## Wildcard Role

ใช้ `"*"` เพื่อให้ role มีทุก permission:

```ts
roles: {
  admin: "*",  // = post:create, post:read, ..., user:list, ...ทั้งหมด
}
```

## Bootstrap: ตั้ง Admin คนแรก

เนื่องจาก user ใหม่ทุกคนจะได้ role `"user"` (default) — admin คนแรกต้องตั้งเองผ่าน SQL:

```sql
UPDATE users SET role = 'admin' WHERE email = 'admin@example.com';
```

หลังจากมี admin คนแรกแล้ว สามารถใช้ `POST /api/auth/role` endpoint ในการจัดการ role ได้

## resolvePermissions()

ฟังก์ชันสำหรับ resolve permissions จาก role (สำหรับ advanced use case):

```ts
import { resolvePermissions } from "react-auth";
import type { RbacConfig } from "react-auth";

const config: RbacConfig = {
  statements: { post: ["read", "write"] },
  roles: { user: { post: ["read"] } },
};

const perms = resolvePermissions("user", config);
// ["post:read"]
```
