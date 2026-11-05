import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { AccessToken, RoomServiceClient, TrackSource } from 'livekit-server-sdk';
import { requireAuth, signSession } from './auth.js';
import { musicSearchEnabled, searchYouTube } from './music.js';
import {
  get, run, newId, inviteCode, getChannel, getGuild, getMessage, guildsOf, isMember, listMessages, getUser, memberIds,
  pinnedMessages, searchMessages, relationshipsOf, relationshipType, findDm, channelsOf, DEFAULT_EVERYONE_PERMS, type Channel,
} from './db.js';
import {
  broadcastUserUpdate, getServerMod, presenceOf, presencesOf, sendToChannel, sendToGuild, sendToUser, setServerMod, setUserStatus, setVoiceState, voiceStateOf,
} from './gateway.js';
import { TEMPLATES, TEMPLATE_IDS } from './templates.js';
import { pushMessage, pushPublicKey, removeSubscription, saveSubscription } from './push.js';
import { ALL_PERMS, CHANNEL_PERMS, channelWithOverwrites, guildPayload, P, permContext, type PermContext } from './permissions.js';

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
/**
 * O que a pessoa pode mandar na call: sem microfone quando foi silenciada/ensurdecida no servidor
 * ou não tem a permissão "Falar"; sem câmera e tela sem a permissão "Transmitir".
 */
const voiceSources = (mod: { mute: boolean; deaf: boolean }, perms: number) =>
  [TrackSource.MICROPHONE, TrackSource.CAMERA, TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO].filter((s) =>
    s === TrackSource.MICROPHONE ? !mod.mute && !mod.deaf && !!(perms & P.SPEAK) : !!(perms & P.STREAM),
  );
