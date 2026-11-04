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
CREATE TABLE IF NOT EXISTS reactions (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  emoji TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (message_id, user_id, emoji)
);
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  size INTEGER NOT NULL,
  data TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS attachments_message ON attachments(message_id);
CREATE TABLE IF NOT EXISTS relationships (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  other_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('friend', 'outgoing', 'incoming')),
  created_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, other_id)
);
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

// Colunas novas em bancos que já existiam (perfil e status, no estilo do Discord).
// SQLite não tem "ADD COLUMN IF NOT EXISTS": tenta e ignora o erro de coluna repetida.
const PROFILE_COLUMNS = ['avatar', 'bio', 'pronouns', 'banner_color', 'custom_status', 'status'];
for (const col of PROFILE_COLUMNS) {
  try {
    await driver.exec(`ALTER TABLE users ADD COLUMN ${col} TEXT`);
  } catch {
    /* já existe */
  }
}
for (const [table, col, type] of [
  ['guilds', 'icon', 'TEXT'],
  // Conversa direta (DM) = "servidor" escondido com duas pessoas.
  ['guilds', 'is_dm', 'INTEGER NOT NULL DEFAULT 0'],
  ['channels', 'topic', 'TEXT'],
  ['messages', 'reply_to', 'TEXT'],
  ['messages', 'pinned', 'INTEGER NOT NULL DEFAULT 0'],
] as const) {
  try {
    await driver.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
  } catch {
    /* já existe */
  }
}
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

/** Perfil público (o que os outros veem). A foto é uma imagem pequena em data URL. */
export type User = {
  id: string;
  username: string;
  display_name: string;
  avatar?: string | null;
  bio?: string | null;
  pronouns?: string | null;
  banner_color?: string | null;
  custom_status?: string | null;
};
/** Status escolhido pela pessoa. "invisible" aparece como offline para os outros. */
export type UserStatus = 'online' | 'idle' | 'dnd' | 'invisible';
export type Guild = { id: string; name: string; owner_id: string; icon?: string | null; is_dm?: number };
/** Dono de verdade: conversa direta não tem dono (as duas pessoas têm os mesmos poderes). */
export const ownsGuild = (g: Guild | undefined, userId: string) => !!g && !Number(g.is_dm ?? 0) && g.owner_id === userId;
export type Channel = { id: string; guild_id: string; name: string; type: 'text' | 'voice'; position: number; topic?: string | null; last_message_id?: string | null };
const USER_COLS = 'u.id, u.username, u.display_name, u.avatar, u.bio, u.pronouns, u.banner_color, u.custom_status';
/** Arquivo anexado (o conteúdo fica no banco e é servido em /api/attachments/:id/:nome). */
export type Attachment = { id: string; name: string; type: string; size: number; url: string };
/** Resumo da mensagem respondida (aparece em cima da resposta). */
export type ReplyRef = { id: string; author: User; content: string } | null;
export type Message = {
  id: string;
  channel_id: string;
  content: string;
  reply_to?: string | null;
  reply?: ReplyRef;
  pinned?: boolean;
  attachments?: Attachment[];
  created_at: number;
  edited_at: number | null;
  author: User;
  reactions: Reaction[];
};
/** Uma reação agrupada: o emoji e quem reagiu com ele. */
export type Reaction = { emoji: string; user_ids: string[] };

export const getUser = async (id: string) => (await get(`SELECT ${USER_COLS} FROM users u WHERE u.id = ?`, id)) as User | undefined;
export const getStatus = async (id: string) =>
  (((await get('SELECT status FROM users WHERE id = ?', id)) as { status: string | null } | undefined)?.status ?? 'online') as UserStatus;
export const isMember = async (guildId: string, userId: string) =>
  !!(await get('SELECT 1 AS ok FROM members WHERE guild_id = ? AND user_id = ?', guildId, userId));
export const getChannel = async (id: string) => (await get('SELECT * FROM channels WHERE id = ?', id)) as Channel | undefined;
export const getGuild = async (id: string) =>
  (await get('SELECT id, name, owner_id, icon, created_at, is_dm FROM guilds WHERE id = ?', id)) as Guild | undefined;
export const guildsOf = async (userId: string) =>
  (await all(
    'SELECT g.id, g.name, g.owner_id, g.icon, g.created_at, g.is_dm FROM guilds g JOIN members m ON m.guild_id = g.id WHERE m.user_id = ? ORDER BY m.joined_at',
    userId,
  )) as Guild[];
export const channelsOf = async (guildId: string) =>
  (await all(
    "SELECT c.*, (SELECT MAX(id) FROM messages WHERE channel_id = c.id) AS last_message_id FROM channels c WHERE c.guild_id = ? ORDER BY c.type = 'voice', c.position, c.name",
    guildId,
  )) as Channel[];

/** Mensagens fixadas de um canal (mais nova primeiro). */
export async function pinnedMessages(channelId: string): Promise<Message[]> {
  const rows = await all(`${MESSAGE_SELECT} WHERE m.channel_id = ? AND m.pinned = 1 ORDER BY m.id DESC LIMIT 50`, channelId);
  return withReactions(rows.map(rowToMessage));
}

