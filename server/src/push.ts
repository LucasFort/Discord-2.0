import webpush from 'web-push';
import { all, get, getStatus, run, type Channel, type Message } from './db.js';
import { isOnline } from './gateway.js';
import { P, type PermContext } from './permissions.js';

/**
 * Avisos com o Nexo fechado (Web Push). O navegador ou o celular da pessoa guarda uma inscrição,
 * e o servidor manda o aviso por ela quando chega DM ou menção e a pessoa não está com o Nexo aberto.
 * As chaves VAPID vêm de VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY ou são criadas uma vez e guardadas no banco.
 */
export type PushMode = 'all' | 'mentions';

let keys: { publicKey: string; privateKey: string } | null = null;

async function vapid() {
  if (keys) return keys;
  const envPub = process.env.VAPID_PUBLIC_KEY?.trim();
  const envPriv = process.env.VAPID_PRIVATE_KEY?.trim();
  if (envPub && envPriv) keys = { publicKey: envPub, privateKey: envPriv };
  else {
    const row = (await get("SELECT value FROM app_config WHERE key = 'vapid'")) as { value: string } | undefined;
    if (row) keys = JSON.parse(row.value);
    else {
      const k = webpush.generateVAPIDKeys();
      await run("INSERT INTO app_config (key, value) VALUES ('vapid', ?)", JSON.stringify(k));
      // Outra instância pode ter criado ao mesmo tempo: fica a que está no banco.
      const saved = (await get("SELECT value FROM app_config WHERE key = 'vapid'")) as { value: string };
      keys = JSON.parse(saved.value);
    }
  }
  webpush.setVapidDetails(process.env.VAPID_SUBJECT?.trim() || 'https://github.com/LucasFort/Discord-2.0', keys!.publicKey, keys!.privateKey);
  return keys!;
}

export const pushPublicKey = async () => (await vapid()).publicKey;

export async function saveSubscription(userId: string, sub: { endpoint: string; keys: { p256dh: string; auth: string } }, mode: PushMode, hide: boolean) {
  // A mesma inscrição (mesmo navegador) passa para quem entrou por último nele.
  await run('DELETE FROM push_subscriptions WHERE endpoint = ?', sub.endpoint);
  await run(
    'INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, mode, hide_content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    sub.endpoint, userId, sub.keys.p256dh, sub.keys.auth, mode, hide ? 1 : 0, Date.now(),
  );
}

export const removeSubscription = (userId: string, endpoint: string) =>
  run('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?', endpoint, userId);

type SubRow = { endpoint: string; user_id: string; p256dh: string; auth: string; mode: PushMode; hide_content: number };

/** A mensagem chama a pessoa: @usuário, @nome, @todos ou resposta a uma mensagem dela. */
function mentions(msg: Message, user: { id: string; username: string; display_name: string }) {
  if (msg.reply?.author.id === user.id) return true;
  const c = msg.content.toLowerCase();
  return c.includes('@todos') || c.includes('@everyone') || c.includes(`@${user.username.toLowerCase()}`) || c.includes(`@${user.display_name.toLowerCase()}`);
}

/** Manda o aviso de uma mensagem nova para quem pode ver o canal e está com o Nexo fechado. */
export async function pushMessage(ch: Channel, msg: Message, ctx: NonNullable<PermContext>) {
  const targets = [...ctx.members].filter((id) => id !== msg.author.id && !isOnline(id) && ctx.can(id, P.VIEW_CHANNEL, ch.id));
  if (!targets.length) return;
  const subs = (await all(
    `SELECT s.endpoint, s.user_id, s.p256dh, s.auth, s.mode, s.hide_content, u.username, u.display_name
       FROM push_subscriptions s JOIN users u ON u.id = s.user_id
      WHERE s.user_id IN (${targets.map(() => '?').join(',')})`,
    ...targets,
  )) as (SubRow & { username: string; display_name: string })[];
  if (!subs.length) return;
  await vapid();
  const dndCache = new Map<string, boolean>();
  const text = msg.content.trim() || (msg.attachments?.length ? '📎 Enviou um arquivo' : '');
  const title = ctx.isDm ? msg.author.display_name : `${msg.author.display_name} (#${ch.name}, ${ctx.guild.name})`;
  await Promise.all(
    subs.map(async (s) => {
      if (s.mode !== 'all' && !ctx.isDm && !mentions(msg, { id: s.user_id, username: s.username, display_name: s.display_name })) return;
      if (!dndCache.has(s.user_id)) dndCache.set(s.user_id, (await getStatus(s.user_id)) === 'dnd');
      if (dndCache.get(s.user_id)) return;
      const payload = Number(s.hide_content)
        ? { title: 'Nexo', body: 'Nova mensagem', tag: ch.id, url: `/?canal=${ch.id}` }
        : { title, body: text.slice(0, 180), tag: ch.id, url: `/?canal=${ch.id}` };
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload), { TTL: 60 * 60 * 24, urgency: 'high' });
      } catch (e) {
        const code = (e as { statusCode?: number }).statusCode;
        // 404/410: a pessoa desinstalou ou bloqueou os avisos; a inscrição não vale mais.
        if (code === 404 || code === 410) await run('DELETE FROM push_subscriptions WHERE endpoint = ?', s.endpoint);
        else console.warn('push falhou', code ?? (e as Error).message);
      }
    }),
  );
}
