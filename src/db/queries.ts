import type {
  DatabaseAdapter,
  User,
  Session,
  Account,
  SessionValidationResult,
} from "../types.ts";

// ─── Row types ──────────────────────────────────────────────────────

interface UserRow {
  id: string;
  email: string | null;
  name: string | null;
  avatar_url: string | null;
  role?: string;
}

interface SessionRow {
  id: string;
  user_id: string;
  expires_at: number;
}

interface AccountRow {
  id: string;
  user_id: string;
  provider_id: string;
  provider_user_id: string;
  access_token: string | null;
  refresh_token: string | null;
  expires_at: number | null;
}

interface SessionWithUserRow extends SessionRow {
  user_email: string | null;
  user_name: string | null;
  user_avatar_url: string | null;
  user_role?: string;
}

function rowToUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    avatarUrl: row.avatar_url,
    role: row.role,
  };
}

function rowToSession(row: SessionRow): Session {
  return {
    id: row.id,
    userId: row.user_id,
    expiresAt: new Date(Number(row.expires_at)),
  };
}

function rowToAccount(row: AccountRow): Account {
  return {
    id: row.id,
    userId: row.user_id,
    providerId: row.provider_id,
    providerUserId: row.provider_user_id,
    accessToken: row.access_token,
    refreshToken: row.refresh_token,
    expiresAt: row.expires_at,
  };
}

// ─── Table names ────────────────────────────────────────────────────

const PREFIX_RE = /^[a-zA-Z0-9_]*$/;

export interface TableNames {
  users: string;
  accounts: string;
  sessions: string;
}

export function resolveTableNames(prefix?: string): TableNames {
  const p = prefix ?? "";
  if (!PREFIX_RE.test(p)) {
    throw new Error(
      `[just-auth] Invalid tablePrefix "${p}". Only alphanumeric characters and underscores are allowed.`
    );
  }
  return {
    users: `${p}users`,
    accounts: `${p}accounts`,
    sessions: `${p}sessions`,
  };
}

// ─── Queries factory ────────────────────────────────────────────────

export interface Queries {
  tableNames: TableNames;
  createUser(
    user: { id: string; email: string | null; name: string | null; avatarUrl: string | null; role?: string },
    extraColumns?: Record<string, unknown>
  ): Promise<User>;
  createUserWithPassword(user: { id: string; email: string; name: string | null; avatarUrl: string | null; passwordHash: string; role?: string }): Promise<void>;
  getUserById(id: string): Promise<User | null>;
  getUserByEmail(email: string): Promise<User | null>;
  getUserByEmailWithPassword(email: string): Promise<(User & { passwordHash: string | null }) | null>;
  getUserByAccount(providerId: string, providerUserId: string): Promise<User | null>;
  createAccount(account: Omit<Account, "id"> & { id: string }): Promise<void>;
  getAccountByProvider(providerId: string, providerUserId: string): Promise<Account | null>;
  getAccountsByUserId(userId: string): Promise<Account[]>;
  insertSession(session: { id: string; userId: string; expiresAt: number }): Promise<void>;
  getSessionAndUser(sessionId: string): Promise<SessionValidationResult | null>;
  updateSessionExpiry(sessionId: string, expiresAt: number): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
  deleteUserSessions(userId: string): Promise<void>;
  updateUserRole(userId: string, role: string): Promise<void>;
}

