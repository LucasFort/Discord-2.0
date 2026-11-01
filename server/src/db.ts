import { randomBytes } from 'node:crypto';

/**
 * Banco de dados com dois motores:
 * - PostgreSQL quando DATABASE_URL existe (produção: os dados sobrevivem a reinícios e deploys);
 * - SQLite nativo do Node em arquivo local quando não existe (desenvolvimento, zero configuração).
 * As consultas usam `?` como marcador e o adaptador converte para `$1, $2…` no Postgres.
 */
type Row = Record<string, any>;
type Driver = {
  kind: 'postgres' | 'sqlite';
  all(sql: string, params?: unknown[]): Promise<Row[]>;
  exec(sql: string): Promise<void>;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower ON users (lower(username));
CREATE TABLE IF NOT EXISTS guilds (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id),
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS members (
  guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at BIGINT NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);
CREATE INDEX IF NOT EXISTS members_user ON members(user_id);
CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('text', 'voice')),
  position INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES users(id),
  content TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  edited_at BIGINT
);
CREATE INDEX IF NOT EXISTS messages_channel ON messages(channel_id, id);
CREATE TABLE IF NOT EXISTS invites (
  code TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  creator_id TEXT NOT NULL REFERENCES users(id),
  uses INTEGER NOT NULL DEFAULT 0,
  max_uses INTEGER,
  expires_at BIGINT
);
`;

async function postgresDriver(url: string): Promise<Driver> {
  const pg = (await import('pg')).default;
  pg.types.setTypeParser(20, (v) => Number(v)); // BIGINT -> number (timestamps em ms cabem com folga)
  // SSL só para hosts externos (ex.: "x.oregon-postgres.render.com"). Localhost e a rede interna do
  // Render (host sem ponto, ex.: "dpg-abc123-a") conectam sem SSL.
  const host = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return '';
    }
  })();
  const useSsl = host.includes('.') && host !== '127.0.0.1' && !url.includes('sslmode=disable');
  const pool = new pg.Pool({ connectionString: url, max: 10, ssl: useSsl ? { rejectUnauthorized: false } : false });
  const toPg = (sql: string) => {
    let i = 0;
    return sql.replace(/\?/g, () => `$${++i}`);
  };
  return {
    kind: 'postgres',
    async all(sql, params = []) {
      return (await pool.query(toPg(sql), params)).rows;
    },
    async exec(sql) {
      await pool.query(sql);
    },
  };
}

async function sqliteDriver(path: string): Promise<Driver> {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  const cache = new Map<string, ReturnType<typeof db.prepare>>();
  const stmt = (sql: string) => {
    let s = cache.get(sql);
    if (!s) cache.set(sql, (s = db.prepare(sql)));
    return s;
  };
  return {
    kind: 'sqlite',
    async all(sql, params = []) {
      const s = stmt(sql);
      if (/^\s*(select|with)/i.test(sql)) return s.all(...(params as never[])) as Row[];
      s.run(...(params as never[]));
      return [];
    },
    async exec(sql) {
      db.exec(sql);
    },
  };
}

const databaseUrl = process.env.DATABASE_URL?.trim();
export const driver: Driver = databaseUrl
  ? await postgresDriver(databaseUrl)
  : await sqliteDriver(process.env.DB_PATH ?? 'discord2.db');
await driver.exec(SCHEMA);
if (process.env.NODE_ENV === 'production' && driver.kind === 'sqlite')
  console.warn('[banco] Sem DATABASE_URL: usando SQLite em arquivo. No Render grátis os dados somem a cada reinício.');

export const all = (sql: string, ...params: unknown[]) => driver.all(sql, params);
export const get = async (sql: string, ...params: unknown[]) => (await driver.all(sql, params))[0];
export const run = async (sql: string, ...params: unknown[]) => void (await driver.all(sql, params));

/** Time-sortable id: 10 chars of timestamp + 12 random chars (base36). */
export function newId(): string {
  const time = Date.now().toString(36).padStart(10, '0');
  const rand = [...randomBytes(12)].map((b) => (b % 36).toString(36)).join('');
  return time + rand;
}

export function inviteCode(): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return [...randomBytes(8)].map((b) => alphabet[b % alphabet.length]).join('');
}

export type User = { id: string; username: string; display_name: string };
export type Guild = { id: string; name: string; owner_id: string };
export type Channel = { id: string; guild_id: string; name: string; type: 'text' | 'voice'; position: number };
export type Message = {
  id: string;
  channel_id: string;
  content: string;
  created_at: number;
  edited_at: number | null;
  author: User;
};

export const getUser = async (id: string) =>
  (await get('SELECT id, username, display_name FROM users WHERE id = ?', id)) as User | undefined;
export const isMember = async (guildId: string, userId: string) =>
  !!(await get('SELECT 1 AS ok FROM members WHERE guild_id = ? AND user_id = ?', guildId, userId));
export const getChannel = async (id: string) => (await get('SELECT * FROM channels WHERE id = ?', id)) as Channel | undefined;
export const getGuild = async (id: string) =>
  (await get('SELECT id, name, owner_id, created_at FROM guilds WHERE id = ?', id)) as Guild | undefined;
export const guildsOf = async (userId: string) =>
  (await all(
    'SELECT g.id, g.name, g.owner_id, g.created_at FROM guilds g JOIN members m ON m.guild_id = g.id WHERE m.user_id = ? ORDER BY m.joined_at',
    userId,
  )) as Guild[];
export const channelsOf = async (guildId: string) =>
  (await all("SELECT * FROM channels WHERE guild_id = ? ORDER BY type = 'voice', position, name", guildId)) as Channel[];
export const membersOf = async (guildId: string) =>
  (await all(
    'SELECT u.id, u.username, u.display_name FROM users u JOIN members m ON m.user_id = u.id WHERE m.guild_id = ? ORDER BY u.display_name',
    guildId,
  )) as User[];
export const memberIds = async (guildId: string) =>
  (await all('SELECT user_id FROM members WHERE guild_id = ?', guildId)).map((r) => r.user_id as string);

const MESSAGE_SELECT = `SELECT m.id, m.channel_id, m.content, m.created_at, m.edited_at,
       u.id AS author_id, u.username, u.display_name
FROM messages m JOIN users u ON u.id = m.author_id`;

function rowToMessage(r: Row): Message {
  return {
    id: r.id,
    channel_id: r.channel_id,
    content: r.content,
    created_at: r.created_at,
    edited_at: r.edited_at ?? null,
    author: { id: r.author_id, username: r.username, display_name: r.display_name },
  };
}

export const getMessage = async (id: string) => {
  const r = await get(`${MESSAGE_SELECT} WHERE m.id = ?`, id);
  return r && rowToMessage(r);
};

export async function listMessages(channelId: string, before: string | undefined, limit: number): Promise<Message[]> {
  const rows = before
    ? await all(`${MESSAGE_SELECT} WHERE m.channel_id = ? AND m.id < ? ORDER BY m.id DESC LIMIT ?`, channelId, before, limit)
    : await all(`${MESSAGE_SELECT} WHERE m.channel_id = ? ORDER BY m.id DESC LIMIT ?`, channelId, limit);
  return rows.map(rowToMessage).reverse();
}

/** Full guild payload sent to clients. */
export async function guildPayload(g: Guild) {
  const [channels, members] = await Promise.all([channelsOf(g.id), membersOf(g.id)]);
  return { ...g, channels, members };
}
