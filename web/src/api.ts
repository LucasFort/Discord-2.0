export type User = { id: string; username: string; display_name: string };
export type Channel = { id: string; guild_id: string; name: string; type: 'text' | 'voice'; position: number };
export type Guild = { id: string; name: string; owner_id: string; channels: Channel[]; members: User[] };
export type Message = {
  id: string;
  channel_id: string;
  content: string;
  created_at: number;
  edited_at: number | null;
  author: User;
  reactions?: Reaction[];
};
export type Reaction = { emoji: string; user_ids: string[] };

/** Emojis das reações (o servidor aceita só estes). */
export const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🔥', '🎉', '👀'];

/** Nome do app: troque à vontade, só evite marcas de terceiros. */
export const APP_NAME = 'Nexo';

/**
 * Endereço da API. Em dev fica vazio e o Vite repassa /api e /gateway para localhost:3001.
 * Em produção (Vercel) aponte VITE_API_URL para onde a API está publicada, ex.: https://nexo-api.onrender.com
 */
export const API_URL = ((import.meta.env.VITE_API_URL as string | undefined) ?? '').replace(/\/+$/, '');
/** Site na Vercel sem VITE_API_URL: não há API no mesmo endereço. No Render a API entrega o próprio site. */
export const API_MISSING = import.meta.env.PROD && !API_URL && location.hostname.endsWith('.vercel.app');

export function gatewayUrl(token: string) {
  const base = API_URL ? new URL(API_URL) : location;
  const proto = base.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${base.host}/gateway?token=${encodeURIComponent(token)}`;
}

let token: string | null = localStorage.getItem('token');
export const getToken = () => token;
export function setToken(t: string | null) {
  token = t;
  if (t) localStorage.setItem('token', t);
  else localStorage.removeItem('token');
}

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  if (API_MISSING) throw new Error('O servidor do app ainda não foi conectado. Tente de novo mais tarde.');
  const res = await fetch(`${API_URL}/api${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Erro ${res.status}`);
  return data as T;
}
