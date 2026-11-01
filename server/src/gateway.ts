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
  for (const ws of sockets.get(userId) ?? []) ws.send(msg);
}

export function sendToGuild(guildId: string, t: string, d: unknown) {
  for (const id of memberIds(guildId)) sendToUser(id, t, d);
}

export const isOnline = (userId: string) => (sockets.get(userId)?.size ?? 0) > 0;

function broadcastPresence(user: User) {
  const status = isOnline(user.id) ? 'online' : 'offline';
  for (const g of guildsOf(user.id)) sendToGuild(g.id, 'PRESENCE_UPDATE', { user_id: user.id, status });
}

function setVoiceState(user: User, channelId: string | null) {
  const prev = voiceStates.get(user.id);
  if (prev) {
    voiceStates.delete(user.id);
    sendToGuild(prev.guildId, 'VOICE_STATE_UPDATE', { user_id: user.id, guild_id: prev.guildId, channel_id: null });
  }
  if (!channelId) return;
  const ch = getChannel(channelId);
  if (!ch || ch.type !== 'voice' || !isMember(ch.guild_id, user.id)) return;
  voiceStates.set(user.id, { userId: user.id, channelId, guildId: ch.guild_id });
  sendToGuild(ch.guild_id, 'VOICE_STATE_UPDATE', { user_id: user.id, guild_id: ch.guild_id, channel_id: channelId });
}

export function registerGateway(app: FastifyInstance) {
  app.get('/gateway', { websocket: true }, async (ws, req) => {
    const token = (req.query as { token?: string }).token;
    const user = await userFromToken(token);
    if (!user) return ws.close(4001, 'Não autenticado');

    const set = sockets.get(user.id) ?? new Set();
    const firstSocket = set.size === 0;
    set.add(ws);
    sockets.set(user.id, set);

    const guilds = guildsOf(user.id).map(guildPayload);
    const visible = new Set(guilds.flatMap((g) => g.members.map((m) => m.id)));
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
    if (firstSocket) broadcastPresence(user);

    ws.on('message', (raw) => {
      let msg: { op?: string; channel_id?: string | null };
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg.op === 'ping') ws.send(JSON.stringify({ t: 'PONG', d: null }));
      if (msg.op === 'typing' && msg.channel_id) {
        const ch = getChannel(msg.channel_id);
        if (ch && isMember(ch.guild_id, user.id))
          sendToGuild(ch.guild_id, 'TYPING_START', { channel_id: ch.id, user_id: user.id });
      }
      if (msg.op === 'voice_state') setVoiceState(user, msg.channel_id ?? null);
    });

    ws.on('close', () => {
      set.delete(ws);
      if (set.size === 0) {
        sockets.delete(user.id);
        setVoiceState(user, null);
        broadcastPresence(user);
      }
    });
  });
}