const voicePermission = (mod: { mute: boolean; deaf: boolean }, perms: number) => ({
  canPublish: true, canSubscribe: true, canPublishData: true, canPublishSources: voiceSources(mod, perms),
});
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
const NO_PERM = 'Você não tem permissão para isso';
const roleColor = z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable();
const permBits = z.number().int().min(0).max(ALL_PERMS);

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

    /** A pessoa tem a permissão nesse canal? `guildWide`: permissão do servidor (ex.: gerenciar canais), nunca em conversa direta. */
    const canIn = async (ch: Pick<Channel, 'id' | 'guild_id'>, userId: string, perm: number, guildWide = false) => {
      const ctx = await permContext(ch.guild_id);
      if (!ctx) return false;
      if (guildWide) return !ctx.isDm && ctx.can(userId, perm);
      return ctx.can(userId, perm, ch.id);
    };

    /** Canal criado ou mudou: quem pode ver recebe a versão nova; quem perdeu o acesso vê o canal sumir. */
    const syncChannel = async (ch: Channel, ctx?: PermContext) => {
      const c = ctx ?? (await permContext(ch.guild_id));
      if (!c) return;
      const last = (await get('SELECT MAX(id) AS id FROM messages WHERE channel_id = ?', ch.id)) as { id: string | null } | undefined;
      const full = { ...channelWithOverwrites(ch, c), last_message_id: last?.id ?? null };
      for (const id of c.members)
        if (c.can(id, P.VIEW_CHANNEL, ch.id)) sendToUser(id, 'CHANNEL_UPDATE', full);
        else sendToUser(id, 'CHANNEL_DELETE', { id: ch.id, guild_id: ch.guild_id });
      await applyVoicePerms(c);
    };

    /**
     * Cargos mudaram: cada membro recebe os cargos, os cargos de cada um e os canais que agora pode ver.
     * Quem está na voz tem as permissões do LiveKit atualizadas (ou sai, se perdeu o acesso ao canal).
     */
    const syncGuild = async (guildId: string) => {
      const ctx = await permContext(guildId);
      if (!ctx) return;
      const channels = await channelsOf(guildId);
      const member_roles = Object.fromEntries(ctx.memberRoles);
      for (const id of ctx.members)
        sendToUser(id, 'GUILD_SYNC', {
          id: guildId,
          roles: ctx.roles,
          member_roles,
          channels: channels.filter((c) => ctx.can(id, P.VIEW_CHANNEL, c.id)).map((c) => channelWithOverwrites(c, ctx)),
        });
      await applyVoicePerms(ctx);
    };

    const applyVoicePerms = async (ctx: NonNullable<PermContext>) => {
      for (const id of ctx.members) {
        const v = voiceStateOf(id);
        if (!v || v.guildId !== ctx.guild.id) continue;
        const room = voiceRoom(v.channelId);
        if (!ctx.can(id, P.VIEW_CHANNEL | P.CONNECT, v.channelId)) {
          sendToUser(id, 'VOICE_SERVER_ACTION', { action: 'disconnect', by: 'Uma mudança de permissões' });
          await setVoiceState({ id }, null);
          await roomService().removeParticipant(room, id).catch(() => {});
          continue;
        }
        await roomService()
          .updateParticipant(room, id, { permission: voicePermission(getServerMod(ctx.guild.id, id), ctx.perms(id, v.channelId)) })
          .catch(() => {});
      }
    };

    // ---------- Cargos ----------
    /** Contexto de quem gerencia cargos num servidor de verdade (não conversa direta). */
    const roleManager = async (guildId: string, userId: string) => {
      const ctx = await permContext(guildId);
      return ctx && !ctx.isDm && ctx.can(userId, P.MANAGE_ROLES) ? ctx : undefined;
    };
    /** Só dá para dar ou tirar permissões que você mesmo tem (o dono e administradores têm todas). */
    const grantsOnlyOwn = (ctx: NonNullable<PermContext>, userId: string, before: number, after: number) =>
      ((before ^ after) & ~ctx.perms(userId)) === 0;

    api.post('/api/guilds/:guildId/roles', async (req, reply) => {
      const { guildId } = req.params as { guildId: string };
      const ctx = await roleManager(guildId, req.user.id);
      if (!ctx) return reply.code(403).send({ error: NO_PERM });
      if (ctx.roles.length >= 100) return reply.code(400).send({ error: 'Limite de 100 cargos por servidor' });
      const body = z
        .object({ name: z.string().trim().min(1).max(64).default('novo cargo'), color: roleColor.optional(), permissions: permBits.default(0), hoist: z.boolean().default(false) })
        .parse(req.body ?? {});
      if (!grantsOnlyOwn(ctx, req.user.id, 0, body.permissions)) return reply.code(403).send({ error: 'Você só pode dar permissões que você tem' });
      // Cargo novo entra logo acima do @everyone (como no Discord); os outros sobem uma posição.
      await run('UPDATE roles SET position = position + 1 WHERE guild_id = ? AND id <> ?', guildId, guildId);
      const id = newId();
      await run(
        'INSERT INTO roles (id, guild_id, name, color, permissions, position, hoist, created_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)',
        id, guildId, body.name, body.color ?? null, body.permissions, body.hoist ? 1 : 0, Date.now(),
      );
      await syncGuild(guildId);
      return (await permContext(guildId))!.roles.find((r) => r.id === id);
    });

    api.patch('/api/guilds/:guildId/roles/:roleId', async (req, reply) => {
      const { guildId, roleId } = req.params as { guildId: string; roleId: string };
      const ctx = await roleManager(guildId, req.user.id);
      const role = ctx?.roles.find((r) => r.id === roleId);
      if (!ctx || !role) return reply.code(403).send({ error: NO_PERM });
      if (role.position >= ctx.top(req.user.id)) return reply.code(403).send({ error: 'Você só pode editar cargos abaixo do seu cargo mais alto' });
      const body = z
        .object({ name: z.string().trim().min(1).max(64).optional(), color: roleColor.optional(), permissions: permBits.optional(), hoist: z.boolean().optional() })
        .parse(req.body);
      const everyone = role.id === guildId;
      if (everyone && (body.name !== undefined || body.color !== undefined || body.hoist !== undefined))
        return reply.code(400).send({ error: 'No @everyone só dá para mudar as permissões' });
      if (body.permissions !== undefined && !grantsOnlyOwn(ctx, req.user.id, role.permissions, body.permissions))
        return reply.code(403).send({ error: 'Você só pode dar ou tirar permissões que você tem' });
      if (body.name !== undefined) await run('UPDATE roles SET name = ? WHERE id = ?', body.name, roleId);
      if (body.color !== undefined) await run('UPDATE roles SET color = ? WHERE id = ?', body.color, roleId);
      if (body.permissions !== undefined) await run('UPDATE roles SET permissions = ? WHERE id = ?', body.permissions, roleId);
      if (body.hoist !== undefined) await run('UPDATE roles SET hoist = ? WHERE id = ?', body.hoist ? 1 : 0, roleId);
      await syncGuild(guildId);
      return (await permContext(guildId))!.roles.find((r) => r.id === roleId);
    });

    api.delete('/api/guilds/:guildId/roles/:roleId', async (req, reply) => {
      const { guildId, roleId } = req.params as { guildId: string; roleId: string };
      const ctx = await roleManager(guildId, req.user.id);
      const role = ctx?.roles.find((r) => r.id === roleId);
      if (!ctx || !role) return reply.code(403).send({ error: NO_PERM });
      if (roleId === guildId) return reply.code(400).send({ error: 'O @everyone não pode ser apagado' });
      if (role.position >= ctx.top(req.user.id)) return reply.code(403).send({ error: 'Você só pode apagar cargos abaixo do seu cargo mais alto' });
      await run('DELETE FROM roles WHERE id = ?', roleId);
      await syncGuild(guildId);
      return { ok: true };
    });

    // Nova ordem dos cargos (do mais alto para o mais baixo, sem o @everyone).
    // Quem não é o dono não mexe nos cargos do seu nível para cima.
    api.put('/api/guilds/:guildId/roles/order', async (req, reply) => {
      const { guildId } = req.params as { guildId: string };
      const ctx = await roleManager(guildId, req.user.id);
      if (!ctx) return reply.code(403).send({ error: NO_PERM });
      const { ids } = z.object({ ids: z.array(z.string()).max(100) }).parse(req.body);
      const current = ctx.roles.filter((r) => r.id !== guildId); // já vem do mais alto para o mais baixo
      if (ids.length !== current.length || new Set(ids).size !== ids.length || !ids.every((id) => current.some((r) => r.id === id)))
        return reply.code(400).send({ error: 'Lista de cargos desatualizada. Recarregue e tente de novo.' });
      const n = current.length;
      const oldPos = new Map(current.map((r, i) => [r.id, n - i]));
      const mine = ctx.memberRoles.get(req.user.id) ?? [];
      const myTop = ctx.isOwner(req.user.id) ? Infinity : Math.max(0, ...mine.map((id) => oldPos.get(id) ?? 0));
      for (const [i, id] of ids.entries())
        if (oldPos.get(id)! >= myTop && n - i !== oldPos.get(id)) return reply.code(403).send({ error: 'Você só pode reordenar cargos abaixo do seu' });
      for (const [i, id] of ids.entries()) await run('UPDATE roles SET position = ? WHERE id = ?', n - i, id);
      await syncGuild(guildId);
      return { ok: true };
    });

    // Dar ou tirar um cargo de alguém.
    for (const method of ['put', 'delete'] as const)
      api[method]('/api/guilds/:guildId/members/:userId/roles/:roleId', async (req, reply) => {
        const { guildId, userId, roleId } = req.params as { guildId: string; userId: string; roleId: string };
        const ctx = await roleManager(guildId, req.user.id);
        const role = ctx?.roles.find((r) => r.id === roleId);
        if (!ctx || !role || roleId === guildId) return reply.code(403).send({ error: NO_PERM });
        if (!ctx.members.has(userId)) return reply.code(404).send({ error: 'Essa pessoa não está no servidor' });
        if (role.position >= ctx.top(req.user.id)) return reply.code(403).send({ error: 'Você só pode dar cargos abaixo do seu cargo mais alto' });
        if (method === 'put')
          await run('INSERT INTO member_roles (guild_id, user_id, role_id) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', guildId, userId, roleId);
        else await run('DELETE FROM member_roles WHERE user_id = ? AND role_id = ?', userId, roleId);
        await syncGuild(guildId);
        return { ok: true };
      });

    // Permissões de um cargo num canal (canal privado = @everyone sem "Ver canal").
    api.put('/api/channels/:channelId/overwrites/:roleId', async (req, reply) => {
      const { channelId, roleId } = req.params as { channelId: string; roleId: string };
      const ch = await getChannel(channelId);
      const ctx = ch && (await permContext(ch.guild_id));
      if (!ch || !ctx || ctx.isDm || !ctx.can(req.user.id, P.MANAGE_CHANNELS)) return reply.code(403).send({ error: NO_PERM });
      if (!ctx.roles.some((r) => r.id === roleId)) return reply.code(404).send({ error: 'Cargo não encontrado' });
      const body = z.object({ allow: permBits, deny: permBits }).parse(req.body);
      if ((body.allow | body.deny) & ~CHANNEL_PERMS) return reply.code(400).send({ error: 'Essa permissão não vale por canal' });
      const old = ctx.overwrites.get(ch.id)?.find((o) => o.id === roleId) ?? { allow: 0, deny: 0 };
      const changed = (old.allow ^ body.allow) | (old.deny ^ body.deny);
      if (changed & ~ctx.perms(req.user.id)) return reply.code(403).send({ error: 'Você só pode mexer em permissões que você tem' });
      const allow = body.allow & ~body.deny;
      if (!allow && !body.deny) await run('DELETE FROM channel_overwrites WHERE channel_id = ? AND target_id = ?', ch.id, roleId);
      else
        await run(
          'INSERT INTO channel_overwrites (channel_id, target_id, allow, deny) VALUES (?, ?, ?, ?) ON CONFLICT (channel_id, target_id) DO UPDATE SET allow = excluded.allow, deny = excluded.deny',
          ch.id, roleId, allow, body.deny,
        );
      await syncChannel(ch);
      return { ok: true };
    });

    api.get('/api/me', async (req) => ({
      user: req.user,
      guilds: await Promise.all((await guildsOf(req.user.id)).map((g) => guildPayload(g, req.user.id))),
    }));

    // ---------- Servidores ----------
    api.post('/api/guilds', async (req) => {
      const body = z
        .object({ name: z.string().trim().min(1).max(64), icon: imageUrl.nullable().optional(), template: z.enum(TEMPLATE_IDS).default('blank') })
        .parse(req.body);
      const id = newId();
      const now = Date.now();
      await run('INSERT INTO guilds (id, name, owner_id, created_at, icon) VALUES (?, ?, ?, ?, ?)', id, body.name, req.user.id, now, body.icon ?? null);
      await run('INSERT INTO members (guild_id, user_id, joined_at) VALUES (?, ?, ?)', id, req.user.id, now);
      await run(
        "INSERT INTO roles (id, guild_id, name, color, permissions, position, hoist, created_at) VALUES (?, ?, '@everyone', NULL, ?, 0, 0, ?)",
        id, id, DEFAULT_EVERYONE_PERMS, now,
      );
      // Modelo escolhido na tela de criar servidor: canais (com tópico), cargos e canais só de leitura.
      const t = TEMPLATES[body.template];
      const roleIds: Record<string, string> = {};
      for (const [i, r] of t.roles.entries()) {
        roleIds[r.name] = newId();
        await run(
          'INSERT INTO roles (id, guild_id, name, color, permissions, position, hoist, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          roleIds[r.name], id, r.name, r.color, r.permissions, t.roles.length - i, r.hoist ? 1 : 0, now,
        );
      }
      const pos = { text: 0, voice: 0 };
      for (const c of t.channels) {
        const chId = newId();
        await run('INSERT INTO channels (id, guild_id, name, type, position, topic) VALUES (?, ?, ?, ?, ?, ?)', chId, id, c.name, c.type, pos[c.type]++, c.topic ?? null);
        // Canal de avisos: só quem administra escreve (o @everyone perde "Enviar mensagens" ali).
        if (c.readOnly) await run('INSERT INTO channel_overwrites (channel_id, target_id, allow, deny) VALUES (?, ?, 0, ?)', chId, id, P.SEND_MESSAGES);
      }
      const payload = await guildPayload((await getGuild(id))!, req.user.id);
      sendToUser(req.user.id, 'GUILD_CREATE', withPresence(payload));
      return payload;
    });

    // Prévia de um convite (cartão no chat e tela "Entrar num servidor"): nome, ícone e quanta gente tem.
    api.get('/api/invites/:code', async (req, reply) => {
      const { code } = req.params as { code: string };
      const inv = (await get('SELECT * FROM invites WHERE code = ?', code)) as
        | { guild_id: string; creator_id: string; uses: number; max_uses: number | null; expires_at: number | null }
        | undefined;
      const guild = inv && (await getGuild(inv.guild_id));
      if (!inv || !guild || (inv.expires_at && inv.expires_at < Date.now()) || (inv.max_uses && inv.uses >= inv.max_uses))
        return reply.code(404).send({ error: 'Convite inválido ou expirado' });
      const ids = await memberIds(guild.id);
      const inviter = await getUser(inv.creator_id);
      return {
        code,
        guild: { id: guild.id, name: guild.name, icon: guild.icon ?? null },
        member_count: ids.length,
        online_count: presencesOf(ids).length,
        inviter: inviter ? { id: inviter.id, display_name: inviter.display_name, avatar: inviter.avatar ?? null } : null,
        expires_at: inv.expires_at,
        joined: ids.includes(req.user.id),
      };
    });

    api.post('/api/guilds/:guildId/invites', async (req, reply) => {
      const { guildId } = req.params as { guildId: string };
      const ctx = await permContext(guildId);
      if (!ctx?.members.has(req.user.id)) return reply.code(403).send({ error: 'Sem acesso' });
      if (ctx.isDm) return reply.code(400).send({ error: 'Conversa direta não tem convite' });
      if (!ctx.can(req.user.id, P.CREATE_INVITE)) return reply.code(403).send({ error: 'Você não tem permissão para criar convites' });
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
      const payload = await guildPayload((await getGuild(inv.guild_id))!, req.user.id);
      sendToUser(req.user.id, 'GUILD_CREATE', withPresence(payload));
      return payload;
    });

    // ---------- Amigos ----------
    api.get('/api/relationships', async (req) => relationshipsOf(req.user.id));

    /**
     * Manda para cada lado o próprio estado da relação com o outro (ou que ela acabou).
     * `notice` vai só para quem precisa ser avisado: "request" para quem recebeu o pedido, "accepted" para quem pediu.
     */
    const relationshipChanged = async (a: string, b: string, notice?: { to: string; kind: 'request' | 'accepted' }) => {
      for (const [me, other] of [[a, b], [b, a]]) {
        const type = await relationshipType(me, other);
        const user = await getUser(other);
        if (type && user)
          sendToUser(me, 'RELATIONSHIP_ADD', { type, user, status: presenceOf(other), notice: notice?.to === me ? notice.kind : undefined });
        else sendToUser(me, 'RELATIONSHIP_REMOVE', { id: other });
      }
    };
    const makeFriends = (a: string, b: string) =>
      run("UPDATE relationships SET type = 'friend' WHERE (user_id = ? AND other_id = ?) OR (user_id = ? AND other_id = ?)", a, b, b, a);

    // Pedido de amizade pelo nome de usuário (como "Adicionar amigo" no Discord).
    api.post(
      '/api/relationships',
      { config: { rateLimit: { max: 20, timeWindow: '1 minute', keyGenerator: (req: { user?: { id: string }; ip: string }) => req.user?.id ?? req.ip } } },
      async (req, reply) => {
        const body = z.object({ username: z.string().trim().min(1).max(64).optional(), user_id: z.string().max(40).optional() }).parse(req.body);
        const other = body.user_id
          ? ((await get('SELECT id FROM users WHERE id = ?', body.user_id)) as { id: string } | undefined)
          : body.username
            ? ((await get('SELECT id FROM users WHERE lower(username) = lower(?)', body.username.replace(/^@/, ''))) as { id: string } | undefined)
            : undefined;
        if (!other) return reply.code(404).send({ error: 'Ninguém com esse nome de usuário. Confira se digitou certinho.' });
        if (other.id === req.user.id) return reply.code(400).send({ error: 'Você não pode adicionar você mesmo' });
        const mine = await relationshipType(req.user.id, other.id);
        if (mine === 'friend') return reply.code(400).send({ error: 'Vocês já são amigos' });
        if (mine === 'outgoing') return reply.code(400).send({ error: 'Pedido já enviado, esperando a resposta' });
        if (mine === 'incoming') {
          // A outra pessoa já tinha pedido: vira amizade na hora.
          await makeFriends(req.user.id, other.id);
          await relationshipChanged(req.user.id, other.id, { to: other.id, kind: 'accepted' });
          return { type: 'friend' };
        }
        const now = Date.now();
        await run("INSERT INTO relationships (user_id, other_id, type, created_at) VALUES (?, ?, 'outgoing', ?)", req.user.id, other.id, now);
        await run("INSERT INTO relationships (user_id, other_id, type, created_at) VALUES (?, ?, 'incoming', ?)", other.id, req.user.id, now);
        await relationshipChanged(req.user.id, other.id, { to: other.id, kind: 'request' });
        return { type: 'outgoing' };
      },
    );

    // Aceitar um pedido recebido.
    api.put('/api/relationships/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      if ((await relationshipType(req.user.id, id)) !== 'incoming') return reply.code(400).send({ error: 'Nenhum pedido dessa pessoa' });
      await makeFriends(req.user.id, id);
      await relationshipChanged(req.user.id, id, { to: id, kind: 'accepted' });
      return { type: 'friend' };
    });

    // Recusar, cancelar o pedido ou desfazer a amizade (some para os dois lados).
    api.delete('/api/relationships/:id', async (req) => {
      const { id } = req.params as { id: string };
      await run('DELETE FROM relationships WHERE (user_id = ? AND other_id = ?) OR (user_id = ? AND other_id = ?)', req.user.id, id, id, req.user.id);
      await relationshipChanged(req.user.id, id);
      return { ok: true };
    });

    // Conversa direta = um "servidor" escondido com as duas pessoas, um canal de texto e um de voz.
    // Assim mensagens, reações, anexos, digitando, fixar e chamada reaproveitam tudo que os servidores já têm.
    // Para começar uma conversa nova precisa ser amigo; a que já existe continua aberta.
    api.post('/api/dms/:userId', async (req, reply) => {
      const { userId } = req.params as { userId: string };
      let guildId = await findDm(req.user.id, userId);
      const created = !guildId;
      if (!guildId) {
        if ((await relationshipType(req.user.id, userId)) !== 'friend')
          return reply.code(403).send({ error: 'Só dá para começar uma conversa direta com amigos' });
        guildId = newId();
        const now = Date.now();
        await run('INSERT INTO guilds (id, name, owner_id, created_at, is_dm) VALUES (?, ?, ?, ?, 1)', guildId, 'Conversa direta', req.user.id, now);
        await run('INSERT INTO members (guild_id, user_id, joined_at) VALUES (?, ?, ?)', guildId, req.user.id, now);
        await run('INSERT INTO members (guild_id, user_id, joined_at) VALUES (?, ?, ?)', guildId, userId, now);
        const ins = 'INSERT INTO channels (id, guild_id, name, type, position) VALUES (?, ?, ?, ?, ?)';
        await run(ins, newId(), guildId, 'conversa', 'text', 0);
        await run(ins, newId(), guildId, 'Chamada', 'voice', 0);
      }
      const guild = (await getGuild(guildId))!;
      const payload = withPresence(await guildPayload(guild, req.user.id));
      if (created) for (const id of [req.user.id, userId]) sendToUser(id, 'GUILD_CREATE', withPresence(await guildPayload(guild, id)));
      return payload;
    });

    // ---------- Canais ----------
    api.post('/api/guilds/:guildId/channels', async (req, reply) => {
      const { guildId } = req.params as { guildId: string };
      const ctx = await permContext(guildId);
      if (!ctx || ctx.isDm || !ctx.can(req.user.id, P.MANAGE_CHANNELS)) return reply.code(403).send({ error: 'Você não tem permissão para criar canais' });
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
      await syncChannel(ch);
      return channelWithOverwrites(ch, ctx);
    });

    // ---------- Mensagens ----------
    api.get('/api/channels/:channelId/messages', async (req, reply) => {
      const { channelId } = req.params as { channelId: string };
      const ch = await getChannel(channelId);
      if (!ch || !(await canIn(ch, req.user.id, P.VIEW_CHANNEL))) return reply.code(403).send({ error: 'Sem acesso' });
      const { before, limit } = z
        .object({ before: z.string().optional(), limit: z.coerce.number().int().min(1).max(100).default(50) })
        .parse(req.query);
      return listMessages(channelId, before, limit);
    });

    // ---------- Avisos com o Nexo fechado (Web Push) ----------
    api.get('/api/push/key', async () => ({ key: await pushPublicKey() }));
    api.post('/api/push/subscribe', async (req) => {
      const body = z
        .object({
          subscription: z.object({ endpoint: z.string().url().max(1000), keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }) }),
          mode: z.enum(['all', 'mentions']).default('mentions'),
          hide_content: z.boolean().default(false),
        })
        .parse(req.body);
      // Só serviços de aviso conhecidos (Chrome/Edge, Firefox, Safari/iPhone, Windows): o servidor não chama outros endereços.
      const host = new URL(body.subscription.endpoint).hostname;
      const known = /(^|\.)(fcm\.googleapis\.com|push\.services\.mozilla\.com|push\.apple\.com|notify\.windows\.com)$/;
      if (!body.subscription.endpoint.startsWith('https://') || !known.test(host)) throw Object.assign(new Error('Serviço de aviso não aceito'), { statusCode: 400 });
      await saveSubscription(req.user.id, body.subscription, body.mode, body.hide_content);
      return { ok: true };
    });
    api.post('/api/push/unsubscribe', async (req) => {
      const { endpoint } = z.object({ endpoint: z.string().max(1000) }).parse(req.body);
      await removeSubscription(req.user.id, endpoint);
      return { ok: true };
    });

    // Limite anti-spam: 20 mensagens a cada 10 segundos por usuário.
    const messageLimit = {
      config: { rateLimit: { max: 20, timeWindow: '10 seconds', keyGenerator: (req: { user?: { id: string }; ip: string }) => req.user?.id ?? req.ip } },
    };

    api.post('/api/channels/:channelId/messages', { ...messageLimit, bodyLimit: 40 * 1024 * 1024 }, async (req, reply) => {
      const { channelId } = req.params as { channelId: string };
      const ch = await getChannel(channelId);
      const ctx = ch && (await permContext(ch.guild_id));
      if (!ch || !ctx || ch.type !== 'text' || !ctx.can(req.user.id, P.VIEW_CHANNEL, ch.id)) return reply.code(403).send({ error: 'Sem acesso' });
      if (!ctx.can(req.user.id, P.SEND_MESSAGES, ch.id)) return reply.code(403).send({ error: 'Você não tem permissão para mandar mensagens neste canal' });
      const body = z
        .object({
          content: z.string().trim().max(4000).default(''),
          reply_to: z.string().max(40).nullable().optional(),
          attachments: z.array(attachmentBody).max(4).default([]),
        })
        .parse(req.body);
      if (!body.content && !body.attachments.length) return reply.code(400).send({ error: 'Mensagem vazia' });
      if (body.attachments.length && !ctx.can(req.user.id, P.ATTACH_FILES, ch.id))
        return reply.code(403).send({ error: 'Você não tem permissão para mandar arquivos neste canal' });
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
      await sendToChannel(ch, 'MESSAGE_CREATE', msg, ctx);
      pushMessage(ch, msg, ctx).catch((e) => req.log.warn(e, 'push'));
      return msg;
    });

    api.patch('/api/messages/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      const msg = await getMessage(id);
      if (!msg || msg.author.id !== req.user.id) return reply.code(403).send({ error: 'Sem acesso' });
      const { content } = z.object({ content: z.string().trim().min(1).max(4000) }).parse(req.body);
      await run('UPDATE messages SET content = ?, edited_at = ? WHERE id = ?', content, Date.now(), id);
      const updated = (await getMessage(id))!;
      await sendToChannel((await getChannel(msg.channel_id))!, 'MESSAGE_UPDATE', updated);
      return updated;
    });

    api.delete('/api/messages/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      const msg = await getMessage(id);
      if (!msg) return reply.code(404).send({ error: 'Não encontrada' });
      const ch = (await getChannel(msg.channel_id))!;
      const ctx = (await permContext(ch.guild_id))!;
      if (msg.author.id !== req.user.id && !ctx.can(req.user.id, P.MANAGE_MESSAGES, ch.id)) return reply.code(403).send({ error: 'Sem acesso' });
      await run('DELETE FROM messages WHERE id = ?', id);
      await sendToChannel(ch, 'MESSAGE_DELETE', { id, channel_id: ch.id }, ctx);
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
      const ctx = ch && (await permContext(ch.guild_id));
      if (!msg || !ch || !ctx?.can(req.user.id, P.VIEW_CHANNEL, ch.id)) return reply.code(403).send({ error: 'Sem acesso' });
      // Na conversa direta as duas pessoas podem fixar qualquer mensagem.
      if (!ctx.isDm && !ctx.can(req.user.id, P.MANAGE_MESSAGES, ch.id) && msg.author.id !== req.user.id)
        return reply.code(403).send({ error: 'Só quem escreveu ou quem pode gerenciar mensagens pode fixar' });
      const { pinned } = z.object({ pinned: z.boolean() }).parse(req.body);
      await run('UPDATE messages SET pinned = ? WHERE id = ?', pinned ? 1 : 0, id);
      const updated = (await getMessage(id))!;
      await sendToChannel(ch, 'MESSAGE_UPDATE', updated, ctx);
      return updated;
    });

    api.get('/api/channels/:channelId/pins', async (req, reply) => {
      const { channelId } = req.params as { channelId: string };
      const ch = await getChannel(channelId);
      if (!ch || !(await canIn(ch, req.user.id, P.VIEW_CHANNEL))) return reply.code(403).send({ error: 'Sem acesso' });
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
      const ctx = await permContext(guildId);
      if (!ctx?.members.has(req.user.id)) return reply.code(403).send({ error: 'Sem acesso' });
      const { q } = z.object({ q: z.string().trim().min(1).max(100) }).parse(req.query);
      const visible = (await channelsOf(guildId)).filter((c) => c.type === 'text' && ctx.can(req.user.id, P.VIEW_CHANNEL, c.id)).map((c) => c.id);
      return searchMessages(visible, q);
    });

    // ---------- Reações ----------
    api.put('/api/messages/:id/reactions/:emoji', messageLimit, async (req, reply) => {
      const { id, emoji } = req.params as { id: string; emoji: string };
      if (!isEmoji(emoji)) return reply.code(400).send({ error: 'Reação inválida' });
      const msg = await getMessage(id);
      const ch = msg && (await getChannel(msg.channel_id));
      const ctx = ch && (await permContext(ch.guild_id));
      if (!msg || !ch || !ctx?.can(req.user.id, P.VIEW_CHANNEL, ch.id)) return reply.code(403).send({ error: 'Sem acesso' });
      const on = (req.body as { on?: boolean } | undefined)?.on !== false;
      // Tirar a própria reação sempre pode; reagir de novo precisa da permissão.
      if (on && !ctx.can(req.user.id, P.ADD_REACTIONS, ch.id)) return reply.code(403).send({ error: 'Você não tem permissão para reagir neste canal' });
      if (on)
        await run(
          'INSERT INTO reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING',
          id, req.user.id, emoji, Date.now(),
        );
      else await run('DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?', id, req.user.id, emoji);
      const updated = (await getMessage(id))!;
      await sendToChannel(ch, 'MESSAGE_UPDATE', updated, ctx);
      return updated;
    });

    // ---------- Voz, câmera e transmissão de tela ----------
    api.post('/api/channels/:channelId/voice-token', async (req, reply) => {
      const { channelId } = req.params as { channelId: string };
      const ch = await getChannel(channelId);
      const ctx = ch && (await permContext(ch.guild_id));
      if (!ch || !ctx || ch.type !== 'voice' || !ctx.can(req.user.id, P.VIEW_CHANNEL, ch.id)) return reply.code(403).send({ error: 'Sem acesso' });
      if (!ctx.can(req.user.id, P.CONNECT, ch.id)) return reply.code(403).send({ error: 'Você não tem permissão para entrar neste canal de voz' });
      const perms = ctx.perms(req.user.id, ch.id);
      if (process.env.NODE_ENV === 'production' && !livekitConfigured)
        return reply.code(503).send({ error: 'Servidor de voz não configurado: preencha LIVEKIT_URL, LIVEKIT_API_KEY e LIVEKIT_API_SECRET no Render' });
      const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
        identity: req.user.id,
        name: req.user.display_name,
        ttl: '6h',
      });
      const mod = getServerMod(ch.guild_id, req.user.id);
      at.addGrant({ room: voiceRoom(ch.id), roomJoin: true, ...voicePermission(mod, perms) });
      // Sem "Falar" a pessoa entra como silenciada (o site trava o microfone como no silêncio do servidor).
      return { url: LIVEKIT_URL, token: await at.toJwt(), server_mute: mod.mute || !(perms & P.SPEAK), server_deaf: mod.deaf };
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

    // ---------- Configurações do servidor (cada parte pede a sua permissão) ----------
    api.patch('/api/guilds/:guildId', async (req, reply) => {
      const { guildId } = req.params as { guildId: string };
      const ctx = await permContext(guildId);
      if (!ctx || ctx.isDm || !ctx.can(req.user.id, P.MANAGE_GUILD)) return reply.code(403).send({ error: 'Você não tem permissão para editar o servidor' });
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
      await run('DELETE FROM member_roles WHERE guild_id = ? AND user_id = ?', guildId, userId);
      sendToUser(userId, 'GUILD_DELETE', { id: guildId });
      await sendToGuild(guildId, 'GUILD_MEMBER_REMOVE', { guild_id: guildId, user_id: userId });
    };

    api.delete('/api/guilds/:guildId', async (req, reply) => {
      const { guildId } = req.params as { guildId: string };
      if (!(await permContext(guildId))?.isOwner(req.user.id)) return reply.code(403).send({ error: 'Só o dono do servidor pode apagar' });
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
      if (Number(guild.is_dm)) return reply.code(400).send({ error: 'Não dá para sair de uma conversa direta' });
      if (userId === req.user.id) {
        if (guild.owner_id === userId) return reply.code(400).send({ error: 'O dono não pode sair. Apague o servidor nas configurações dele.' });
      } else {
        const ctx = (await permContext(guild))!;
        if (!ctx.can(req.user.id, P.KICK_MEMBERS)) return reply.code(403).send({ error: 'Você não tem permissão para expulsar' });
        if (!ctx.outranks(req.user.id, userId)) return reply.code(403).send({ error: 'Você só pode expulsar quem tem cargo mais baixo que o seu' });
      }
      await removeMember(guildId, userId);
      return { ok: true };
    });

    api.patch('/api/channels/:channelId', async (req, reply) => {
      const { channelId } = req.params as { channelId: string };
      const ch = await getChannel(channelId);
      if (!ch || !(await canIn(ch, req.user.id, P.MANAGE_CHANNELS, true))) return reply.code(403).send({ error: 'Você não tem permissão para editar canais' });
      const body = z.object({ name: z.string().trim().min(1).max(64).optional(), topic: optText(1024) }).parse(req.body);
      if (body.name !== undefined)
        await run('UPDATE channels SET name = ? WHERE id = ?', ch.type === 'text' ? body.name.toLowerCase().replace(/\s+/g, '-') : body.name, ch.id);
      if (body.topic !== undefined) await run('UPDATE channels SET topic = ? WHERE id = ?', body.topic, ch.id);
      const updated = (await getChannel(ch.id))!;
      await syncChannel(updated);
      return updated;
    });

    api.delete('/api/channels/:channelId', async (req, reply) => {
      const { channelId } = req.params as { channelId: string };
      const ch = await getChannel(channelId);
      if (!ch || !(await canIn(ch, req.user.id, P.MANAGE_CHANNELS, true))) return reply.code(403).send({ error: 'Você não tem permissão para apagar canais' });
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

    // ---------- Moderação de voz (Silenciar membros / Mover membros) ----------
    const modBody = z.object({
      action: z.enum(['mute', 'unmute', 'deafen', 'undeafen', 'disconnect', 'move']),
      channel_id: z.string().optional(),
    });
    api.post('/api/guilds/:guildId/members/:userId/voice', async (req, reply) => {
      const { guildId, userId } = req.params as { guildId: string; userId: string };
      const body = modBody.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'Ação inválida' });
      const ctx = await permContext(guildId);
      if (!ctx || ctx.isDm) return reply.code(403).send({ error: NO_PERM });
      if (!ctx.members.has(userId)) return reply.code(404).send({ error: 'Essa pessoa não está no servidor' });
      const { action, channel_id } = body.data;
      const need = action === 'move' || action === 'disconnect' ? P.MOVE_MEMBERS : P.MUTE_MEMBERS;
      if (!ctx.can(req.user.id, need)) return reply.code(403).send({ error: NO_PERM });
      if (userId !== req.user.id && !ctx.outranks(req.user.id, userId))
        return reply.code(403).send({ error: 'Você só pode moderar quem tem cargo mais baixo que o seu' });
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
            await svc.updateParticipant(room, userId, { permission: voicePermission(next, ctx.perms(userId, inVoice.channelId)) });
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
      if (!ctx.can(req.user.id, P.VIEW_CHANNEL | P.CONNECT, target.id)) return reply.code(403).send({ error: 'Você não pode entrar nesse canal' });
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
