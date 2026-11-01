import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { AccessToken, TrackSource } from 'livekit-server-sdk';
import { requireAuth, signSession } from './auth.js';
import {
  db, newId, inviteCode, getChannel, getGuild, getMessage, guildPayload, guildsOf, isMember, listMessages, getUser,
} from './db.js';
import { sendToGuild, sendToUser } from './gateway.js';

// Valores colados em painéis de deploy costumam vir com espaço ou quebra de linha: limpamos tudo.
const env = (k: string) => process.env[k]?.trim() || undefined;
/** Aceita "wss://x", "https://x" ou só "x.livekit.cloud" e devolve sempre ws(s)://. */
export function normalizeLivekitUrl(raw: string | undefined): string {
  const url = (raw ?? 'ws://localhost:7880').replace(/\/+$/, '');
  if (/^wss?:\/\//i.test(url)) return url;
  if (/^https:\/\//i.test(url)) return url.replace(/^https/i, 'wss');
  if (/^http:\/\//i.test(url)) return url.replace(/^http/i, 'ws');
  return `wss://${url}`;
}
const LIVEKIT_URL = normalizeLivekitUrl(env('LIVEKIT_URL'));
const LIVEKIT_API_KEY = env('LIVEKIT_API_KEY') ?? 'devkey';
const LIVEKIT_API_SECRET = env('LIVEKIT_API_SECRET') ?? 'secret';
const livekitConfigured = !!(env('LIVEKIT_URL') && env('LIVEKIT_API_KEY') && env('LIVEKIT_API_SECRET'));
if (process.env.NODE_ENV === 'production' && !livekitConfigured)
  console.warn('[voz] LIVEKIT_URL, LIVEKIT_API_KEY ou LIVEKIT_API_SECRET não configurados: a voz não vai funcionar.');

const credentials = z.object({
  username: z.string().trim().min(2).max(32).regex(/^[a-zA-Z0-9_.]+$/, 'Use letras, números, _ ou .'),
  password: z.string().min(6).max(128),
  display_name: z.string().trim().min(1).max(32).optional(),
});

function bad(message: string) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

export function registerRoutes(app: FastifyInstance) {
  // ---------- Contas ----------
  app.post('/api/auth/register', async (req) => {
    const body = credentials.parse(req.body);
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(body.username)) throw bad('Esse usuário já existe');
    const id = newId();
    db.prepare('INSERT INTO users (id, username, display_name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)').run(
      id, body.username, body.display_name ?? body.username, await bcrypt.hash(body.password, 10), Date.now(),
    );
    return { token: await signSession(id), user: getUser(id) };
  });

  app.post('/api/auth/login', async (req, reply) => {
    const body = credentials.pick({ username: true, password: true }).parse(req.body);
    const row = db.prepare('SELECT id, password_hash FROM users WHERE username = ?').get(body.username) as
      | { id: string; password_hash: string }
      | undefined;
    if (!row || !(await bcrypt.compare(body.password, row.password_hash)))
      return reply.code(401).send({ error: 'Usuário ou senha incorretos' });
    return { token: await signSession(row.id), user: getUser(row.id) };
  });

  // Diagnóstico sem segredos: mostra se a voz está configurada e para onde o cliente vai conectar.
  app.get('/api/voice-config', async () => ({ configured: livekitConfigured, url: LIVEKIT_URL }));

  // Tudo abaixo exige login
  app.register(async (api) => {
    api.addHook('preHandler', requireAuth);

    api.get('/api/me', async (req) => ({ user: req.user, guilds: guildsOf(req.user.id).map(guildPayload) }));

    // ---------- Servidores ----------
    api.post('/api/guilds', async (req) => {
      const { name } = z.object({ name: z.string().trim().min(1).max(64) }).parse(req.body);
      const id = newId();
      const now = Date.now();
      db.prepare('INSERT INTO guilds (id, name, owner_id, created_at) VALUES (?, ?, ?, ?)').run(id, name, req.user.id, now);
      db.prepare('INSERT INTO members (guild_id, user_id, joined_at) VALUES (?, ?, ?)').run(id, req.user.id, now);
      const ins = db.prepare('INSERT INTO channels (id, guild_id, name, type, position) VALUES (?, ?, ?, ?, ?)');
      ins.run(newId(), id, 'geral', 'text', 0);
      ins.run(newId(), id, 'Geral', 'voice', 0);
      const payload = guildPayload(getGuild(id)!);
      sendToUser(req.user.id, 'GUILD_CREATE', payload);
      return payload;
    });

    api.post('/api/guilds/:guildId/invites', async (req, reply) => {
      const { guildId } = req.params as { guildId: string };
      if (!isMember(guildId, req.user.id)) return reply.code(403).send({ error: 'Sem acesso' });
      const opts = z
        .object({ max_uses: z.number().int().positive().nullable().optional(), expires_in_hours: z.number().positive().nullable().optional() })
        .parse(req.body ?? {});
      const code = inviteCode();
      db.prepare('INSERT INTO invites (code, guild_id, creator_id, max_uses, expires_at) VALUES (?, ?, ?, ?, ?)').run(
        code, guildId, req.user.id, opts.max_uses ?? null,
        opts.expires_in_hours ? Date.now() + opts.expires_in_hours * 3_600_000 : Date.now() + 7 * 86_400_000,
      );
      return { code };
    });

    api.post('/api/invites/:code', async (req, reply) => {
      const { code } = req.params as { code: string };
      const inv = db.prepare('SELECT * FROM invites WHERE code = ?').get(code) as
        | { guild_id: string; uses: number; max_uses: number | null; expires_at: number | null }
        | undefined;
      if (!inv || (inv.expires_at && inv.expires_at < Date.now()) || (inv.max_uses && inv.uses >= inv.max_uses))
        return reply.code(404).send({ error: 'Convite inválido ou expirado' });
      if (!isMember(inv.guild_id, req.user.id)) {
        db.prepare('INSERT INTO members (guild_id, user_id, joined_at) VALUES (?, ?, ?)').run(inv.guild_id, req.user.id, Date.now());
        db.prepare('UPDATE invites SET uses = uses + 1 WHERE code = ?').run(code);
        sendToGuild(inv.guild_id, 'GUILD_MEMBER_ADD', { guild_id: inv.guild_id, user: req.user });
      }
      const payload = guildPayload(getGuild(inv.guild_id)!);
      sendToUser(req.user.id, 'GUILD_CREATE', payload);
      return payload;
    });

    // ---------- Canais ----------
    api.post('/api/guilds/:guildId/channels', async (req, reply) => {
      const { guildId } = req.params as { guildId: string };
      const guild = getGuild(guildId);
      // MVP: só o dono cria canais. Na fase 2 isso vira a permissão "Gerenciar canais".
      if (!guild || guild.owner_id !== req.user.id) return reply.code(403).send({ error: 'Só o dono do servidor pode criar canais' });
      const body = z
        .object({ name: z.string().trim().min(1).max(64), type: z.enum(['text', 'voice']) })
        .parse(req.body);
      const name = body.type === 'text' ? body.name.toLowerCase().replace(/\s+/g, '-') : body.name;
      const id = newId();
      const pos = (db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM channels WHERE guild_id = ? AND type = ?').get(guildId, body.type) as { p: number }).p;
      db.prepare('INSERT INTO channels (id, guild_id, name, type, position) VALUES (?, ?, ?, ?, ?)').run(id, guildId, name, body.type, pos);
      const ch = getChannel(id)!;
      sendToGuild(guildId, 'CHANNEL_CREATE', ch);
      return ch;
    });

    // ---------- Mensagens ----------
    api.get('/api/channels/:channelId/messages', async (req, reply) => {
      const { channelId } = req.params as { channelId: string };
      const ch = getChannel(channelId);
      if (!ch || !isMember(ch.guild_id, req.user.id)) return reply.code(403).send({ error: 'Sem acesso' });
      const { before, limit } = z
        .object({ before: z.string().optional(), limit: z.coerce.number().int().min(1).max(100).default(50) })
        .parse(req.query);
      return listMessages(channelId, before, limit);
    });

    api.post('/api/channels/:channelId/messages', async (req, reply) => {
      const { channelId } = req.params as { channelId: string };
      const ch = getChannel(channelId);
      if (!ch || ch.type !== 'text' || !isMember(ch.guild_id, req.user.id)) return reply.code(403).send({ error: 'Sem acesso' });
      const { content } = z.object({ content: z.string().trim().min(1).max(4000) }).parse(req.body);
      const id = newId();
      db.prepare('INSERT INTO messages (id, channel_id, author_id, content, created_at) VALUES (?, ?, ?, ?, ?)').run(
        id, channelId, req.user.id, content, Date.now(),
      );
      const msg = getMessage(id)!;
      sendToGuild(ch.guild_id, 'MESSAGE_CREATE', msg);
      return msg;
    });

    api.patch('/api/messages/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      const msg = getMessage(id);
      if (!msg || msg.author.id !== req.user.id) return reply.code(403).send({ error: 'Sem acesso' });
      const { content } = z.object({ content: z.string().trim().min(1).max(4000) }).parse(req.body);
      db.prepare('UPDATE messages SET content = ?, edited_at = ? WHERE id = ?').run(content, Date.now(), id);
      const updated = getMessage(id)!;
      sendToGuild(getChannel(msg.channel_id)!.guild_id, 'MESSAGE_UPDATE', updated);
      return updated;
    });

    api.delete('/api/messages/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      const msg = getMessage(id);
      if (!msg) return reply.code(404).send({ error: 'Não encontrada' });
      const ch = getChannel(msg.channel_id)!;
      const guild = getGuild(ch.guild_id)!;
      if (msg.author.id !== req.user.id && guild.owner_id !== req.user.id) return reply.code(403).send({ error: 'Sem acesso' });
      db.prepare('DELETE FROM messages WHERE id = ?').run(id);
      sendToGuild(ch.guild_id, 'MESSAGE_DELETE', { id, channel_id: ch.id });
      return { ok: true };
    });

    // ---------- Voz, câmera e transmissão de tela ----------
    api.post('/api/channels/:channelId/voice-token', async (req, reply) => {
      const { channelId } = req.params as { channelId: string };
      const ch = getChannel(channelId);
      if (!ch || ch.type !== 'voice' || !isMember(ch.guild_id, req.user.id)) return reply.code(403).send({ error: 'Sem acesso' });
      if (process.env.NODE_ENV === 'production' && !livekitConfigured)
        return reply.code(503).send({ error: 'Servidor de voz não configurado: preencha LIVEKIT_URL, LIVEKIT_API_KEY e LIVEKIT_API_SECRET no Render' });
      const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
        identity: req.user.id,
        name: req.user.display_name,
        ttl: '6h',
      });
      // Fase 2: estas fontes passam a depender das permissões "Falar" e "Vídeo" do cargo.
      at.addGrant({
        room: `voice:${ch.id}`,
        roomJoin: true,
        canPublish: true,
        canSubscribe: true,
        canPublishData: true,
        canPublishSources: [TrackSource.MICROPHONE, TrackSource.CAMERA, TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO],
      });
      return { url: LIVEKIT_URL, token: await at.toJwt() };
    });
  });
}
