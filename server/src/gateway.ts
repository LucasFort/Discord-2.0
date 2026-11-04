import type { WebSocket } from 'ws';
import type { FastifyInstance } from 'fastify';
import { userFromToken } from './auth.js';
import { handleMusicOp, musicStatesFor, onVoiceChannelLeft } from './music.js';
import {
  getChannel, getStatus, guildsOf, memberIds, relationshipIds, relationshipsOf, type Channel, type User, type UserStatus,
} from './db.js';
import { guildPayload, permContext, P, type PermContext } from './permissions.js';

/**
 * Real-time gateway. One WebSocket per open client tab.
 * Server -> client: { t: EVENT_NAME, d: data }
 * Client -> server: { op: 'typing' | 'voice_state' | 'ping', ... }
 */
const sockets = new Map<string, Set<WebSocket>>(); // userId -> sockets
type VoiceFlags = { self_mute: boolean; self_deaf: boolean; self_stream: boolean; self_video: boolean };
const NO_FLAGS: VoiceFlags = { self_mute: false, self_deaf: false, self_stream: false, self_video: false };
const voiceStates = new Map<string, { userId: string; channelId: string; guildId: string } & VoiceFlags>(); // userId -> state
/** Silenciado/ensurdecido pelo dono do servidor ("guildId:userId"). Vale em todos os canais de voz do servidor. */
const serverMod = new Map<string, { mute: boolean; deaf: boolean }>();
export const getServerMod = (guildId: string, userId: string) => serverMod.get(`${guildId}:${userId}`) ?? { mute: false, deaf: false };
export const voiceStateOf = (userId: string) => voiceStates.get(userId);
export const channelHasPeople = (channelId: string) => [...voiceStates.values()].some((v) => v.channelId === channelId);
export const usersInVoice = (channelId: string) => [...voiceStates.values()].filter((v) => v.channelId === channelId).map((v) => v.userId);

/** Muda o silenciar/ensurdecer do servidor e avisa todo mundo se a pessoa está na voz desse servidor. */
export async function setServerMod(guildId: string, userId: string, patch: Partial<{ mute: boolean; deaf: boolean }>) {
  const next = { ...getServerMod(guildId, userId), ...patch };
  if (!next.mute && !next.deaf) serverMod.delete(`${guildId}:${userId}`);
  else serverMod.set(`${guildId}:${userId}`, next);
  const v = voiceStates.get(userId);
  if (v && v.guildId === guildId) await sendToGuild(guildId, 'VOICE_STATE_UPDATE', voicePayload(v));
  return next;
}

/** Só aceita os quatro indicadores, como booleanos (o resto da mensagem é ignorado). */
function readFlags(msg: Record<string, unknown>): VoiceFlags {
  return { self_mute: !!msg.self_mute, self_deaf: !!msg.self_deaf, self_stream: !!msg.self_stream, self_video: !!msg.self_video };
}
const voicePayload = (v: { userId: string; guildId: string; channelId: string } & VoiceFlags) => ({
  user_id: v.userId,
  guild_id: v.guildId,
  channel_id: v.channelId,
  self_mute: v.self_mute,
  self_deaf: v.self_deaf,
  self_stream: v.self_stream,
  self_video: v.self_video,
  server_mute: getServerMod(v.guildId, v.userId).mute,
  server_deaf: getServerMod(v.guildId, v.userId).deaf,
});

export function sendToUser(userId: string, t: string, d: unknown) {
  const msg = JSON.stringify({ t, d });
  for (const ws of sockets.get(userId) ?? []) if (ws.readyState === 1) ws.send(msg);
}

export async function sendToGuild(guildId: string, t: string, d: unknown) {
  for (const id of await memberIds(guildId)) sendToUser(id, t, d);
}

/** Evento de um canal: só para quem pode ver o canal (canais privados não vazam). */
export async function sendToChannel(ch: Pick<Channel, 'id' | 'guild_id'>, t: string, d: unknown, ctx?: PermContext) {
  const c = ctx ?? (await permContext(ch.guild_id));
  if (!c) return;
  for (const id of c.members) if (c.can(id, P.VIEW_CHANNEL, ch.id)) sendToUser(id, t, d);
}

export const isOnline = (userId: string) => (sockets.get(userId)?.size ?? 0) > 0;

// ---------- Status (como no Discord) ----------
/** Status escolhido (carregado do banco quando a pessoa conecta). */
const chosenStatus = new Map<string, UserStatus>();
/** Quem está ausente por inatividade (o site avisa depois de 10 minutos sem mexer). */
const afk = new Set<string>();
export type Presence = 'online' | 'idle' | 'dnd' | 'offline';
/** O que os outros veem: invisível aparece como offline; parado vira "ausente". */
export function presenceOf(userId: string): Presence {
  if (!isOnline(userId)) return 'offline';
  const s = chosenStatus.get(userId) ?? 'online';
  if (s === 'invisible') return 'offline';
  if (s === 'dnd') return 'dnd';
  if (s === 'idle' || afk.has(userId)) return 'idle';
  return 'online';
}
export const presencesOf = (ids: Iterable<string>) =>
  [...ids].map((id) => ({ user_id: id, status: presenceOf(id) })).filter((p) => p.status !== 'offline');

/** Quem "conhece" a pessoa: mesmos servidores, conversas diretas, amigos e pedidos pendentes (sem repetir). */
async function audienceOf(userId: string) {
  const to = new Set<string>(await relationshipIds(userId));
  for (const g of await guildsOf(userId)) for (const id of await memberIds(g.id)) to.add(id);
  return to;
}

