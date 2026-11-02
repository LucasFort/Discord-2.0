import { useEffect, useReducer, useRef, useState } from 'react';
import { playSound } from './sounds';
import { checkForUpdate } from './update';
import { gatewayUrl, getToken, type Channel, type Guild, type Message, type Presence, type User, type UserStatus } from './api';
import { startIdleWatch } from './activity';
import { notifyMessage, setMe } from './notify';

export type State = {
  ready: boolean;
  connection: number; // muda a cada READY (reconexão)
  user: User | null;
  status: UserStatus; // o que eu escolhi
  guilds: Guild[];
  presence: Record<string, Presence>; // só quem não está offline
  voice: Record<string, string>; // userId -> voice channelId
  voiceFlags: Record<string, VoiceFlags>; // userId -> mutado, ensurdecido, transmitindo, câmera
  messages: Record<string, Message[]>; // channelId -> messages
  typing: Record<string, Record<string, number>>; // channelId -> userId -> expires at
  voiceAction: VoiceServerAction | null; // última ação do dono do servidor sobre mim (desconectar, mover…)
};

export type VoiceServerAction = { n: number; action: 'mute' | 'deafen' | 'disconnect' | 'move'; by: string; channel_id?: string };

type Action =
  | { t: 'READY'; d: { user: User; status?: UserStatus; guilds: Guild[]; presences: PresenceItem[]; voice_states: VoiceState[] } }
  | { t: 'GUILD_CREATE'; d: Guild & { presences?: PresenceItem[] } }
  | { t: 'GUILD_UPDATE'; d: Omit<Guild, 'channels' | 'members'> }
  | { t: 'GUILD_DELETE'; d: { id: string } }
  | { t: 'GUILD_MEMBER_ADD'; d: { guild_id: string; user: User; status?: Presence } }
  | { t: 'GUILD_MEMBER_REMOVE'; d: { guild_id: string; user_id: string } }
  | { t: 'USER_UPDATE'; d: User }
  | { t: 'STATUS_UPDATE'; d: { status: UserStatus } }
  | { t: 'CHANNEL_CREATE' | 'CHANNEL_UPDATE'; d: Channel }
  | { t: 'CHANNEL_DELETE'; d: { id: string; guild_id: string } }
  | { t: 'MESSAGE_CREATE' | 'MESSAGE_UPDATE'; d: Message }
  | { t: 'MESSAGE_DELETE'; d: { id: string; channel_id: string } }
  | { t: 'MESSAGES_LOADED'; d: { channel_id: string; messages: Message[]; older: boolean } }
  | { t: 'PRESENCE_UPDATE'; d: PresenceItem }
  | { t: 'VOICE_STATE_UPDATE'; d: VoiceState }
  | { t: 'TYPING_START'; d: { channel_id: string; user_id: string } }
  | { t: 'TYPING_SWEEP' }
  | { t: 'VOICE_SERVER_ACTION'; d: Omit<VoiceServerAction, 'n'> };

type PresenceItem = { user_id: string; status: Presence };
const presenceMap = (items: PresenceItem[] = []) =>
  Object.fromEntries(items.filter((p) => p.status && p.status !== 'offline').map((p) => [p.user_id, p.status])) as Record<string, Presence>;
/** Meu status como os outros veem (invisível = offline, mas eu me vejo com a bolinha cinza). */
export const myPresence = (s: UserStatus): Presence => (s === 'invisible' ? 'offline' : s);

export type VoiceFlags = {
  self_mute?: boolean;
  self_deaf?: boolean;
  self_stream?: boolean;
  self_video?: boolean;
  server_mute?: boolean; // silenciado pelo dono do servidor
  server_deaf?: boolean; // ensurdecido pelo dono do servidor
};
type VoiceState = { user_id: string; guild_id: string; channel_id: string | null } & VoiceFlags;

const initial: State = { ready: false, connection: 0, user: null, status: 'online', guilds: [], presence: {}, voice: {}, voiceFlags: {}, messages: {}, typing: {}, voiceAction: null };

function sortChannels(chs: Channel[]) {
  return [...chs].sort((a, b) => (a.type === b.type ? a.position - b.position : a.type === 'text' ? -1 : 1));
}

const flagsOf = (v: VoiceFlags): VoiceFlags => ({
  self_mute: !!v.self_mute,
  self_deaf: !!v.self_deaf,
  self_stream: !!v.self_stream,
  self_video: !!v.self_video,
  server_mute: !!v.server_mute,
  server_deaf: !!v.server_deaf,
});

