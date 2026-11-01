import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { AccessToken, RoomServiceClient, TrackSource } from 'livekit-server-sdk';
import { requireAuth, signSession } from './auth.js';
import {
  get, run, newId, inviteCode, getChannel, getGuild, getMessage, guildPayload, guildsOf, isMember, listMessages, getUser,
} from './db.js';
import { isOnline, sendToGuild, sendToUser } from './gateway.js';

/** Emojis aceitos nas reações (o mesmo conjunto aparece no site). */
const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🔥', '🎉', '👀'];

/** Payload do servidor + quem está online agora (para a lista de membros já abrir certa). */
const withPresence = <T extends { members: { id: string }[] }>(g: T) => ({ ...g, online: g.members.filter((m) => isOnline(m.id)).map((m) => m.id) });

// Valores colados em painéis de deploy costumam vir com espaço ou quebra de linha: limpamos tudo.
const env = (k: string) => process.env[k]?.trim().replace(/^["']|["']$/g, '').trim() || undefined;
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
  // Diagnóstico sem segredos: mostra se a voz está configurada e para onde o cliente vai conectar.
  // Também testa a chave de verdade no LiveKit (lista as salas) e mostra só pistas que não são segredo.
  app.get('/api/voice-config', async () => {
    let credentials: 'ok' | 'invalid' | 'unreachable' | 'not-tested' = 'not-tested';
    let detail: string | undefined;
    if (livekitConfigured) {
      try {
        await new RoomServiceClient(LIVEKIT_URL.replace(/^ws/i, 'http'), LIVEKIT_API_KEY, LIVEKIT_API_SECRET).listRooms();
        credentials = 'ok';
      } catch (e) {
        detail = (e as Error).message.replace(/eyJ[\w.-]+/g, '…'); // nunca devolver o token
        credentials = /401|unauthor|invalid|token|permission/i.test(detail) ? 'invalid' : 'unreachable';
      }
    }
    return {
      configured: livekitConfigured,
      url: LIVEKIT_URL,
      credentials,
      detail,
      apiKeyStartsWith: LIVEKIT_API_KEY.slice(0, 3), // chaves do LiveKit começam com "API"
      apiKeyLength: LIVEKIT_API_KEY.length,
      apiSecretLength: LIVEKIT_API_SECRET.length,
    };
  });

  // ---------- Contas ----------
  // Limite contra força bruta: 10 tentativas por minuto por IP.
  const authLimit = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

  app.post('/api/auth/register', authLimit, async (req) => {
    const body = credentials.parse(req.body);
    if (await get('SELECT 1 AS ok FROM users WHERE lower(username) = lower(?)', body.username)) throw bad('Esse usuário já existe');
    const id = newId();
    await run(
      'INSERT INTO users (id, username, display_name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)',
      id, body.username, body.display_name ?? body.username, await bcrypt.hash(body.password, 10), Date.now(),
    );
    return { token: await signSession(id), user: await getUser(id) };
  });

  app.post('/api/auth/login', authLimit, async (req, reply) => {
    const body = credentials.pick({ username: true, password: true }).parse(req.body);
    const row = (await get('SELECT id, password_hash FROM users WHERE lower(username) = lower(?)', body.username)) as
      | { id: string; password_hash: string }
      | undefined;
    if (!row || !(await bcrypt.compare(body.password, row.password_hash)))
      return reply.code(401).send({ error: 'Usuário ou senha incorretos' });
    return { token: await signSession(row.id), user: await getUser(row.id) };
  });

  // Tudo abaixo exige login
  app.register(async (api) => {
    api.addHook('preHandler', requireAuth);

    api.get('/api/me', async (req) => ({
      user: req.user,
      guilds: await Promise.all((await guildsOf(req.user.id)).map(guildPayload)),
    }));

    // ---------- Servidores ----------
    api.post('/api/guilds', async (req) => {
      const { name } = z.object({ name: z.string().trim().min(1).max(64) }).parse(req.body);
      const id = newId();
      const now = Date.now();
      await run('INSERT INTO guilds (id, name, owner_id, created_at) VALUES (?, ?, ?, ?)', id, name, req.user.id, now);
      await run('INSERT INTO members (guild_id, user_id, joined_at) VALUES (?, ?, ?)', id, req.user.id, now);
      const ins = 'INSERT INTO channels (id, guild_id, name, type, position) VALUES (?, ?, ?, ?, ?)';
      await run(ins, newId(), id, 'geral', 'text', 0);
      await run(ins, newId(), id, 'Geral', 'voice', 0);
      const payload = await guildPayload((await getGuild(id))!);
      sendToUser(req.user.id, 'GUILD_CREATE', withPresence(payload));
      return payload;
    });

    api.post('/api/guilds/:guildId/invites', async (req, reply) => {
      const { guildId } = req.params as { guildId: string };
      if (!(await isMember(guildId, req.user.id))) return reply.code(403).send({ error: 'Sem acesso' });
      const opts = z
        .object({ max_uses: z.number().int().positive().nullable().optional(), expires_in_hours: z.number().positive().nullable().optional() })
        .parse(req.body ?? {});
      const code = inviteCode();
      await run(
        'INSERT INTO invites (code, guild_id, creator_id, max_uses, expires_at) VALUES (?, ?, ?, ?, ?)',
        code, guildId, req.user.id, opts.max_uses ?? null,
        opts.expires_in_hours ? Date.now() + opts.expires_in_hours * 3_600_000 : Date.now() + 7 * 86_400_000,
      );
      return { code };
    });

    api.post('/api/invites/:code', async (req, reply) => {
      const { code } = req.params as { code: string };
      const inv = (await get('SELECT * FROM invites WHERE code = ?', code)) as
        | { guild_id: string; uses: number; max_uses: number | null; expires_at: number | null }
        | undefined;
      if (!inv || (inv.expires_at && inv.expires_at < Date.now()) || (inv.max_uses && inv.uses >= inv.max_uses))
        return reply.code(404).send({ error: 'Convite inválido ou expirado' });
      if (!(await isMember(inv.guild_id, req.user.id))) {
        await run('INSERT INTO members (guild_id, user_id, joined_at) VALUES (?, ?, ?)', inv.guild_id, req.user.id, Date.now());
        await run('UPDATE invites SET uses = uses + 1 WHERE code = ?', code);
        await sendToGuild(inv.guild_id, 'GUILD_MEMBER_ADD', { guild_id: inv.guild_id, user: req.user, online: isOnline(req.user.id) });
      }
      const payload = await guildPayload((await getGuild(inv.guild_id))!);
      sendToUser(req.user.id, 'GUILD_CREATE', withPresence(payload));
      return payload;
    });

    // ---------- Canais ----------
    api.post('/api/guilds/:guildId/channels', async (req, reply) => {
      const { guildId } = req.params as { guildId: string };
      const guild = await getGuild(guildId);
      // MVP: só o dono cria canais. Na fase 2 isso vira a permissão "Gerenciar canais".
      if (!guild || guild.owner_id !== req.user.id) return reply.code(403).send({ error: 'Só o dono do servidor pode criar canais' });
      const body = z
        .object({ name: z.string().trim().min(1).max(64), type: z.enum(['text', 'voice']) })
        .parse(req.body);
      const name = body.type === 'text' ? body.name.toLowerCase().replace(/\s+/g, '-') : body.name;
      const id = newId();
      const pos = ((await get(
        'SELECT COALESCE(MAX(position), -1) + 1 AS p FROM channels WHERE guild_id = ? AND type = ?', guildId, body.type,
      )) as { p: number }).p;
      await run('INSERT INTO channels (id, guild_id, name, type, position) VALUES (?, ?, ?, ?, ?)', id, guildId, name, body.type, pos);
      const ch = (await getChannel(id))!;
      await sendToGuild(guildId, 'CHANNEL_CREATE', ch);
      return ch;
    });

    // ---------- Mensagens ----------
    api.get('/api/channels/:channelId/messages', async (req, reply) => {
      const { channelId } = req.params as { channelId: string };
      const ch = await getChannel(channelId);
      if (!ch || !(await isMember(ch.guild_id, req.user.id))) return reply.code(403).send({ error: 'Sem acesso' });
      const { before, limit } = z
        .object({ before: z.string().optional(), limit: z.coerce.number().int().min(1).max(100).default(50) })
        .parse(req.query);
      return listMessages(channelId, before, limit);
    });

    // Limite anti-spam: 20 mensagens a cada 10 segundos por usuário.
    const messageLimit = {
      config: { rateLimit: { max: 20, timeWindow: '10 seconds', keyGenerator: (req: { user?: { id: string }; ip: string }) => req.user?.id ?? req.ip } },
    };

    api.post('/api/channels/:channelId/messages', messageLimit, async (req, reply) => {
      const { channelId } = req.params as { channelId: string };
      const ch = await getChannel(channelId);
      if (!ch || ch.type !== 'text' || !(await isMember(ch.guild_id, req.user.id))) return reply.code(403).send({ error: 'Sem acesso' });
      const { content } = z.object({ content: z.string().trim().min(1).max(4000) }).parse(req.body);
      const id = newId();
      await run('INSERT INTO messages (id, channel_id, author_id, content, created_at) VALUES (?, ?, ?, ?, ?)', id, channelId, req.user.id, content, Date.now());
      const msg = (await getMessage(id))!;
      await sendToGuild(ch.guild_id, 'MESSAGE_CREATE', msg);
      return msg;
    });

    api.patch('/api/messages/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      const msg = await getMessage(id);
      if (!msg || msg.author.id !== req.user.id) return reply.code(403).send({ error: 'Sem acesso' });
      const { content } = z.object({ content: z.string().trim().min(1).max(4000) }).parse(req.body);
      await run('UPDATE messages SET content = ?, edited_at = ? WHERE id = ?', content, Date.now(), id);
      const updated = (await getMessage(id))!;
      await sendToGuild((await getChannel(msg.channel_id))!.guild_id, 'MESSAGE_UPDATE', updated);
      return updated;
    });

    api.delete('/api/messages/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      const msg = await getMessage(id);
      if (!msg) return reply.code(404).send({ error: 'Não encontrada' });
      const ch = (await getChannel(msg.channel_id))!;
      const guild = (await getGuild(ch.guild_id))!;
      if (msg.author.id !== req.user.id && guild.owner_id !== req.user.id) return reply.code(403).send({ error: 'Sem acesso' });
      await run('DELETE FROM messages WHERE id = ?', id);
      await sendToGuild(ch.guild_id, 'MESSAGE_DELETE', { id, channel_id: ch.id });
      return { ok: true };
    });

    // ---------- Reações ----------
    api.put('/api/messages/:id/reactions/:emoji', messageLimit, async (req, reply) => {
      const { id, emoji } = req.params as { id: string; emoji: string };
      if (!REACTIONS.includes(emoji)) return reply.code(400).send({ error: 'Reação inválida' });
      const msg = await getMessage(id);
      const ch = msg && (await getChannel(msg.channel_id));
      if (!msg || !ch || !(await isMember(ch.guild_id, req.user.id))) return reply.code(403).send({ error: 'Sem acesso' });
      const on = (req.body as { on?: boolean } | undefined)?.on !== false;
      if (on)
        await run(
          'INSERT INTO reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING',
          id, req.user.id, emoji, Date.now(),
        );
      else await run('DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?', id, req.user.id, emoji);
      const updated = (await getMessage(id))!;
      await sendToGuild(ch.guild_id, 'MESSAGE_UPDATE', updated);
      return updated;
    });

    // ---------- Voz, câmera e transmissão de tela ----------
    api.post('/api/channels/:channelId/voice-token', async (req, reply) => {
      const { channelId } = req.params as { channelId: string };
      const ch = await getChannel(channelId);
      if (!ch || ch.type !== 'voice' || !(await isMember(ch.guild_id, req.user.id))) return reply.code(403).send({ error: 'Sem acesso' });
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
