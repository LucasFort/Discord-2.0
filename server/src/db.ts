import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';

export const db = new DatabaseSync(process.env.DB_PATH ?? 'discord2.db');
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS guilds (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS members (
  guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);
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
  created_at INTEGER NOT NULL,
  edited_at INTEGER
);
CREATE INDEX IF NOT EXISTS messages_channel ON messages(channel_id, id);
CREATE TABLE IF NOT EXISTS invites (
  code TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  creator_id TEXT NOT NULL REFERENCES users(id),
  uses INTEGER NOT NULL DEFAULT 0,
  max_uses INTEGER,
  expires_at INTEGER
);
`);

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

const q = {
  userById: db.prepare('SELECT id, username, display_name FROM users WHERE id = ?'),
  isMember: db.prepare('SELECT 1 FROM members WHERE guild_id = ? AND user_id = ?'),
  channel: db.prepare('SELECT * FROM channels WHERE id = ?'),
  guild: db.prepare('SELECT * FROM guilds WHERE id = ?'),
  guildsOf: db.prepare(
    'SELECT g.* FROM guilds g JOIN members m ON m.guild_id = g.id WHERE m.user_id = ? ORDER BY m.joined_at',
  ),
  channelsOf: db.prepare("SELECT * FROM channels WHERE guild_id = ? ORDER BY type = 'voice', position, name"),
  membersOf: db.prepare(
    'SELECT u.id, u.username, u.display_name FROM users u JOIN members m ON m.user_id = u.id WHERE m.guild_id = ? ORDER BY u.display_name',
  ),
  memberIds: db.prepare('SELECT user_id FROM members WHERE guild_id = ?'),
  message: db.prepare(
    `SELECT m.id, m.channel_id, m.content, m.created_at, m.edited_at,
            u.id AS author_id, u.username, u.display_name
     FROM messages m JOIN users u ON u.id = m.author_id WHERE m.id = ?`,
  ),
};

export const getUser = (id: string) => q.userById.get(id) as User | undefined;
export const isMember = (guildId: string, userId: string) => !!q.isMember.get(guildId, userId);
export const getChannel = (id: string) => q.channel.get(id) as Channel | undefined;
export const getGuild = (id: string) => q.guild.get(id) as Guild | undefined;
export const guildsOf = (userId: string) => q.guildsOf.all(userId) as Guild[];
export const channelsOf = (guildId: string) => q.channelsOf.all(guildId) as Channel[];
export const membersOf = (guildId: string) => q.membersOf.all(guildId) as User[];
export const memberIds = (guildId: string) => (q.memberIds.all(guildId) as { user_id: string }[]).map((r) => r.user_id);

type MessageRow = Omit<Message, 'author'> & { author_id: string; username: string; display_name: string };
export function rowToMessage(r: MessageRow): Message {
  return {
    id: r.id,
    channel_id: r.channel_id,
    content: r.content,
    created_at: r.created_at,
    edited_at: r.edited_at,
    author: { id: r.author_id, username: r.username, display_name: r.display_name },
  };
}
export const getMessage = (id: string) => {
  const r = q.message.get(id) as MessageRow | undefined;
  return r && rowToMessage(r);
};

export function listMessages(channelId: string, before: string | undefined, limit: number): Message[] {
  const rows = db
    .prepare(
      `SELECT m.id, m.channel_id, m.content, m.created_at, m.edited_at,
              u.id AS author_id, u.username, u.display_name
       FROM messages m JOIN users u ON u.id = m.author_id
       WHERE m.channel_id = ? AND (? IS NULL OR m.id < ?)
       ORDER BY m.id DESC LIMIT ?`,
    )
    .all(channelId, before ?? null, before ?? null, limit) as MessageRow[];
  return rows.map(rowToMessage).reverse();
}

/** Full guild payload sent to clients. */
export function guildPayload(g: Guild) {
  return { ...g, channels: channelsOf(g.id), members: membersOf(g.id) };
}
