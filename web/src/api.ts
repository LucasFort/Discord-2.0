import type { Overwrite, Role } from './permissions';

/** Perfil público. A foto é uma imagem pequena em data URL. */
export type User = {
  id: string;
  username: string;
  display_name: string;
  avatar?: string | null;
  bio?: string | null;
  pronouns?: string | null;
  banner_color?: string | null;
  custom_status?: string | null;
};
/** Status escolhido: "invisible" aparece como offline para os outros. */
export type UserStatus = 'online' | 'idle' | 'dnd' | 'invisible';
/** O que aparece para os outros (bolinha ao lado da foto). */
export type Presence = 'online' | 'idle' | 'dnd' | 'offline';
export const STATUS_LABELS: Record<UserStatus, string> = { online: 'Disponível', idle: 'Ausente', dnd: 'Não perturbe', invisible: 'Invisível' };
export type Channel = {
  id: string; guild_id: string; name: string; type: 'text' | 'voice'; position: number; topic?: string | null; last_message_id?: string | null;
  overwrites?: Overwrite[]; // permissões do canal por cargo
};
/** is_dm = 1: conversa direta (um "servidor" escondido com duas pessoas, um canal de texto e um de voz). */
export type Guild = {
  id: string; name: string; owner_id: string; icon?: string | null; is_dm?: number; channels: Channel[]; members: User[];
  roles?: Role[]; // do mais alto para o mais baixo; o @everyone tem o id do servidor
  member_roles?: Record<string, string[]>; // userId -> cargos
};
export const isDm = (g: Pick<Guild, 'is_dm'> | undefined) => !!g && !!Number(g.is_dm ?? 0);
/** Dono de verdade: conversa direta não tem dono. */
export const ownsGuild = (g: Pick<Guild, 'is_dm' | 'owner_id'> | undefined, userId: string | undefined) => !!g && !isDm(g) && g.owner_id === userId;
/** A outra pessoa de uma conversa direta. */
export const dmOther = (g: Guild, meId: string) => g.members.find((m) => m.id !== meId) ?? g.members[0];
/** Amizade ou pedido pendente: "outgoing" = eu pedi, "incoming" = me pediram. */
export type Relationship = { user: User; type: 'friend' | 'outgoing' | 'incoming' };
export type Message = {
  id: string;
  channel_id: string;
  content: string;
  created_at: number;
  edited_at: number | null;
  author: User;
  reactions?: Reaction[];
  reply_to?: string | null;
  reply?: { id: string; author: User; content: string } | null;
  pinned?: boolean;
  attachments?: Attachment[];
};
export type Attachment = { id: string; name: string; type: string; size: number; url: string };
/** Endereço completo de um anexo (a API pode estar em outro domínio). */
export const fileUrl = (url: string) => `${API_URL}${url}`;
export type Reaction = { emoji: string; user_ids: string[] };

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
