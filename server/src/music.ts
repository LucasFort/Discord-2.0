import { randomUUID } from 'node:crypto';
import { channelHasPeople, sendToChannel, sendToUser, usersInVoice, voiceStateOf } from './gateway.js';
import { getUser, type User } from './db.js';

/**
 * "Ouvir junto" (o Nexo DJ): fila de músicas por canal de voz.
 * O servidor guarda só a fila e o relógio (qual música, onde parou, se está tocando). O áudio em si
 * toca no player oficial do YouTube de cada pessoa da call, sincronizado por esse relógio.
 * Nada é baixado nem retransmitido, então segue os termos do YouTube e não pesa no servidor.
 */
export type MusicTrack = { id: string; video_id: string; title: string; author: string; added_by: string };
export type LoopMode = 'off' | 'one' | 'all';
type MusicState = {
  guildId: string;
  channelId: string;
  queue: MusicTrack[]; // queue[0] é a que está tocando
  playing: boolean;
  position: number; // segundos na música atual no instante updatedAt
  updatedAt: number; // Date.now() do servidor
  loop: LoopMode; // repetir: desligado, a música atual ou a fila toda
};

const MAX_QUEUE = 50;
const PLAYLIST_MAX = 25; // músicas que uma playlist põe na fila de uma vez
const states = new Map<string, MusicState>(); // channelId -> estado

const positionNow = (s: MusicState) => s.position + (s.playing ? (Date.now() - s.updatedAt) / 1000 : 0);

const payload = (s: MusicState | { guildId: string; channelId: string; queue?: undefined }) => ({
  guild_id: s.guildId,
  channel_id: s.channelId,
  queue: s.queue ?? [],
  playing: s.queue ? s.playing : false,
  position: s.queue ? s.position : 0,
  updated_at: s.queue ? s.updatedAt : Date.now(),
  loop: s.queue ? s.loop : 'off',
  server_now: Date.now(),
});

/** Só quem vê o canal de voz fica sabendo o que toca nele (canal privado não vaza o nome da música). */
const broadcast = (s: { guildId: string; channelId: string; queue?: MusicTrack[] }) =>
  sendToChannel({ id: s.channelId, guild_id: s.guildId }, 'MUSIC_STATE', payload(s as MusicState));

/** Aviso do Nexo DJ para quem está na call ("Ana pulou a música"). Quem fez a ação não recebe. */
function notice(channelId: string, text: string, exceptId?: string) {
  for (const id of usersInVoice(channelId)) if (id !== exceptId) sendToUser(id, 'MUSIC_NOTICE', { channel_id: channelId, text });
}
const nameOf = async (id: string) => (await getUser(id))?.display_name ?? 'Alguém';
const short = (t: string) => (t.length > 60 ? `${t.slice(0, 60)}…` : t);

/** Estados de música dos canais de voz que a pessoa vê (vai junto no READY). */
export const musicStatesFor = (channelIds: Set<string>) =>
  [...states.values()].filter((s) => channelIds.has(s.channelId) && s.queue.length).map(payload);

/** Todo mundo saiu do canal de voz: a fila acaba, como um bot que sai da call vazia. */
export async function onVoiceChannelLeft(channelId: string) {
  const s = states.get(channelId);
  if (!s || channelHasPeople(channelId)) return;
  states.delete(channelId);
  await broadcast({ guildId: s.guildId, channelId });
}

