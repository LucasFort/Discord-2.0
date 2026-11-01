import { useEffect, useReducer, useRef, useState } from 'react';
import { playSound } from './sounds';
import { gatewayUrl, getToken, type Channel, type Guild, type Message, type User } from './api';

export type State = {
  ready: boolean;
  connection: number; // muda a cada READY (reconexão)
  user: User | null;
  guilds: Guild[];
  online: Record<string, true>;
  voice: Record<string, string>; // userId -> voice channelId
  messages: Record<string, Message[]>; // channelId -> messages
  typing: Record<string, Record<string, number>>; // channelId -> userId -> expires at
};

type Action =
  | { t: 'READY'; d: { user: User; guilds: Guild[]; presences: { user_id: string }[]; voice_states: VoiceState[] } }
  | { t: 'GUILD_CREATE'; d: Guild & { online?: string[] } }
  | { t: 'GUILD_MEMBER_ADD'; d: { guild_id: string; user: User; online?: boolean } }
  | { t: 'CHANNEL_CREATE'; d: Channel }
  | { t: 'MESSAGE_CREATE' | 'MESSAGE_UPDATE'; d: Message }
  | { t: 'MESSAGE_DELETE'; d: { id: string; channel_id: string } }
  | { t: 'MESSAGES_LOADED'; d: { channel_id: string; messages: Message[]; older: boolean } }
  | { t: 'PRESENCE_UPDATE'; d: { user_id: string; status: 'online' | 'offline' } }
  | { t: 'VOICE_STATE_UPDATE'; d: VoiceState }
  | { t: 'TYPING_START'; d: { channel_id: string; user_id: string } }
  | { t: 'TYPING_SWEEP' };

type VoiceState = { user_id: string; guild_id: string; channel_id: string | null };

const initial: State = { ready: false, connection: 0, user: null, guilds: [], online: {}, voice: {}, messages: {}, typing: {} };

function sortChannels(chs: Channel[]) {
  return [...chs].sort((a, b) => (a.type === b.type ? a.position - b.position : a.type === 'text' ? -1 : 1));
}

function reducer(s: State, a: Action): State {
  switch (a.t) {
    case 'READY': {
      const voice: State['voice'] = {};
      for (const v of a.d.voice_states) if (v.channel_id) voice[v.user_id] = v.channel_id;
      return {
        ...initial,
        ready: true,
        connection: s.connection + 1,
        user: a.d.user,
        guilds: a.d.guilds,
        online: { ...Object.fromEntries(a.d.presences.map((p) => [p.user_id, true])), [a.d.user.id]: true },
        voice,
        messages: s.messages,
      };
    }
    case 'GUILD_CREATE': {
      const { online: ids = [], ...guild } = a.d;
      return {
        ...s,
        guilds: [...s.guilds.filter((g) => g.id !== guild.id), guild],
        online: { ...s.online, ...Object.fromEntries(ids.map((id) => [id, true as const])) },
      };
    }
    case 'GUILD_MEMBER_ADD':
      return {
        ...s,
        online: a.d.online ? { ...s.online, [a.d.user.id]: true } : s.online,
        guilds: s.guilds.map((g) =>
          g.id === a.d.guild_id && !g.members.some((m) => m.id === a.d.user.id) ? { ...g, members: [...g.members, a.d.user] } : g,
        ),
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
      const online = { ...s.online };
      if (a.d.status === 'online') online[a.d.user_id] = true;
      else delete online[a.d.user_id];
      return { ...s, online };
    }
    case 'VOICE_STATE_UPDATE': {
      const voice = { ...s.voice };
      if (a.d.channel_id) voice[a.d.user_id] = a.d.channel_id;
      else delete voice[a.d.user_id];
      return { ...s, voice };
    }
    case 'TYPING_START': {
      if (a.d.user_id === s.user?.id) return s;
      return {
        ...s,
        typing: { ...s.typing, [a.d.channel_id]: { ...s.typing[a.d.channel_id], [a.d.user_id]: Date.now() + 8000 } },
      };
    }
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
  const [failures, setFailures] = useState(0); // tentativas seguidas sem conseguir conectar

  useEffect(() => {
    let closed = false;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout>;
    const connect = () => {
      const ws = new WebSocket(gatewayUrl(getToken() ?? ''));
      wsRef.current = ws;
      ws.onmessage = (e) => {
        retry = 0;
        setFailures(0);
        try {
          const msg = JSON.parse(e.data);
          if (!msg?.t || msg.t === 'PONG') return;
          if (msg.t === 'READY') meRef.current = msg.d.user.id;
          // Mensagem nova de outra pessoa com a aba em segundo plano: toca um aviso curto.
          if (msg.t === 'MESSAGE_CREATE' && document.hidden && msg.d.author?.id !== meRef.current) playSound('message');
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
    return () => {
      closed = true;
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
