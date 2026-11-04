import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { AccessToken, RoomServiceClient, TrackSource } from 'livekit-server-sdk';
import { requireAuth, signSession } from './auth.js';
import { musicSearchEnabled, searchYouTube } from './music.js';
import {
  get, run, newId, inviteCode, getChannel, getGuild, getMessage, guildPayload, guildsOf, isMember, listMessages, getUser, memberIds,
  pinnedMessages, searchMessages,
} from './db.js';
import {
  broadcastUserUpdate, getServerMod, presenceOf, presencesOf, sendToGuild, sendToUser, setServerMod, setUserStatus, setVoiceState, voiceStateOf,
} from './gateway.js';

/** Reação: um emoji (qualquer um, como no Discord). Recusa texto comum para ninguém "reagir" com palavras. */
const isEmoji = (s: string) => s.length > 0 && s.length <= 16 && /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(s) && !/[A-Za-z0-9<>]/.test(s);

/** Anexos: até 4 por mensagem, 8 MB cada (como o limite grátis do Discord). */
const MAX_FILE = 8 * 1024 * 1024;
const attachmentBody = z.object({
  name: z.string().trim().min(1).max(120),
  type: z.string().max(100).regex(/^[\w.+-]+\/[\w.+-]+$/).default('application/octet-stream'),
  data: z.string().max(Math.ceil((MAX_FILE * 4) / 3) + 8), // base64
});
/** Tipos que o navegador pode abrir direto; o resto baixa como arquivo (evita HTML/JS rodando no site). */
const INLINE_TYPES = /^(image\/(png|jpeg|gif|webp)|video\/(mp4|webm)|audio\/(mpeg|ogg|wav|webm)|text\/plain|application\/pdf)$/;

/** Payload do servidor + quem está online agora (para a lista de membros já abrir certa). */
const withPresence = <T extends { members: { id: string }[] }>(g: T) => ({ ...g, presences: presencesOf(g.members.map((m) => m.id)) });

/** Imagem pequena (foto de perfil ou ícone do servidor) em data URL. O site já reduz para 128 px. */
const imageUrl = z
  .string()
  .max(400_000, 'Imagem grande demais')
  .regex(/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/, 'Imagem inválida');