/** Busca simples por texto nos canais de texto de um servidor (mais nova primeiro). */
export async function searchMessages(guildId: string, q: string, limit = 25): Promise<Message[]> {
  const like = `%${q.toLowerCase().replace(/[\\%_]/g, (c) => '\\' + c)}%`;
  const rows = await all(
    `${MESSAGE_SELECT} JOIN channels c ON c.id = m.channel_id WHERE c.guild_id = ? AND lower(m.content) LIKE ? ESCAPE '\\' ORDER BY m.id DESC LIMIT ?`,
    guildId, like, limit,
  );
  return withReactions(rows.map(rowToMessage));
}
export const membersOf = async (guildId: string) =>
  (await all(
    `SELECT ${USER_COLS} FROM users u JOIN members m ON m.user_id = u.id WHERE m.guild_id = ? ORDER BY u.display_name`,
    guildId,
  )) as User[];
export const memberIds = async (guildId: string) =>
  (await all('SELECT user_id FROM members WHERE guild_id = ?', guildId)).map((r) => r.user_id as string);

const MESSAGE_SELECT = `SELECT m.id, m.channel_id, m.content, m.created_at, m.edited_at, m.reply_to, m.pinned,
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
    reactions: [],
    reply_to: r.reply_to ?? null,
    pinned: !!Number(r.pinned ?? 0),
    attachments: [],
  };
}

/** Preenche reações, anexos e a mensagem respondida de várias mensagens com poucas consultas. */
async function withReactions(msgs: Message[]): Promise<Message[]> {
  if (!msgs.length) return msgs;
  const marks = msgs.map(() => '?').join(', ');
  const att = await all(`SELECT id, message_id, name, type, size FROM attachments WHERE message_id IN (${marks}) ORDER BY id`, ...msgs.map((m) => m.id));
  const byMsg = new Map(msgs.map((m) => [m.id, m]));
  for (const a of att)
    byMsg.get(a.message_id)!.attachments!.push({ id: a.id, name: a.name, type: a.type, size: Number(a.size), url: `/api/attachments/${a.id}/${encodeURIComponent(a.name)}` });
  const replyIds = [...new Set(msgs.map((m) => m.reply_to).filter(Boolean) as string[])];
  if (replyIds.length) {
    const rows = await all(`${MESSAGE_SELECT} WHERE m.id IN (${replyIds.map(() => '?').join(', ')})`, ...replyIds);
    const refs = new Map(rows.map((r) => [r.id as string, r]));
    for (const m of msgs) {
      if (!m.reply_to) continue;
      const r = refs.get(m.reply_to);
      m.reply = r ? { id: r.id, author: { id: r.author_id, username: r.username, display_name: r.display_name }, content: String(r.content).slice(0, 200) } : null;
    }
  }
  const rows = await all(
    `SELECT message_id, user_id, emoji FROM reactions WHERE message_id IN (${msgs.map(() => '?').join(', ')}) ORDER BY created_at`,
    ...msgs.map((m) => m.id),
  );
  const byId = new Map(msgs.map((m) => [m.id, m]));
  for (const r of rows) {
    const m = byId.get(r.message_id)!;
    let group = m.reactions.find((x) => x.emoji === r.emoji);
    if (!group) m.reactions.push((group = { emoji: r.emoji, user_ids: [] }));
    group.user_ids.push(r.user_id);
  }
  return msgs;
}

export const getMessage = async (id: string) => {
  const r = await get(`${MESSAGE_SELECT} WHERE m.id = ?`, id);
  return r ? (await withReactions([rowToMessage(r)]))[0] : undefined;
};

export async function listMessages(channelId: string, before: string | undefined, limit: number): Promise<Message[]> {
  const rows = before
    ? await all(`${MESSAGE_SELECT} WHERE m.channel_id = ? AND m.id < ? ORDER BY m.id DESC LIMIT ?`, channelId, before, limit)
    : await all(`${MESSAGE_SELECT} WHERE m.channel_id = ? ORDER BY m.id DESC LIMIT ?`, channelId, limit);
  return withReactions(rows.map(rowToMessage).reverse());
}

// ---------- Amigos ----------
export type RelationshipType = 'friend' | 'outgoing' | 'incoming';
export type Relationship = { user: User; type: RelationshipType };

/** Amigos e pedidos de amizade (enviados e recebidos) de uma pessoa. */
export async function relationshipsOf(userId: string): Promise<Relationship[]> {
  const rows = await all(
    `SELECT r.type, ${USER_COLS} FROM relationships r JOIN users u ON u.id = r.other_id WHERE r.user_id = ? ORDER BY lower(u.display_name)`,
    userId,
  );
  return rows.map(({ type, ...user }) => ({ type, user: user as User }));
}
export const relationshipType = async (userId: string, otherId: string) =>
  ((await get('SELECT type FROM relationships WHERE user_id = ? AND other_id = ?', userId, otherId)) as { type: RelationshipType } | undefined)?.type;
/** Todo mundo com quem a pessoa tem amizade ou pedido pendente (recebe presença e mudanças de perfil). */
export const relationshipIds = async (userId: string) =>
  (await all('SELECT other_id FROM relationships WHERE user_id = ?', userId)).map((r) => r.other_id as string);

/** Conversa direta já existente entre duas pessoas. */
export const findDm = async (a: string, b: string) =>
  ((await get(
    'SELECT g.id FROM guilds g JOIN members x ON x.guild_id = g.id AND x.user_id = ? JOIN members y ON y.guild_id = g.id AND y.user_id = ? WHERE g.is_dm = 1',
    a, b,
  )) as { id: string } | undefined)?.id;

/** Full guild payload sent to clients. */
export async function guildPayload(g: Guild) {
  const [channels, members] = await Promise.all([channelsOf(g.id), membersOf(g.id)]);
  return { ...g, channels, members };
}
