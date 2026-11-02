import type { Message, User } from './api';
import { getSettings } from './settings';

let me: User | null = null;
export const setMe = (u: User) => void (me = u);

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
  if (s.desktopNotify === 'mentions' && !mentionsMe(msg.content)) return;
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
