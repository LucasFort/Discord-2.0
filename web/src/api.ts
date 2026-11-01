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
};

/** Nome do app: troque à vontade, só evite marcas de terceiros. */
export const APP_NAME = 'Nexo';

let token: string | null = localStorage.getItem('token');
export const getToken = () => token;
export function setToken(t: string | null) {
  token = t;
  if (t) localStorage.setItem('token', t);
  else localStorage.removeItem('token');
}

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
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
