import { randomUUID } from 'node:crypto';
import { channelHasPeople, sendToGuild, sendToUser, voiceStateOf } from './gateway.js';
import type { User } from './db.js';

/**
 * "Ouvir junto": fila de músicas por canal de voz.
 * O servidor guarda só a fila e o relógio (qual música, onde parou, se está tocando). O áudio em si
 * toca no player oficial do YouTube de cada pessoa da call, sincronizado por esse relógio.
 * Nada é baixado nem retransmitido, então segue os termos do YouTube e não pesa no servidor.
 */
export type MusicTrack = { id: string; video_id: string; title: string; author: string; added_by: string };
type MusicState = {
  guildId: string;
  channelId: string;
  queue: MusicTrack[]; // queue[0] é a que está tocando
  playing: boolean;
  position: number; // segundos na música atual no instante updatedAt
  updatedAt: number; // Date.now() do servidor
};

const MAX_QUEUE = 50;
const states = new Map<string, MusicState>(); // channelId -> estado

const positionNow = (s: MusicState) => s.position + (s.playing ? (Date.now() - s.updatedAt) / 1000 : 0);

const payload = (s: MusicState | { guildId: string; channelId: string; queue?: undefined }) => ({
  guild_id: s.guildId,
  channel_id: s.channelId,
  queue: s.queue ?? [],
  playing: s.queue ? s.playing : false,
  position: s.queue ? s.position : 0,
  updated_at: s.queue ? s.updatedAt : Date.now(),
  server_now: Date.now(),
});

const broadcast = (s: MusicState) => sendToGuild(s.guildId, 'MUSIC_STATE', payload(s));

/** Estados de música dos servidores da pessoa (vai junto no READY). */
export const musicStatesFor = (guildIds: Set<string>) =>
  [...states.values()].filter((s) => guildIds.has(s.guildId) && s.queue.length).map(payload);

/** Todo mundo saiu do canal de voz: a fila acaba, como num bot que sai da call vazia. */
export async function onVoiceChannelLeft(channelId: string) {
  const s = states.get(channelId);
  if (!s || channelHasPeople(channelId)) return;
  states.delete(channelId);
  await sendToGuild(s.guildId, 'MUSIC_STATE', payload({ guildId: s.guildId, channelId }));
}

/** Pega o ID do vídeo de qualquer link do YouTube (watch, youtu.be, shorts, music, embed, live). */
export function youtubeId(input: string): string | null {
  const text = input.trim();
  if (/^[\w-]{11}$/.test(text)) return text;
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^(www|m|music)\./, '');
  let id: string | null = null;
  if (host === 'youtu.be') id = url.pathname.slice(1, 12);
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    id = url.searchParams.get('v');
    const m = url.pathname.match(/^\/(?:shorts|embed|live|v)\/([\w-]{11})/);
    if (!id && m) id = m[1];
  }
  return id && /^[\w-]{11}$/.test(id) ? id : null;
}

