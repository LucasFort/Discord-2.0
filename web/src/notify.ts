import type { Message, User } from './api';
import { getSettings } from './settings';

let me: User | null = null;
export const setMe = (u: User) => void (me = u);

/** Canais de texto das conversas diretas: toda mensagem neles conta como menção (como no Discord). */
let directChannels = new Set<string>();
export const setDirectChannels = (ids: Iterable<string>) => void (directChannels = new Set(ids));
export const addDirectChannels = (ids: Iterable<string>) => void (directChannels = new Set([...directChannels, ...ids]));
export const isDirect = (channelId: string) => directChannels.has(channelId);

/** Quem eu bloqueei: mensagens dessas pessoas não avisam nem tocam som. */
let blocked = new Set<string>();
export const setBlocked = (ids: Iterable<string>) => void (blocked = new Set(ids));
export const isBlocked = (userId: string | undefined) => !!userId && blocked.has(userId);

/** Pede permissão para avisos na área de trabalho (precisa vir de um clique). */
export async function requestNotifyPermission() {
  if (typeof Notification === 'undefined') return 'unsupported' as const;
  if (Notification.permission === 'default') return Notification.requestPermission();
  return Notification.permission;
}

/** A mensagem cita você (@usuário, @nome ou @todos). */
export function mentionsMe(content: string, user: User | null = me) {
  if (!user) return false;
  const c = content.toLowerCase();
  return c.includes('@todos') || c.includes('@everyone') || c.includes(`@${user.username.toLowerCase()}`) || c.includes(`@${user.display_name.toLowerCase()}`);
}

/** Aviso na área de trabalho de mensagem nova, quando o Nexo não está em foco. */
export function notifyMessage(msg: Message) {
  const s = getSettings();
  if (s.desktopNotify === 'off' || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  if (document.hasFocus() && !document.hidden) return;
  if (s.desktopNotify === 'mentions' && !isDirect(msg.channel_id) && !mentionsMe(msg.content)) return;
  const body = s.streamerMode ? 'Nova mensagem' : msg.content.slice(0, 180);
  try {
    const n = new Notification(s.streamerMode ? 'Nexo' : msg.author.display_name, { body, tag: msg.channel_id, silent: true });
    n.onclick = () => {
      window.focus();
      n.close();
    };
  } catch {
    /* navegador sem suporte a Notification no contexto atual */
  }
}