function reducer(s: State, a: Action): State {
  switch (a.t) {
    case 'READY': {
      const voice: State['voice'] = {};
      const voiceFlags: State['voiceFlags'] = {};
      for (const v of a.d.voice_states)
        if (v.channel_id) {
          voice[v.user_id] = v.channel_id;
          voiceFlags[v.user_id] = flagsOf(v);
        }
      return {
        ...initial,
        ready: true,
        connection: s.connection + 1,
        user: a.d.user,
        status: a.d.status ?? 'online',
        guilds: a.d.guilds,
        presence: presenceMap(a.d.presences),
        voice,
        voiceFlags,
        messages: s.messages,
      };
    }
    case 'GUILD_CREATE': {
      const { presences, ...guild } = a.d as Guild & { presences?: PresenceItem[]; online?: unknown };
      delete (guild as { online?: unknown }).online;
      return {
        ...s,
        guilds: [...s.guilds.filter((g) => g.id !== guild.id), guild],
        presence: { ...s.presence, ...presenceMap(presences) },
      };
    }
    case 'GUILD_UPDATE':
      return { ...s, guilds: s.guilds.map((g) => (g.id === a.d.id ? { ...g, ...a.d } : g)) };
    case 'GUILD_DELETE':
      return { ...s, guilds: s.guilds.filter((g) => g.id !== a.d.id) };
    case 'GUILD_MEMBER_REMOVE':
      return { ...s, guilds: s.guilds.map((g) => (g.id === a.d.guild_id ? { ...g, members: g.members.filter((m) => m.id !== a.d.user_id) } : g)) };
    case 'USER_UPDATE': {
      const u = a.d;
      const fix = (m: User) => (m.id === u.id ? { ...m, ...u } : m);
      const messages: State['messages'] = {};
      for (const [ch, list] of Object.entries(s.messages)) messages[ch] = list.some((m) => m.author.id === u.id) ? list.map((m) => (m.author.id === u.id ? { ...m, author: fix(m.author) } : m)) : list;
      return {
        ...s,
        user: s.user?.id === u.id ? { ...s.user, ...u } : s.user,
        guilds: s.guilds.map((g) => (g.members.some((m) => m.id === u.id) ? { ...g, members: g.members.map(fix) } : g)),
        messages,
      };
    }
    case 'STATUS_UPDATE':
      return { ...s, status: a.d.status };
    case 'GUILD_MEMBER_ADD':
      return {
        ...s,
        presence: a.d.status && a.d.status !== 'offline' ? { ...s.presence, [a.d.user.id]: a.d.status } : s.presence,
        guilds: s.guilds.map((g) =>
          g.id === a.d.guild_id && !g.members.some((m) => m.id === a.d.user.id) ? { ...g, members: [...g.members, a.d.user] } : g,
        ),
      };
    case 'CHANNEL_UPDATE':
      return {
        ...s,
        guilds: s.guilds.map((g) => (g.id === a.d.guild_id ? { ...g, channels: g.channels.map((c) => (c.id === a.d.id ? a.d : c)) } : g)),
      };
    case 'CHANNEL_DELETE':
      return {
        ...s,
        guilds: s.guilds.map((g) => (g.id === a.d.guild_id ? { ...g, channels: g.channels.filter((c) => c.id !== a.d.id) } : g)),
      };
    case 'CHANNEL_CREATE':
      return {
        ...s,
        guilds: s.guilds.map((g) => (g.id === a.d.guild_id ? { ...g, channels: sortChannels([...g.channels, a.d]) } : g)),
      };
    case 'MESSAGES_LOADED': {
      const cur = s.messages[a.d.channel_id] ?? [];
      const merged = a.d.older ? [...a.d.messages, ...cur] : a.d.messages;
      return { ...s, messages: { ...s.messages, [a.d.channel_id]: merged } };
    }
    case 'MESSAGE_CREATE': {
      const cur = s.messages[a.d.channel_id];
      if (!cur || cur.some((m) => m.id === a.d.id)) return s; // canal ainda não carregado: busca ao abrir
      const typing = { ...s.typing[a.d.channel_id] };
      delete typing[a.d.author.id];
      return {
        ...s,
        messages: { ...s.messages, [a.d.channel_id]: [...cur, a.d] },
        typing: { ...s.typing, [a.d.channel_id]: typing },
      };
    }
    case 'MESSAGE_UPDATE': {
      const cur = s.messages[a.d.channel_id];
      if (!cur) return s;
      return { ...s, messages: { ...s.messages, [a.d.channel_id]: cur.map((m) => (m.id === a.d.id ? a.d : m)) } };
    }
    case 'MESSAGE_DELETE': {
      const cur = s.messages[a.d.channel_id];
      if (!cur) return s;
      return { ...s, messages: { ...s.messages, [a.d.channel_id]: cur.filter((m) => m.id !== a.d.id) } };
    }
    case 'PRESENCE_UPDATE': {
      const presence = { ...s.presence };
      if (a.d.status && a.d.status !== 'offline') presence[a.d.user_id] = a.d.status;
      else delete presence[a.d.user_id];
      return { ...s, presence };
    }
    case 'VOICE_STATE_UPDATE': {
      const voice = { ...s.voice };
      const voiceFlags = { ...s.voiceFlags };
      if (a.d.channel_id) {
        voice[a.d.user_id] = a.d.channel_id;
        voiceFlags[a.d.user_id] = flagsOf(a.d);
      } else {
        delete voice[a.d.user_id];
        delete voiceFlags[a.d.user_id];
      }
      return { ...s, voice, voiceFlags };
    }
    case 'TYPING_START': {
      if (a.d.user_id === s.user?.id) return s;
      return {
        ...s,
        typing: { ...s.typing, [a.d.channel_id]: { ...s.typing[a.d.channel_id], [a.d.user_id]: Date.now() + 8000 } },
      };
    }
    case 'VOICE_SERVER_ACTION':
      return { ...s, voiceAction: { ...a.d, n: (s.voiceAction?.n ?? 0) + 1 } };
    case 'TYPING_SWEEP': {
      const now = Date.now();
      let changed = false;
      const typing: State['typing'] = {};
      for (const [ch, users] of Object.entries(s.typing)) {
        const all = Object.entries(users);
        const alive = all.filter(([, exp]) => exp > now);
        if (alive.length !== all.length) changed = true;
        typing[ch] = Object.fromEntries(alive);
      }
      return changed ? { ...s, typing } : s;
    }
    default:
      // Evento que esta versão do site não conhece (ex.: PONG): ignora em vez de apagar o estado.
      return s;
  }
}

