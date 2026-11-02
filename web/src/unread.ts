import { useEffect, useState } from 'react';
import type { Message, User } from './api';
import { mentionsMe } from './notify';

/**
 * Canais não lidos e menções (como as bolinhas e o contador vermelho do Discord).
 * Fica salvo no navegador: o último id lido de cada canal e quantas menções chegaram sem ler.
 * Os ids das mensagens são ordenáveis pelo tempo, então "id maior" = mensagem mais nova.
 */
const KEY = 'nexo.unread';
type Data = { baseline: string; read: Record<string, string>; mentions: Record<string, number> };

const nowId = () => Date.now().toString(36).padStart(10, '0');
function load(): Data {
  try {
    const d = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Data | null;
    if (d?.baseline) return { baseline: d.baseline, read: d.read ?? {}, mentions: d.mentions ?? {} };
  } catch {
    /* sem armazenamento */
  }
  // Primeira vez: o que já existia conta como lido.
  return { baseline: nowId(), read: {}, mentions: {} };
}
let data = load();
let active: string | null = null; // canal aberto agora (com a janela em foco)
const listeners = new Set<() => void>();
let version = 0;
function save() {
  version++;
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
  } catch {
    /* ignora */
  }
  listeners.forEach((l) => l());
}

export const lastRead = (channelId: string) => data.read[channelId] ?? data.baseline;
export const isUnread = (channelId: string, lastMessageId?: string | null) => !!lastMessageId && lastMessageId > lastRead(channelId);
export const mentionCount = (channelId: string) => data.mentions[channelId] ?? 0;

export function markRead(channelId: string, messageId?: string | null) {
  const had = data.mentions[channelId];
  if (messageId && messageId > lastRead(channelId)) data.read[channelId] = messageId;
  else if (!had) return;
  delete data.mentions[channelId];
  save();
}

export function setActiveChannel(channelId: string | null) {
  active = channelId;
}

/** Mensagem nova chegou: conta menção se não for minha e o canal não estiver aberto na tela. */
export function noteMessage(msg: Message, me: User | null) {
  if (!me || msg.author.id === me.id) return markRead(msg.channel_id, msg.id);
  const visible = active === msg.channel_id && document.hasFocus() && !document.hidden;
  if (visible) return markRead(msg.channel_id, msg.id);
  if (mentionsMe(msg.content, me)) {
    data.mentions[msg.channel_id] = (data.mentions[msg.channel_id] ?? 0) + 1;
    save();
  } else listeners.forEach((l) => l());
}

/** Re-renderiza quando algo muda (lido, menção nova). */
export function useUnreadVersion() {
  const [, set] = useState(version);
  useEffect(() => {
    const l = () => set(version + Math.random());
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
}