/** Título e canal pelo oEmbed público do YouTube. Responde null se o vídeo não pode tocar fora do YouTube. */
async function videoInfo(id: string): Promise<{ title: string; author: string } | null> {
  try {
    const r = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}`, {
      signal: AbortSignal.timeout(5000),
    });
    // 401/403: o dono bloqueou o player incorporado. 400/404: vídeo não existe ou é privado.
    if ([400, 401, 403, 404].includes(r.status)) return null;
    if (!r.ok) throw new Error(String(r.status));
    const j = (await r.json()) as { title?: string; author_name?: string };
    return { title: String(j.title ?? 'Vídeo do YouTube').slice(0, 200), author: String(j.author_name ?? '').slice(0, 100) };
  } catch {
    // YouTube fora do ar ou lento: toca assim mesmo, só sem o nome bonito.
    return { title: 'Vídeo do YouTube', author: '' };
  }
}

type MusicOp = { action?: string; url?: string; track_id?: string; position?: number };

/** Comandos do painel de música. Só quem está no canal de voz mexe na fila dele. */
export async function handleMusicOp(user: Pick<User, 'id'>, msg: MusicOp) {
  const v = voiceStateOf(user.id);
  if (!v) return sendToUser(user.id, 'MUSIC_ERROR', { message: 'Entre num canal de voz para tocar música.' });
  let s = states.get(v.channelId);

  if (msg.action === 'add') {
    const input = String(msg.url ?? '').trim().slice(0, 200);
    let id = youtubeId(input);
    // Não é link (ex.: "/play despacito" no chat): toca o primeiro resultado da busca.
    if (!id && input && musicSearchEnabled()) {
      try {
        id = (await searchYouTube(input))[0]?.video_id ?? null;
      } catch (e) {
        return sendToUser(user.id, 'MUSIC_ERROR', { message: (e as Error).message });
      }
      if (!id) return sendToUser(user.id, 'MUSIC_ERROR', { message: `Nada encontrado para "${input}".` });
    }
    if (!id)
      return sendToUser(user.id, 'MUSIC_ERROR', {
        message: musicSearchEnabled() || !input ? 'Cole um link de vídeo do YouTube.' : 'A busca pelo nome ainda não foi ligada no servidor (falta a YOUTUBE_API_KEY). Use um link do YouTube.',
      });
    if (s && s.queue.length >= MAX_QUEUE) return sendToUser(user.id, 'MUSIC_ERROR', { message: `A fila já tem ${MAX_QUEUE} músicas.` });
    const info = await videoInfo(id);
    if (!info) return sendToUser(user.id, 'MUSIC_ERROR', { message: 'Esse vídeo não existe, é privado ou o dono não deixa tocar fora do YouTube.' });
    // A pessoa pode ter saído da call enquanto buscávamos o título.
    const now = voiceStateOf(user.id);
    if (!now || now.channelId !== v.channelId) return;
    s = states.get(v.channelId);
    if (!s) {
      s = { guildId: v.guildId, channelId: v.channelId, queue: [], playing: true, position: 0, updatedAt: Date.now() };
      states.set(v.channelId, s);
    }
    s.queue.push({ id: randomUUID(), video_id: id, title: info.title, author: info.author, added_by: user.id });
    if (s.queue.length === 1) Object.assign(s, { playing: true, position: 0, updatedAt: Date.now() });
    // Confirmação para quem pediu (útil no /play do chat, onde o painel pode estar fechado).
    sendToUser(user.id, 'MUSIC_ADDED', { title: info.title, position: s.queue.length - 1 });
    return broadcast(s);
  }

  if (!s || !s.queue.length) return;
  const current = s.queue[0];

  switch (msg.action) {
    case 'toggle':
      Object.assign(s, { position: positionNow(s), playing: !s.playing, updatedAt: Date.now() });
      break;
    case 'seek': {
      const p = Number(msg.position);
      if (!Number.isFinite(p) || p < 0) return;
      Object.assign(s, { position: p, updatedAt: Date.now() });
      break;
    }
    case 'skip':
      // Quem clica junto não pula duas músicas: só pula se ainda for a música que a pessoa viu.
      if (msg.track_id && msg.track_id !== current.id) return;
      next(s);
      break;
    case 'ended':
      // Todo mundo da call avisa que acabou; só o primeiro aviso conta.
      if (msg.track_id !== current.id) return;
      next(s);
      break;
    case 'remove': {
      const i = s.queue.findIndex((t) => t.id === msg.track_id);
      if (i < 0) return;
      if (i === 0) next(s);
      else s.queue.splice(i, 1);
      break;
    }
    case 'clear':
      // Limpa o que vem depois; a música atual continua.
      s.queue = s.queue.slice(0, 1);
      break;
    case 'pause':
    case 'resume':
      if (s.playing === (msg.action === 'resume')) return;
      Object.assign(s, { position: positionNow(s), playing: msg.action === 'resume', updatedAt: Date.now() });
      break;
    case 'stop':
      // Para tudo e esvazia a fila (o /stop do chat).
      s.queue = [];
      break;
    default:
      return;
  }
  if (!s.queue.length) states.delete(s.channelId);
  await broadcast(s);
}

function next(s: MusicState) {
  s.queue.shift();
  Object.assign(s, { playing: true, position: 0, updatedAt: Date.now() });
}

// ---------- Busca pelo nome (API oficial do YouTube) ----------
// Erros saem com status 400 para a mensagem chegar na tela (o setErrorHandler esconde as de 5xx).
export type SearchResult = { video_id: string; title: string; author: string; thumbnail: string };
const searchCache = new Map<string, { at: number; results: SearchResult[] }>();
const SEARCH_TTL = 6 * 60 * 60 * 1000; // a cota grátis é pequena: a mesma busca não gasta de novo por 6 h

const decodeEntities = (s: string) =>
  s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

export const musicSearchEnabled = () => !!process.env.YOUTUBE_API_KEY?.trim();

/** Busca vídeos que podem tocar fora do YouTube. Lança erro com mensagem para mostrar na tela. */
export async function searchYouTube(query: string): Promise<SearchResult[]> {
  const key = process.env.YOUTUBE_API_KEY?.trim();
  if (!key) throw Object.assign(new Error('A busca pelo nome ainda não foi ligada no servidor (falta a chave YOUTUBE_API_KEY). Cole um link do YouTube.'), { statusCode: 400 });
  const q = query.trim().toLowerCase();
  const hit = searchCache.get(q);
  if (hit && Date.now() - hit.at < SEARCH_TTL) return hit.results;
  const url = new URL('https://www.googleapis.com/youtube/v3/search');
  url.search = new URLSearchParams({
    part: 'snippet',
    type: 'video',
    videoEmbeddable: 'true',
    videoSyndicated: 'true',
    maxResults: '8',
    q: query.trim(),
    key,
  }).toString();
  let r: Response;
  try {
    r = await fetch(url, { signal: AbortSignal.timeout(8000) });
  } catch {
    throw Object.assign(new Error('O YouTube não respondeu. Tente de novo.'), { statusCode: 400 });
  }
  if (!r.ok) {
    const body = (await r.json().catch(() => null)) as { error?: { errors?: { reason?: string }[] } } | null;
    const reason = body?.error?.errors?.[0]?.reason ?? '';
    const msg = /quota/i.test(reason)
      ? 'Acabou a cota de buscas de hoje. Amanhã volta; até lá, cole o link do YouTube.'
      : /keyInvalid|badRequest|forbidden|accessNotConfigured/i.test(reason) || r.status === 400 || r.status === 403
        ? 'A chave do YouTube no servidor não funcionou (confira se a YouTube Data API v3 está ativada). Cole um link por enquanto.'
        : 'A busca do YouTube falhou. Tente de novo.';
    throw Object.assign(new Error(msg), { statusCode: 400 });
  }
  const data = (await r.json()) as {
    items?: { id?: { videoId?: string }; snippet?: { title?: string; channelTitle?: string; liveBroadcastContent?: string; thumbnails?: Record<string, { url?: string }> } }[];
  };
  const results = (data.items ?? [])
    .filter((i) => i.id?.videoId && /^[\w-]{11}$/.test(i.id.videoId))
    .map((i) => ({
      video_id: i.id!.videoId!,
      title: decodeEntities(i.snippet?.title ?? 'Vídeo do YouTube'),
      author: decodeEntities(i.snippet?.channelTitle ?? ''),
      thumbnail: `https://i.ytimg.com/vi/${i.id!.videoId}/mqdefault.jpg`,
    }));
  if (searchCache.size > 500) searchCache.clear();
  searchCache.set(q, { at: Date.now(), results });
  return results;
}