/** Pega o ID do vídeo de qualquer link do YouTube (watch, youtu.be, shorts, music, embed, live). */
export function youtubeId(input: string): string | null {
  const text = input.trim();
  if (/^[\w-]{11}$/.test(text)) return text;
  const url = parseUrl(text);
  if (!url) return null;
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

/** ID da playlist num link do YouTube (?list=...). Ignora os "mixes" automáticos (RD...), que a API não lista. */
export function playlistId(input: string): string | null {
  const url = parseUrl(input.trim());
  if (!url || !/(^|\.)youtube\.com$|(^|\.)youtu\.be$/.test(url.hostname)) return null;
  const id = url.searchParams.get('list');
  return id && /^[\w-]{10,64}$/.test(id) && !id.startsWith('RD') ? id : null;
}

function parseUrl(text: string) {
  if (!/[./]/.test(text) || /\s/.test(text)) return null;
  try {
    return new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
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

type MusicOp = { action?: string; url?: string; track_id?: string; position?: number; mode?: string };
type NewTrack = Omit<MusicTrack, 'id' | 'added_by'>;

/** Comandos do painel e do chat. Só quem está no canal de voz mexe na fila dele. */
export async function handleMusicOp(user: Pick<User, 'id'>, msg: MusicOp) {
  const v = voiceStateOf(user.id);
  if (!v) return sendToUser(user.id, 'MUSIC_ERROR', { message: 'Entre num canal de voz para tocar música.' });
  const fail = (message: string) => sendToUser(user.id, 'MUSIC_ERROR', { message });
  let s = states.get(v.channelId);

  if (msg.action === 'add') {
    const input = String(msg.url ?? '').trim().slice(0, 300);
    const room = MAX_QUEUE - (s?.queue.length ?? 0);
    if (room <= 0) return fail(`A fila já tem ${MAX_QUEUE} músicas.`);
    let tracks: NewTrack[] = [];
    let fromPlaylist = false;
    const listId = playlistId(input);
    if (listId && musicSearchEnabled()) {
      // Link de playlist: põe as primeiras músicas dela na fila.
      try {
        tracks = (await playlistItems(listId)).slice(0, Math.min(room, PLAYLIST_MAX));
        fromPlaylist = tracks.length > 0;
      } catch (e) {
        if (!youtubeId(input)) return fail((e as Error).message);
      }
    }
    if (!tracks.length) {
      let id = youtubeId(input);
      // Não é link (ex.: "/play despacito" no chat): toca o primeiro resultado da busca.
      if (!id && input && !listId && musicSearchEnabled()) {
        try {
          id = (await searchYouTube(input))[0]?.video_id ?? null;
        } catch (e) {
          return fail((e as Error).message);
        }
        if (!id) return fail(`Nada encontrado para "${input}".`);
      }
      if (!id)
        return fail(
          listId && !musicSearchEnabled()
            ? 'Playlists precisam da busca ligada no servidor (YOUTUBE_API_KEY). Cole o link de um vídeo.'
            : musicSearchEnabled() || !input
              ? 'Cole um link de vídeo do YouTube.'
              : 'A busca pelo nome ainda não foi ligada no servidor (falta a YOUTUBE_API_KEY). Use um link do YouTube.',
        );
      const info = await videoInfo(id);
      if (!info) return fail('Esse vídeo não existe, é privado ou o dono não deixa tocar fora do YouTube.');
      tracks = [{ video_id: id, ...info }];
    }
    // A pessoa pode ter saído da call enquanto buscávamos.
    const now = voiceStateOf(user.id);
    if (!now || now.channelId !== v.channelId) return;
    s = states.get(v.channelId);
    if (!s) {
      s = { guildId: v.guildId, channelId: v.channelId, queue: [], playing: true, position: 0, updatedAt: Date.now(), loop: 'off' };
      states.set(v.channelId, s);
    }
    tracks = tracks.slice(0, MAX_QUEUE - s.queue.length);
    if (!tracks.length) return fail(`A fila já tem ${MAX_QUEUE} músicas.`);
    const wasEmpty = s.queue.length === 0;
    s.queue.push(...tracks.map((t) => ({ ...t, id: randomUUID(), added_by: user.id })));
    if (wasEmpty) Object.assign(s, { playing: true, position: 0, updatedAt: Date.now() });
    const who = await nameOf(user.id);
    if (fromPlaylist) {
      sendToUser(user.id, 'MUSIC_ADDED', { title: `${tracks.length} músicas da playlist`, position: wasEmpty ? 0 : s.queue.length - tracks.length });
      notice(s.channelId, `🎵 ${who} pôs ${tracks.length} músicas de uma playlist na fila`, user.id);
    } else {
      // Confirmação para quem pediu (útil no /play do chat, onde o painel pode estar fechado).
      sendToUser(user.id, 'MUSIC_ADDED', { title: tracks[0].title, position: s.queue.length - 1 });
      notice(s.channelId, wasEmpty ? `🎵 Tocando agora: ${short(tracks[0].title)} (pedida por ${who})` : `🎵 ${who} pôs na fila: ${short(tracks[0].title)}`, user.id);
    }
    return broadcast(s);
  }

  if (!s || !s.queue.length) {
    if (msg.action === 'nowplaying') sendToUser(user.id, 'MUSIC_NOTICE', { channel_id: v.channelId, text: 'Nada tocando agora. Use /play para começar.' });
    return;
  }
  const current = s.queue[0];
  const who = () => nameOf(user.id);

  switch (msg.action) {
    case 'toggle':
    case 'pause':
    case 'resume': {
      const play = msg.action === 'toggle' ? !s.playing : msg.action === 'resume';
      if (s.playing === play) return;
      Object.assign(s, { position: positionNow(s), playing: play, updatedAt: Date.now() });
      notice(s.channelId, `${play ? '▶️' : '⏸️'} ${await who()} ${play ? 'voltou a tocar' : 'pausou'} a música`, user.id);
      break;
    }
    case 'seek': {
      const p = Number(msg.position);
      if (!Number.isFinite(p) || p < 0) return;
      Object.assign(s, { position: p, updatedAt: Date.now() });
      break;
    }
    case 'skip':
      // Quem clica junto não pula duas músicas: só pula se ainda for a música que a pessoa viu.
      if (msg.track_id && msg.track_id !== current.id) return;
      notice(s.channelId, `⏭️ ${await who()} pulou ${short(current.title)}`, user.id);
      next(s, true);
      announceNext(s);
      break;
    case 'ended':
      // Todo mundo da call avisa que acabou; só o primeiro aviso conta.
      if (msg.track_id !== current.id) return;
      next(s, false);
      if (s.loop !== 'one') announceNext(s);
      break;
    case 'remove': {
      const i = s.queue.findIndex((t) => t.id === msg.track_id);
      if (i < 0) return;
      if (i === 0) next(s, true);
      else s.queue.splice(i, 1);
      break;
    }
    case 'clear':
      // Limpa o que vem depois; a música atual continua.
      s.queue = s.queue.slice(0, 1);
      break;
    case 'shuffle': {
      if (s.queue.length < 3) return sendToUser(user.id, 'MUSIC_NOTICE', { channel_id: s.channelId, text: 'Precisa de pelo menos 2 músicas na fila para embaralhar.' });
      const rest = s.queue.slice(1);
      for (let i = rest.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [rest[i], rest[j]] = [rest[j], rest[i]];
      }
      s.queue = [current, ...rest];
      notice(s.channelId, `🔀 ${await who()} embaralhou a fila`, user.id);
      break;
    }
    case 'loop': {
      const order: LoopMode[] = ['off', 'all', 'one'];
      const mode = order.includes(msg.mode as LoopMode) ? (msg.mode as LoopMode) : order[(order.indexOf(s.loop) + 1) % order.length];
      if (mode === s.loop) return;
      s.loop = mode;
      const label = { off: 'desligou a repetição', all: 'ligou repetir a fila', one: 'ligou repetir esta música' }[mode];
      notice(s.channelId, `🔁 ${await who()} ${label}`, user.id);
      break;
    }
    case 'nowplaying': {
      const left = s.queue.length - 1;
      sendToUser(user.id, 'MUSIC_NOTICE', {
        channel_id: s.channelId,
        text: `🎵 ${s.playing ? 'Tocando' : 'Pausada'}: ${short(current.title)} (pedida por ${await nameOf(current.added_by)})${left ? ` · ${left} na fila` : ''}`,
      });
      return;
    }
    case 'stop':
      // Para tudo e esvazia a fila (o /stop do chat).
      s.queue = [];
      notice(s.channelId, `⏹️ ${await who()} parou a música`, user.id);
      break;
    default:
      return;
  }
  if (!s.queue.length) states.delete(s.channelId);
  await broadcast(s);
}

/**
 * Vai para a próxima música respeitando o "repetir". A faixa repetida ganha um id novo para
 * o player de todo mundo carregar de novo do começo.
 * manual = alguém pulou: com "repetir esta música" pula mesmo assim, como nos bots do Discord.
 */
function next(s: MusicState, manual: boolean) {
  const cur = s.queue.shift();
  if (cur && s.loop === 'one' && !manual) s.queue.unshift({ ...cur, id: randomUUID() });
  else if (cur && s.loop === 'all') s.queue.push({ ...cur, id: randomUUID() });
  Object.assign(s, { playing: true, position: 0, updatedAt: Date.now() });
}

function announceNext(s: MusicState) {
  const t = s.queue[0];
  if (t) notice(s.channelId, `🎵 Tocando agora: ${short(t.title)}`);
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

/** Músicas de uma playlist pública (API oficial). Pula vídeos privados ou apagados. */
export async function playlistItems(listId: string): Promise<NewTrack[]> {
  const key = process.env.YOUTUBE_API_KEY?.trim();
  if (!key) throw new Error('Playlists precisam da YOUTUBE_API_KEY no servidor.');
  const url = new URL('https://www.googleapis.com/youtube/v3/playlistItems');
  url.search = new URLSearchParams({ part: 'snippet,status', maxResults: '50', playlistId: listId, key }).toString();
  let r: Response;
  try {
    r = await fetch(url, { signal: AbortSignal.timeout(8000) });
  } catch {
    throw new Error('O YouTube não respondeu. Tente de novo.');
  }
  if (r.status === 404) throw new Error('Essa playlist não existe ou é privada.');
  if (!r.ok) {
    const body = (await r.json().catch(() => null)) as { error?: { errors?: { reason?: string }[] } } | null;
    throw new Error(/quota/i.test(body?.error?.errors?.[0]?.reason ?? '') ? 'Acabou a cota do YouTube de hoje. Amanhã volta.' : 'Não deu para abrir essa playlist.');
  }
  const data = (await r.json()) as {
    items?: { status?: { privacyStatus?: string }; snippet?: { title?: string; videoOwnerChannelTitle?: string; resourceId?: { videoId?: string } } }[];
  };
  return (data.items ?? [])
    .filter((i) => /^[\w-]{11}$/.test(i.snippet?.resourceId?.videoId ?? '') && i.status?.privacyStatus !== 'private' && i.status?.privacyStatus !== 'privacyStatusUnspecified')
    .map((i) => ({
      video_id: i.snippet!.resourceId!.videoId!,
      title: decodeEntities(i.snippet?.title ?? 'Vídeo do YouTube').slice(0, 200),
      author: decodeEntities(i.snippet?.videoOwnerChannelTitle ?? '').replace(/ - Topic$/, '').slice(0, 100),
    }));
}