const optText = (max: number) => z.string().trim().max(max).nullable().optional().transform((v) => (v ? v : v === undefined ? undefined : null));

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
const roomService = () => new RoomServiceClient(LIVEKIT_URL.replace(/^ws/i, 'http'), LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
const voiceRoom = (channelId: string) => `voice:${channelId}`;
/** O que a pessoa pode mandar na call: sem microfone quando o dono do servidor silenciou ou ensurdeceu. */
const voiceSources = (mod: { mute: boolean; deaf: boolean }) =>
  [TrackSource.MICROPHONE, TrackSource.CAMERA, TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO].filter(
    (s) => s !== TrackSource.MICROPHONE || (!mod.mute && !mod.deaf),
  );
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
      musicSearch: musicSearchEnabled(), // busca de música pelo nome (YOUTUBE_API_KEY)
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

  app.get('/api/attachments/:id/:name', async (req, reply) => {
    const { id } = req.params as { id: string };
    const a = (await get('SELECT name, type, data FROM attachments WHERE id = ?', id)) as { name: string; type: string; data: string } | undefined;
    if (!a) return reply.code(404).send({ error: 'Arquivo não encontrado' });
    const inline = INLINE_TYPES.test(a.type);
    reply
      .header('content-type', inline ? a.type : 'application/octet-stream')
      .header('content-disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(a.name)}`)
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'public, max-age=31536000, immutable');
    return reply.send(Buffer.from(a.data, 'base64'));
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
        await sendToGuild(inv.guild_id, 'GUILD_MEMBER_ADD', { guild_id: inv.guild_id, user: req.user, status: presenceOf(req.user.id) });
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

    api.post('/api/channels/:channelId/messages', { ...messageLimit, bodyLimit: 40 * 1024 * 1024 }, async (req, reply) => {
      const { channelId } = req.params as { channelId: string };
      const ch = await getChannel(channelId);
      if (!ch || ch.type !== 'text' || !(await isMember(ch.guild_id, req.user.id))) return reply.code(403).send({ error: 'Sem acesso' });
      const body = z
        .object({
          content: z.string().trim().max(4000).default(''),
          reply_to: z.string().max(40).nullable().optional(),
          attachments: z.array(attachmentBody).max(4).default([]),
        })
        .parse(req.body);
      if (!body.content && !body.attachments.length) return reply.code(400).send({ error: 'Mensagem vazia' });
      const files = body.attachments.map((a) => ({ ...a, bytes: Buffer.from(a.data, 'base64') }));
      if (files.some((f) => f.bytes.length > MAX_FILE)) return reply.code(413).send({ error: 'Arquivo maior que 8 MB' });
      let replyTo: string | null = null;
      if (body.reply_to) {
        const ref = await getMessage(body.reply_to);
        if (ref && ref.channel_id === channelId) replyTo = ref.id;
      }
      const id = newId();
      const now = Date.now();
      await run(
        'INSERT INTO messages (id, channel_id, author_id, content, created_at, reply_to) VALUES (?, ?, ?, ?, ?, ?)',
        id, channelId, req.user.id, body.content, now, replyTo,
      );
      for (const f of files)
        await run(
          'INSERT INTO attachments (id, message_id, name, type, size, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          newId(), id, f.name.replace(/[\\/]/g, '_'), f.type, f.bytes.length, f.bytes.toString('base64'), now,
        );
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

    // ---------- Anexos ----------
    // Fora do login (como o CDN do Discord): o endereço tem um id aleatório que só quem vê a mensagem conhece.
    // (registrado lá embaixo, fora deste bloco)

    // ---------- Fixar mensagens ----------
    api.put('/api/messages/:id/pin', async (req, reply) => {
      const { id } = req.params as { id: string };
      const msg = await getMessage(id);
      const ch = msg && (await getChannel(msg.channel_id));
      if (!msg || !ch || !(await isMember(ch.guild_id, req.user.id))) return reply.code(403).send({ error: 'Sem acesso' });
      const guild = (await getGuild(ch.guild_id))!;
      if (guild.owner_id !== req.user.id && msg.author.id !== req.user.id) return reply.code(403).send({ error: 'Só o dono do servidor ou quem escreveu pode fixar' });
      const { pinned } = z.object({ pinned: z.boolean() }).parse(req.body);
      await run('UPDATE messages SET pinned = ? WHERE id = ?', pinned ? 1 : 0, id);
      const updated = (await getMessage(id))!;
      await sendToGuild(ch.guild_id, 'MESSAGE_UPDATE', updated);
      return updated;
    });

    api.get('/api/channels/:channelId/pins', async (req, reply) => {
      const { channelId } = req.params as { channelId: string };
      const ch = await getChannel(channelId);
      if (!ch || !(await isMember(ch.guild_id, req.user.id))) return reply.code(403).send({ error: 'Sem acesso' });
      return pinnedMessages(channelId);
    });

    // Busca de música pelo nome ("Ouvir junto"). Limite por pessoa para não gastar a cota do YouTube.
    api.get(
      '/api/music/search',
      { config: { rateLimit: { max: 15, timeWindow: '1 minute', keyGenerator: (req: { user?: { id: string }; ip: string }) => req.user?.id ?? req.ip } } },
      async (req) => {
        const { q } = z.object({ q: z.string().trim().min(1).max(100) }).parse(req.query);
        return { results: await searchYouTube(q) };
      },
    );

    api.get('/api/guilds/:guildId/search', async (req, reply) => {
      const { guildId } = req.params as { guildId: string };
      if (!(await isMember(guildId, req.user.id))) return reply.code(403).send({ error: 'Sem acesso' });
      const { q } = z.object({ q: z.string().trim().min(1).max(100) }).parse(req.query);
      return searchMessages(guildId, q);
    });

    // ---------- Reações ----------
    api.put('/api/messages/:id/reactions/:emoji', messageLimit, async (req, reply) => {
      const { id, emoji } = req.params as { id: string; emoji: string };
      if (!isEmoji(emoji)) return reply.code(400).send({ error: 'Reação inválida' });
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
      const mod = getServerMod(ch.guild_id, req.user.id);
      at.addGrant({
        room: voiceRoom(ch.id),
        roomJoin: true,
        canPublish: true,
        canSubscribe: true,
        canPublishData: true,
        canPublishSources: voiceSources(mod),
      });
      return { url: LIVEKIT_URL, token: await at.toJwt(), server_mute: mod.mute, server_deaf: mod.deaf };
    });

    // ---------- Minha conta e perfil ----------
    api.patch('/api/users/@me', async (req, reply) => {
      const body = z
        .object({
          display_name: z.string().trim().min(1).max(32).optional(),
          username: credentials.shape.username.optional(),
          avatar: imageUrl.nullable().optional(),
          bio: optText(190),
          pronouns: optText(40),
          banner_color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
          custom_status: optText(128),
        })
        .parse(req.body);
      if (body.username && (await get('SELECT 1 AS ok FROM users WHERE lower(username) = lower(?) AND id <> ?', body.username, req.user.id)))
        return reply.code(400).send({ error: 'Esse usuário já existe' });
      const cols = (['display_name', 'username', 'avatar', 'bio', 'pronouns', 'banner_color', 'custom_status'] as const).filter((k) => body[k] !== undefined);
      if (cols.length)
        await run(`UPDATE users SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, ...cols.map((c) => body[c]), req.user.id);
      const user = (await getUser(req.user.id))!;
      await broadcastUserUpdate(user);
      return user;
    });

    api.post('/api/users/@me/password', authLimit, async (req, reply) => {
      const body = z.object({ current: z.string().min(1).max(128), password: credentials.shape.password }).parse(req.body);
      const row = (await get('SELECT password_hash FROM users WHERE id = ?', req.user.id)) as { password_hash: string };
      if (!(await bcrypt.compare(body.current, row.password_hash))) return reply.code(400).send({ error: 'Senha atual incorreta' });
      await run('UPDATE users SET password_hash = ? WHERE id = ?', await bcrypt.hash(body.password, 10), req.user.id);
      return { ok: true };
    });

    api.put('/api/users/@me/status', async (req) => {
      const { status } = z.object({ status: z.enum(['online', 'idle', 'dnd', 'invisible']) }).parse(req.body);
      await run('UPDATE users SET status = ? WHERE id = ?', status, req.user.id);
      await setUserStatus(req.user.id, status);
      return { status };
    });

    // ---------- Configurações do servidor (só o dono) ----------
    const ownedGuild = async (guildId: string, userId: string) => {
      const g = await getGuild(guildId);
      return g && g.owner_id === userId ? g : undefined;
    };

    api.patch('/api/guilds/:guildId', async (req, reply) => {
      const { guildId } = req.params as { guildId: string };
      if (!(await ownedGuild(guildId, req.user.id))) return reply.code(403).send({ error: 'Só o dono do servidor pode fazer isso' });
      const body = z.object({ name: z.string().trim().min(1).max(64).optional(), icon: imageUrl.nullable().optional() }).parse(req.body);
      if (body.name !== undefined) await run('UPDATE guilds SET name = ? WHERE id = ?', body.name, guildId);
      if (body.icon !== undefined) await run('UPDATE guilds SET icon = ? WHERE id = ?', body.icon, guildId);
      const g = (await getGuild(guildId))!;
      await sendToGuild(guildId, 'GUILD_UPDATE', g);
      return g;
    });

    /** Tira a pessoa do servidor (saiu, foi expulsa ou o servidor foi apagado): sai da voz e some a lista. */
    const removeMember = async (guildId: string, userId: string) => {
      const v = voiceStateOf(userId);
      if (v && v.guildId === guildId) {
        await setVoiceState({ id: userId }, null);
        await roomService().removeParticipant(voiceRoom(v.channelId), userId).catch(() => {});
      }
      await run('DELETE FROM members WHERE guild_id = ? AND user_id = ?', guildId, userId);
      sendToUser(userId, 'GUILD_DELETE', { id: guildId });
      await sendToGuild(guildId, 'GUILD_MEMBER_REMOVE', { guild_id: guildId, user_id: userId });
    };

    api.delete('/api/guilds/:guildId', async (req, reply) => {
      const { guildId } = req.params as { guildId: string };
      if (!(await ownedGuild(guildId, req.user.id))) return reply.code(403).send({ error: 'Só o dono do servidor pode apagar' });
      const ids = await memberIds(guildId);
      for (const id of ids) {
        const v = voiceStateOf(id);
        if (v && v.guildId === guildId) {
          await setVoiceState({ id }, null);
          await roomService().removeParticipant(voiceRoom(v.channelId), id).catch(() => {});
        }
      }
      await run('DELETE FROM guilds WHERE id = ?', guildId);
      for (const id of ids) sendToUser(id, 'GUILD_DELETE', { id: guildId });
      return { ok: true };
    });

    api.delete('/api/guilds/:guildId/members/:userId', async (req, reply) => {
      const { guildId, userId: rawId } = req.params as { guildId: string; userId: string };
      const userId = rawId === '@me' ? req.user.id : rawId;
      const guild = await getGuild(guildId);
      if (!guild || !(await isMember(guildId, userId))) return reply.code(404).send({ error: 'Essa pessoa não está no servidor' });
      if (userId === req.user.id) {
        if (guild.owner_id === userId) return reply.code(400).send({ error: 'O dono não pode sair. Apague o servidor nas configurações dele.' });
      } else if (guild.owner_id !== req.user.id) return reply.code(403).send({ error: 'Só o dono do servidor pode expulsar' });
      await removeMember(guildId, userId);
      return { ok: true };
    });

    api.patch('/api/channels/:channelId', async (req, reply) => {
      const { channelId } = req.params as { channelId: string };
      const ch = await getChannel(channelId);
      if (!ch || !(await ownedGuild(ch.guild_id, req.user.id))) return reply.code(403).send({ error: 'Só o dono do servidor pode fazer isso' });
      const body = z.object({ name: z.string().trim().min(1).max(64).optional(), topic: optText(1024) }).parse(req.body);
      if (body.name !== undefined)
        await run('UPDATE channels SET name = ? WHERE id = ?', ch.type === 'text' ? body.name.toLowerCase().replace(/\s+/g, '-') : body.name, ch.id);
      if (body.topic !== undefined) await run('UPDATE channels SET topic = ? WHERE id = ?', body.topic, ch.id);
      const updated = (await getChannel(ch.id))!;
      await sendToGuild(ch.guild_id, 'CHANNEL_UPDATE', updated);
      return updated;
    });

    api.delete('/api/channels/:channelId', async (req, reply) => {
      const { channelId } = req.params as { channelId: string };
      const ch = await getChannel(channelId);
      if (!ch || !(await ownedGuild(ch.guild_id, req.user.id))) return reply.code(403).send({ error: 'Só o dono do servidor pode fazer isso' });
      if (ch.type === 'text' && ((await get("SELECT COUNT(*) AS n FROM channels WHERE guild_id = ? AND type = 'text'", ch.guild_id)) as { n: number }).n <= 1)
        return reply.code(400).send({ error: 'O servidor precisa de pelo menos um canal de texto' });
      if (ch.type === 'voice') {
        for (const id of await memberIds(ch.guild_id))
          if (voiceStateOf(id)?.channelId === ch.id) await setVoiceState({ id }, null);
        await roomService().deleteRoom(voiceRoom(ch.id)).catch(() => {});
      }
      await run('DELETE FROM channels WHERE id = ?', ch.id);
      await sendToGuild(ch.guild_id, 'CHANNEL_DELETE', { id: ch.id, guild_id: ch.guild_id });
      return { ok: true };
    });

    // ---------- Moderação de voz (só o dono do servidor) ----------
    const modBody = z.object({
      action: z.enum(['mute', 'unmute', 'deafen', 'undeafen', 'disconnect', 'move']),
      channel_id: z.string().optional(),
    });
    api.post('/api/guilds/:guildId/members/:userId/voice', async (req, reply) => {
      const { guildId, userId } = req.params as { guildId: string; userId: string };
      const body = modBody.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'Ação inválida' });
      const guild = await getGuild(guildId);
      if (!guild || guild.owner_id !== req.user.id) return reply.code(403).send({ error: 'Só o dono do servidor pode fazer isso' });
      if (!(await isMember(guildId, userId))) return reply.code(404).send({ error: 'Essa pessoa não está no servidor' });
      const { action, channel_id } = body.data;
      const v = voiceStateOf(userId);
      const inVoice = v && v.guildId === guildId ? v : undefined;
      const by = req.user.display_name;

      if (action === 'mute' || action === 'unmute' || action === 'deafen' || action === 'undeafen') {
        const patch = action === 'mute' || action === 'unmute' ? { mute: action === 'mute' } : { deaf: action === 'deafen' };
        const next = { ...getServerMod(guildId, userId), ...patch };
        // Primeiro o LiveKit (tira ou devolve a permissão do microfone), depois avisa todo mundo:
        // assim, quando a pessoa recebe o "pode falar", o microfone já está liberado.
        if (inVoice) {
          const room = voiceRoom(inVoice.channelId);
          try {
            const svc = roomService();
            if (next.mute || next.deaf) {
              const p = await svc.getParticipant(room, userId);
              const mic = p.tracks.find((t) => t.source === TrackSource.MICROPHONE);
              if (mic) await svc.mutePublishedTrack(room, userId, mic.sid, true);
            }
            await svc.updateParticipant(room, userId, {
              permission: { canPublish: true, canSubscribe: true, canPublishData: true, canPublishSources: voiceSources(next) },
            });
          } catch (e) {
            req.log.warn(e, 'moderação de voz: LiveKit não respondeu');
          }
        }
        await setServerMod(guildId, userId, patch);
        if (action === 'mute' || action === 'deafen') sendToUser(userId, 'VOICE_SERVER_ACTION', { action, by });
        return { ok: true, ...next };
      }

      if (!inVoice) return reply.code(409).send({ error: 'Essa pessoa não está em nenhum canal de voz' });
      if (action === 'disconnect') {
        sendToUser(userId, 'VOICE_SERVER_ACTION', { action, by });
        await setVoiceState({ id: userId }, null);
        await roomService().removeParticipant(voiceRoom(inVoice.channelId), userId).catch(() => {});
        return { ok: true };
      }
      // Mover: o site da pessoa troca de canal sozinho. Se em 5 s ela ainda estiver no canal antigo, é tirada de lá.
      const target = channel_id ? await getChannel(channel_id) : undefined;
      if (!target || target.type !== 'voice' || target.guild_id !== guildId) return reply.code(400).send({ error: 'Canal de voz inválido' });
      if (target.id === inVoice.channelId) return { ok: true };
      const from = inVoice.channelId;
      sendToUser(userId, 'VOICE_SERVER_ACTION', { action, by, channel_id: target.id });
      setTimeout(() => {
        if (voiceStateOf(userId)?.channelId === from)
          void setVoiceState({ id: userId }, null).then(() => roomService().removeParticipant(voiceRoom(from), userId)).catch(() => {});
      }, 5000);
      return { ok: true };
    });
  });
}