export type Gateway = { send: (msg: object) => void };

/** Keeps the WebSocket open (reconnecting) and feeds its events into the reducer. */
export function useStore(onUnauthorized: () => void) {
  const [state, dispatch] = useReducer(reducer, initial);
  const wsRef = useRef<WebSocket | null>(null);
  const meRef = useRef<string | null>(null);
  const statusRef = useRef<UserStatus>('online');
  const [failures, setFailures] = useState(0); // tentativas seguidas sem conseguir conectar

  useEffect(() => {
    let closed = false;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout>;
    const connect = () => {
      const ws = new WebSocket(gatewayUrl(getToken() ?? ''));
      wsRef.current = ws;
      // Voltou depois de cair (o servidor reinicia a cada deploy): confere se saiu versão nova.
      if (retry > 0) ws.addEventListener('open', () => void checkForUpdate(), { once: true });
      ws.onmessage = (e) => {
        retry = 0;
        setFailures(0);
        try {
          const msg = JSON.parse(e.data);
          if (!msg?.t || msg.t === 'PONG') return;
          if (msg.t === 'READY' || (msg.t === 'USER_UPDATE' && msg.d.id === meRef.current)) setMe(msg.d.user ?? msg.d);
          if (msg.t === 'READY') {
            meRef.current = msg.d.user.id;
            statusRef.current = msg.d.status ?? 'online';
          }
          if (msg.t === 'STATUS_UPDATE') statusRef.current = msg.d.status;
          // Mensagem nova de outra pessoa: som com a aba em segundo plano e aviso na área de trabalho.
          // "Não perturbe" silencia os dois, como no Discord.
          if (msg.t === 'MESSAGE_CREATE' && msg.d.author?.id !== meRef.current && statusRef.current !== 'dnd') {
            if (document.hidden) playSound('message');
            notifyMessage(msg.d);
          }
          dispatch(msg);
        } catch {
          /* mensagem inválida: ignora */
        }
      };
      ws.onclose = (e) => {
        if (closed) return;
        if (e.code === 4001) return onUnauthorized();
        setFailures((f) => f + 1);
        // Proxies (como o do Render) podem trocar o código 4001 por 1006. Confirmamos o login por HTTP:
        // se a conta não existe mais (ex.: banco recriado), volta para a tela de login em vez de tentar para sempre.
        fetch('/api/me', { headers: { authorization: `Bearer ${getToken() ?? ''}` } })
          .then((r) => {
            if (r.status === 401 && !closed) {
              closed = true;
              onUnauthorized();
            }
          })
          .catch(() => {});
        timer = setTimeout(connect, Math.min(1000 * 2 ** retry++, 15000));
      };
    };
    connect();
    const ping = setInterval(() => wsRef.current?.readyState === 1 && wsRef.current.send('{"op":"ping"}'), 20000);
    const sweep = setInterval(() => dispatch({ t: 'TYPING_SWEEP' }), 2000);
    // Ausente sozinho depois de 10 minutos parado (como no Discord). Volta ao mexer de novo.
    const stopIdle = startIdleWatch((idle) => wsRef.current?.readyState === 1 && wsRef.current.send(JSON.stringify({ op: 'idle', idle })));
    return () => {
      closed = true;
      stopIdle();
      clearTimeout(timer);
      clearInterval(ping);
      clearInterval(sweep);
      wsRef.current?.close();
    };
  }, [onUnauthorized]);

  const gateway: Gateway = {
    send: (msg) => wsRef.current?.readyState === 1 && wsRef.current.send(JSON.stringify(msg)),
  };
  return { state, dispatch, gateway, failures };
}
