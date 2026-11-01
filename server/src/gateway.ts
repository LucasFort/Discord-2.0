import type { WebSocket } from 'ws';
import type { FastifyInstance } from 'fastify';
import { userFromToken } from './auth.js';
import { getChannel, guildPayload, guildsOf, isMember, memberIds, type User } from './db.js';

/**
 * Real-time gateway. One WebSocket per open client tab.
 * Server -> client: { t: EVENT_NAME, d: data }
 * Client -> server: { op: 'typing' | 'voice_state' | 'ping', ... }
 */
const sockets = new Map<string, Set<WebSocket>>(); // userId -> sockets
const voiceStates = new Map<string, { userId: string; channelId: string; guildId: string }>(); // userId -> state

export function sendToUser(userId: string, t: string, d: unknown) {
  const msg = JSON.stringify({ t, d });
  for (const ws of sockets.get(userId) ?? []) if (ws.readyState === 1) ws.send(msg);
}

export async function sendToGuild(guildId: string, t: string, d: unknown) {
  for (const id of await memberIds(guildId)) sendToUser(id, t, d);
}

export const isOnline = (userId: string) => (sockets.get(userId)?.size ?? 0) > 0;

async function broadcastPresence(user: User) {
  const status = isOnline(user.id) ? 'online' : 'offline';
  for (const g of await guildsOf(user.id)) await sendToGuild(g.id, 'PRESENCE_UPDATE', { user_id: user.id, status });
}

async function setVoiceState(user: User, channelId: string | null) {
  const prev = voiceStates.get(user.id);
  if (prev) {
    voiceStates.delete(user.id);
    await sendToGuild(prev.guildId, 'VOICE_STATE_UPDATE', { user_id: user.id, guild_id: prev.guildId, channel_id: null });
  }
  if (!channelId) return;
  const ch = await getChannel(channelId);
  if (!ch || ch.type !== 'voice' || !(await isMember(ch.guild_id, user.id))) return;
  voiceStates.set(user.id, { userId: user.id, channelId, guildId: ch.guild_id });
  await sendToGuild(ch.guild_id, 'VOICE_STATE_UPDATE', { user_id: user.id, guild_id: ch.guild_id, channel_id: channelId });
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
      const set = sockets.get(user.id) ?? new Set();
      const firstSocket = set.size === 0;
      set.add(ws);
      sockets.set(user.id, set);

      const guilds = await Promise.all((await guildsOf(user.id)).map(guildPayload));
      const visible = new Set(guilds.flatMap((g) => g.members.map((m) => m.id)));
      if (ws.readyState !== 1) return;
      ws.send(
        JSON.stringify({
          t: 'READY',
          d: {
            user,
            guilds,
            presences: [...visible].filter(isOnline).map((id) => ({ user_id: id, status: 'online' })),
            voice_states: [...voiceStates.values()]
              .filter((v) => guilds.some((g) => g.id === v.guildId))
              .map((v) => ({ user_id: v.userId, guild_id: v.guildId, channel_id: v.channelId })),
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
      let msg: { op?: string; channel_id?: string | null };
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      try {
        if (msg.op === 'ping' && ws.readyState === 1) ws.send(JSON.stringify({ t: 'PONG', d: null }));
        if (msg.op === 'typing' && msg.channel_id) {
          const ch = await getChannel(msg.channel_id);
          if (ch && (await isMember(ch.guild_id, u.id)))
            await sendToGuild(ch.guild_id, 'TYPING_START', { channel_id: ch.id, user_id: u.id });
        }
        if (msg.op === 'voice_state') await setVoiceState(u, msg.channel_id ?? null);
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
        await setVoiceState(u, null)
          .then(() => broadcastPresence(u))
          .catch((e) => app.log.error(e));
      }
    });
  });
}