export function createQueries(db: DatabaseAdapter, prefix?: string): Queries {
  const t = resolveTableNames(prefix);

  return {
    tableNames: t,

    // ── Users ──

    async createUser(user, extraColumns) {
      const IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
      const base: Record<string, unknown> = {
        id: user.id,
        email: user.email,
        name: user.name,
        avatar_url: user.avatarUrl,
      };
      if (user.role !== undefined) base.role = user.role;
      const RESERVED = new Set(["id", "email", "name", "avatar_url"]);
      const safeExtra: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(extraColumns ?? {})) {
        if (!RESERVED.has(k)) safeExtra[k] = v;
      }
      const merged: Record<string, unknown> = { ...base, ...safeExtra };

      const parts: string[] = [];
      const values: unknown[] = [];
      for (const [key, value] of Object.entries(merged)) {
        if (value === undefined) continue;
        if (!IDENT_RE.test(key)) {
          throw new Error(`[just-auth] Invalid column name "${key}" in createUser extraColumns`);
        }
        parts.push(key);
        values.push(value);
      }

      const placeholders = parts.map(() => "?").join(", ");
      await db
        .prepare(`INSERT INTO ${t.users} (${parts.join(", ")}) VALUES (${placeholders})`)
        .bind(...values)
        .run();

      return { id: user.id, email: user.email, name: user.name, avatarUrl: user.avatarUrl, role: user.role };
    },

    async createUserWithPassword(user) {
      if (user.role) {
        await db
          .prepare(`INSERT INTO ${t.users} (id, email, name, avatar_url, password_hash, role) VALUES (?, ?, ?, ?, ?, ?)`)
          .bind(user.id, user.email, user.name, user.avatarUrl, user.passwordHash, user.role)
          .run();
      } else {
        await db
          .prepare(`INSERT INTO ${t.users} (id, email, name, avatar_url, password_hash) VALUES (?, ?, ?, ?, ?)`)
          .bind(user.id, user.email, user.name, user.avatarUrl, user.passwordHash)
          .run();
      }
    },

    async getUserById(id) {
      const row = await db.prepare(`SELECT * FROM ${t.users} WHERE id = ?`).bind(id).first<UserRow>();
      return row ? rowToUser(row) : null;
    },

    async getUserByEmail(email) {
      const row = await db.prepare(`SELECT * FROM ${t.users} WHERE email = ?`).bind(email).first<UserRow>();
      return row ? rowToUser(row) : null;
    },

    async getUserByEmailWithPassword(email) {
      const row = await db
        .prepare(`SELECT * FROM ${t.users} WHERE email = ?`)
        .bind(email)
        .first<UserRow & { password_hash: string | null }>();
      if (!row) return null;
      return { ...rowToUser(row), passwordHash: row.password_hash };
    },

    async getUserByAccount(providerId, providerUserId) {
      const row = await db
        .prepare(
          `SELECT u.* FROM ${t.users} u INNER JOIN ${t.accounts} a ON u.id = a.user_id WHERE a.provider_id = ? AND a.provider_user_id = ?`
        )
        .bind(providerId, providerUserId)
        .first<UserRow>();
      return row ? rowToUser(row) : null;
    },

    // ── Accounts ──

    async createAccount(account) {
      await db
        .prepare(
          `INSERT INTO ${t.accounts} (id, user_id, provider_id, provider_user_id, access_token, refresh_token, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          account.id, account.userId, account.providerId,
          account.providerUserId, account.accessToken,
          account.refreshToken, account.expiresAt
        )
        .run();
    },

    async getAccountByProvider(providerId, providerUserId) {
      const row = await db
        .prepare(`SELECT * FROM ${t.accounts} WHERE provider_id = ? AND provider_user_id = ?`)
        .bind(providerId, providerUserId)
        .first<AccountRow>();
      return row ? rowToAccount(row) : null;
    },

    async getAccountsByUserId(userId) {
      const { results } = await db
        .prepare(`SELECT * FROM ${t.accounts} WHERE user_id = ?`)
        .bind(userId)
        .all<AccountRow>();
      return results.map(rowToAccount);
    },

    // ── Sessions ──

    async insertSession(session) {
      await db
        .prepare(`INSERT INTO ${t.sessions} (id, user_id, expires_at) VALUES (?, ?, ?)`)
        .bind(session.id, session.userId, session.expiresAt)
        .run();
    },

    async getSessionAndUser(sessionId) {
      const row = await db
        .prepare(
          `SELECT s.id, s.user_id, s.expires_at, u.email as user_email, u.name as user_name, u.avatar_url as user_avatar_url, u.role as user_role
           FROM ${t.sessions} s
           INNER JOIN ${t.users} u ON u.id = s.user_id
           WHERE s.id = ?`
        )
        .bind(sessionId)
        .first<SessionWithUserRow>();

      if (!row) return null;

      return {
        session: rowToSession(row),
        user: {
          id: row.user_id,
          email: row.user_email,
          name: row.user_name,
          avatarUrl: row.user_avatar_url,
          role: row.user_role,
        },
      };
    },

    async updateSessionExpiry(sessionId, expiresAt) {
      await db
        .prepare(`UPDATE ${t.sessions} SET expires_at = ? WHERE id = ?`)
        .bind(expiresAt, sessionId)
        .run();
    },

    async deleteSession(sessionId) {
      await db
        .prepare(`DELETE FROM ${t.sessions} WHERE id = ?`)
        .bind(sessionId)
        .run();
    },

    async deleteUserSessions(userId) {
      await db
        .prepare(`DELETE FROM ${t.sessions} WHERE user_id = ?`)
        .bind(userId)
        .run();
    },

    // ── Roles ──

    async updateUserRole(userId, role) {
      await db
        .prepare(`UPDATE ${t.users} SET role = ? WHERE id = ?`)
        .bind(role, userId)
        .run();
    },
  };
}