const lastSent = new Map<string, Presence>();
async function broadcastPresence(user: Pick<User, 'id'>) {
  const status = presenceOf(user.id);
  if (lastSent.get(user.id) === status) return;
  if (status === 'offline') lastSent.delete(user.id);
  else lastSent.set(user.id, status);
  for (const id of await audienceOf(user.id)) sendToUser(id, 'PRESENCE_UPDATE', { user_id: user.id, status });
}

/** A pessoa trocou o status (Disponível, Ausente, Não perturbe, Invisível). */
export async function setUserStatus(userId: string, status: UserStatus) {
  chosenStatus.set(userId, status);
  sendToUser(userId, 'STATUS_UPDATE', { status });
  await broadcastPresence({ id: userId });
}

/** Perfil mudou (nome, foto, sobre mim…): avisa a própria pessoa e todo mundo dos servidores dela. */
export async function broadcastUserUpdate(user: User) {
  const to = await audienceOf(user.id);
  to.add(user.id);
  for (const id of to) sendToUser(id, 'USER_UPDATE', user);
}

export async function setVoiceState(user: Pick<User, 'id'>, channelId: string | null, flags: VoiceFlags = NO_FLAGS) {
  const prev = voiceStates.get(user.id);
  // Mesmo canal: só mudou mutado, ensurdecido, transmitindo ou câmera.
  if (prev && channelId && prev.channelId === channelId) {
    Object.assign(prev, flags);
    await sendToGuild(prev.guildId, 'VOICE_STATE_UPDATE', voicePayload(prev));
    return;
  }
  if (prev) {
    voiceStates.delete(user.id);
    await sendToGuild(prev.guildId, 'VOICE_STATE_UPDATE', { user_id: user.id, guild_id: prev.guildId, channel_id: null });
    await onVoiceChannelLeft(prev.channelId);
  }
  if (!channelId) return;
  const ch = await getChannel(channelId);
  if (!ch || ch.type !== 'voice' || !(await permContext(ch.guild_id))?.can(user.id, P.VIEW_CHANNEL | P.CONNECT, ch.id)) return;
  const state = { userId: user.id, channelId, guildId: ch.guild_id, ...flags };
  voiceStates.set(user.id, state);
  await sendToGuild(ch.guild_id, 'VOICE_STATE_UPDATE', voicePayload(state));
}

export function registerGateway(app: FastifyInstance) {
  app.get('/gateway', { websocket: true }, (ws, req) => {
    // Os eventos do socket são registrados já, de forma síncrona (recomendação do @fastify/websocket);
    // o que depende do banco espera o login terminar.
    let user: User | undefined;
    let closed = false;
    // Ping do servidor a cada 25 s: proxies (como o do Render) derrubam conexões que ficam quietas.
    const heartbeat = setInterval(() => ws.readyState === 1 && ws.ping(), 25_000);
    const ready = (async () => {
      user = await userFromToken((req.query as { token?: string }).token);
      if (closed) return;
      if (!user) return ws.close(4001, 'Não autenticado');
      if (!chosenStatus.has(user.id)) chosenStatus.set(user.id, await getStatus(user.id));
      if (closed) return;
      const set = sockets.get(user.id) ?? new Set();
      const firstSocket = set.size === 0;
      set.add(ws);
      sockets.set(user.id, set);

      const me = user;
      const guilds = await Promise.all((await guildsOf(user.id)).map((g) => guildPayload(g, me.id)));
      const relationships = await relationshipsOf(user.id);
      const visible = new Set([...guilds.flatMap((g) => g.members.map((m) => m.id)), ...relationships.map((r) => r.user.id)]);
      if (ws.readyState !== 1) return;
      ws.send(
        JSON.stringify({
          t: 'READY',
          d: {
            user,
            status: chosenStatus.get(user.id) ?? 'online',
            guilds,
            relationships,
            presences: presencesOf(visible),
            voice_states: [...voiceStates.values()]
              .filter((v) => guilds.some((g) => g.id === v.guildId))
              .map(voicePayload),
            music: musicStatesFor(new Set(guilds.flatMap((g) => g.channels.map((c) => c.id)))),
          },
        }),
      );
      if (firstSocket) await broadcastPresence(user);
    })().catch((e) => {
      app.log.error(e);
      ws.close(1011, 'Erro interno');
    });

    ws.on('message', async (raw) => {
      await ready;
      const u = user;
      if (!u) return;
      let msg: { op?: string; channel_id?: string | null; idle?: boolean; action?: string; url?: string; track_id?: string; position?: number; mode?: string };
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      try {
        if (msg.op === 'ping' && ws.readyState === 1) ws.send(JSON.stringify({ t: 'PONG', d: null }));
        if (msg.op === 'typing' && msg.channel_id) {
          const ch = await getChannel(msg.channel_id);
          const ctx = ch && (await permContext(ch.guild_id));
          if (ch && ctx?.can(u.id, P.VIEW_CHANNEL | P.SEND_MESSAGES, ch.id))
            await sendToChannel(ch, 'TYPING_START', { channel_id: ch.id, user_id: u.id }, ctx);
        }
        if (msg.op === 'voice_state') await setVoiceState(u, msg.channel_id ?? null, readFlags(msg));
        if (msg.op === 'music') await handleMusicOp(u, msg);
        if (msg.op === 'idle') {
          if (msg.idle) afk.add(u.id);
          else afk.delete(u.id);
          await broadcastPresence(u);
        }
      } catch (e) {
        app.log.error(e);
      }
    });

    ws.on('close', async () => {
      closed = true;
      clearInterval(heartbeat);
      await ready;
      const u = user;
      const set = u && sockets.get(u.id);
      if (!u || !set) return;
      set.delete(ws);
      if (set.size === 0) {
        sockets.delete(u.id);
        afk.delete(u.id);
        await setVoiceState(u, null)
          .then(() => broadcastPresence(u))
          .catch((e) => app.log.error(e));
      }
    });
  });
}
