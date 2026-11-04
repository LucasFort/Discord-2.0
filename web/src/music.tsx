import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ListMusic, Music, Pause, Play, Plus, Search, SkipForward, Trash2, Volume2, VolumeX, X } from 'lucide-react';
import { api, type Guild } from './api';
import { musicPosition, type Gateway, type MusicState } from './store';
import { toast } from './toast';

/**
 * "Ouvir junto": a fila mora no servidor e cada pessoa da call toca o vídeo no player oficial do YouTube,
 * no mesmo ponto (o servidor manda o relógio). Nada é baixado nem retransmitido.
 */

type YTPlayer = {
  loadVideoById(o: { videoId: string; startSeconds?: number }): void;
  cueVideoById(o: { videoId: string; startSeconds?: number }): void;
  playVideo(): void;
  pauseVideo(): void;
  seekTo(s: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  getDuration(): number;
  getPlayerState(): number;
  setVolume(v: number): void;
  mute(): void;
  unMute(): void;
  destroy(): void;
};
type YTNamespace = { Player: new (el: HTMLElement, opts: object) => YTPlayer };
declare global {
  interface Window {
    YT?: YTNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let ytApi: Promise<YTNamespace> | null = null;
/** Carrega a API oficial do player do YouTube uma vez só. */
function loadYouTube() {
  ytApi ??= new Promise<YTNamespace>((resolve, reject) => {
    if (window.YT?.Player) return resolve(window.YT);
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      prev?.();
      resolve(window.YT!);
    };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => {
      ytApi = null;
      s.remove();
      reject(new Error('YouTube não carregou'));
    };
    document.head.appendChild(s);
  });
  return ytApi;
}

const VOL_KEY = 'nexo.musicVolume';
function readVolume() {
  try {
    const v = Number(localStorage.getItem(VOL_KEY));
    return localStorage.getItem(VOL_KEY) !== null && Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : 40;
  } catch {
    return 40;
  }
}

export const fmtTime = (s: number) => {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(Math.floor(s % 60)).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
};

const PLAYING = 1;
const PAUSED = 2;
const BUFFERING = 3;
const CUED = 5;
const ENDED = 0;

/**
 * Mini player na barra lateral, acima de "Voz conectada". Fica visível enquanto toca
 * (o YouTube pede que o player não fique escondido) e continua tocando ao trocar de canal de texto.
 */
export function MusicMiniPlayer({ music, gateway, deafened, onOpenQueue }: {
  music: MusicState;
  gateway: Gateway;
  deafened: boolean;
  onOpenQueue: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const player = useRef<YTPlayer | null>(null);
  const loaded = useRef<string | null>(null); // id da faixa (da fila) carregada no player
  const musicRef = useRef(music);
  musicRef.current = music;
  const [ready, setReady] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(readVolume);
  const [seeking, setSeeking] = useState<number | null>(null);

  const trackEnded = () => {
    if (loaded.current) gateway.send({ op: 'music', action: 'ended', track_id: loaded.current });
  };
  const endedRef = useRef(trackEnded);
  endedRef.current = trackEnded;

  useEffect(() => {
    let dead = false;
    loadYouTube()
      .then((YT) => {
        if (dead || !host.current) return;
        const el = document.createElement('div');
        host.current.appendChild(el);
        player.current = new YT.Player(el, {
          width: '100%',
          height: '100%',
          playerVars: { controls: 0, disablekb: 1, rel: 0, playsinline: 1, fs: 0, iv_load_policy: 3, origin: location.origin },
          events: {
            onReady: () => !dead && setReady(true),
            onStateChange: (e: { data: number }) => e.data === ENDED && endedRef.current(),
            onError: (e: { data: number }) => {
              const t = musicRef.current.queue[0];
              const why = e.data === 101 || e.data === 150 ? 'o dono não deixa tocar fora do YouTube' : 'o vídeo não está disponível';
              toast(`Pulando "${t?.title ?? 'música'}": ${why}.`, 'error');
              endedRef.current();
            },
          },
        });
      })
      .catch(() => toast('Não deu para carregar o player do YouTube. Confira sua internet ou bloqueador de anúncios.', 'error'));
    return () => {
      dead = true;
      player.current?.destroy();
      player.current = null;
      loaded.current = null;
    };
  }, []);

  // Acompanha o relógio do servidor: mesma música, mesmo ponto, tocando ou pausado como todo mundo.
  useEffect(() => {
    if (!ready) return;
    const sync = () => {
      const p = player.current;
      const m = musicRef.current;
      const t = m.queue[0];
      if (!p || !t) return;
      const want = musicPosition(m);
      if (loaded.current !== t.id) {
        loaded.current = t.id;
        setTime(want);
        setDuration(0);
        if (m.playing) p.loadVideoById({ videoId: t.video_id, startSeconds: want });
        else p.cueVideoById({ videoId: t.video_id, startSeconds: want });
        return;
      }
      const st = p.getPlayerState();
      const cur = p.getCurrentTime() || 0;
      if (m.playing) {
        if (st === ENDED) return;
        if (st !== PLAYING && st !== BUFFERING) p.playVideo();
        else if (st === PLAYING && Math.abs(cur - want) > 2) p.seekTo(want, true);
      } else {
        if (st === PLAYING || st === BUFFERING) p.pauseVideo();
        if (st !== CUED && Math.abs(cur - want) > 1) p.seekTo(want, true);
      }
      setTime(st === PLAYING || st === PAUSED ? cur : want);
      const d = p.getDuration();
      if (d > 0) setDuration(d);
    };
    sync();
    const iv = setInterval(sync, 1000);
    return () => clearInterval(iv);
  }, [ready, music]);

  useEffect(() => {
    const p = player.current;
    if (!ready || !p) return;
    p.setVolume(volume);
    if (deafened || volume === 0) p.mute();
    else p.unMute();
    try {
      localStorage.setItem(VOL_KEY, String(volume));
    } catch {
      /* sem localStorage: só não lembra */
    }
  }, [ready, volume, deafened]);

  const t = music.queue[0];
  const send = (action: string, extra: object = {}) => gateway.send({ op: 'music', action, ...extra });
  const shown = seeking ?? time;
  return (
    <div className="music-mini">
      <div className="music-video" ref={host} />
      <div className="music-mini-info" title={`${t.title}${t.author ? ` · ${t.author}` : ''}`}>
        <strong><Music size={12} /> <span>{t.title}</span></strong>
        {t.author && <small>{t.author}</small>}
      </div>
      <div className="music-seek">
        <small>{fmtTime(shown)}</small>
        <input
          type="range"
          min={0}
          max={Math.max(1, Math.floor(duration))}
          value={Math.min(Math.floor(shown), Math.max(1, Math.floor(duration)))}
          disabled={!duration}
          aria-label="Posição da música"
          onChange={(e) => setSeeking(+e.target.value)}
          onPointerUp={() => seeking !== null && (send('seek', { position: seeking }), setSeeking(null))}
          onKeyUp={() => seeking !== null && (send('seek', { position: seeking }), setSeeking(null))}
        />
        <small>{duration ? fmtTime(duration) : '--:--'}</small>
      </div>
      <div className="music-mini-controls">
        <button className="icon small" title={music.playing ? 'Pausar para todos' : 'Tocar para todos'} onClick={() => send('toggle')}>
          {music.playing ? <Pause size={16} /> : <Play size={16} />}
        </button>
        <button className="icon small" title="Pular música" onClick={() => send('skip', { track_id: t.id })}><SkipForward size={16} /></button>
        <button className="icon small" title={volume === 0 ? 'Ativar som da música' : 'Silenciar música (só para mim)'} onClick={() => setVolume((v) => (v === 0 ? 40 : 0))}>
          {volume === 0 || deafened ? <VolumeX size={16} /> : <Volume2 size={16} />}
        </button>
        <input className="music-volume" type="range" min={0} max={100} value={volume} onChange={(e) => setVolume(+e.target.value)} aria-label="Volume da música (só para mim)" title={`Volume da música: ${volume}% (só para você)`} />
        <button className="icon small" title={`Fila (${music.queue.length})`} onClick={onOpenQueue}><ListMusic size={16} /></button>
      </div>
    </div>
  );
}

type SearchResult = { video_id: string; title: string; author: string; thumbnail: string };

/** Painel "Música" na tela da call: colar link, ver e mexer na fila. */
export function MusicPanel({ music, gateway, guild, onClose }: {
  music?: MusicState;
  gateway: Gateway;
  guild?: Guild;
  onClose: () => void;
}) {
  const [url, setUrl] = useState('');
  const [adding, setAdding] = useState(false);
  // Busca pelo nome: null = mostrando a fila; senão, os resultados (ou carregando / erro).
  const [search, setSearch] = useState<{ q: string; loading: boolean; results: SearchResult[]; error?: string } | null>(null);
  const searchSeq = useRef(0);
  const queueLen = music?.queue.length ?? 0;
  // A fila mudou (a música entrou) ou deu erro: libera o botão. Sem resposta em 8 s, libera também.
  useEffect(() => setAdding(false), [queueLen]);
  useEffect(() => {
    if (!adding) return;
    const t = setTimeout(() => setAdding(false), 8000);
    return () => clearTimeout(t);
  }, [adding]);

  const nameOf = (id: string) => guild?.members.find((m) => m.id === id)?.display_name ?? 'alguém';
  const send = (action: string, extra: object = {}) => gateway.send({ op: 'music', action, ...extra });
  const add = (e: React.FormEvent) => {
    e.preventDefault();
    const v = url.trim();
    if (!v) return;
    // Link do YouTube: entra direto na fila. Qualquer outra coisa: busca pelo nome.
    if (/youtu\.?be|youtube\.com|^https?:\/\//i.test(v)) {
      send('add', { url: v });
      setUrl('');
      setAdding(true);
      setSearch(null);
      return;
    }
    const seq = ++searchSeq.current;
    setSearch({ q: v, loading: true, results: [] });
    api<{ results: SearchResult[] }>('GET', `/music/search?q=${encodeURIComponent(v)}`)
      .then((r) => seq === searchSeq.current && setSearch({ q: v, loading: false, results: r.results }))
      .catch((err: Error) => seq === searchSeq.current && setSearch({ q: v, loading: false, results: [], error: err.message }));
  };
  const pick = (r: SearchResult) => {
    send('add', { url: r.video_id });
    setAdding(true);
    setSearch(null);
    setUrl('');
    toast(`Adicionada: ${r.title}`);
  };
  const [now, ...next] = music?.queue ?? [];
  return (
    <aside className="people-panel music-panel">
      <header>
        <strong><Music size={14} /> Ouvir junto</strong>
        <button className="icon small" title="Fechar" onClick={onClose}><X size={16} /></button>
      </header>
      <form className="music-add" onSubmit={add}>
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Nome da música ou link do YouTube" aria-label="Nome da música ou link do YouTube" />
        <button className="primary" disabled={adding || !url.trim() || !!search?.loading} title={/youtu\.?be|youtube\.com|^https?:\/\//i.test(url.trim()) ? 'Adicionar na fila' : 'Buscar no YouTube'}>
          {adding || search?.loading ? '…' : /youtu\.?be|youtube\.com|^https?:\/\//i.test(url.trim()) ? <Plus size={16} /> : <Search size={16} />}
        </button>
      </form>
      <div className="people-list">
        {search ? (
          <>
            <div className="music-section">
              <button className="link music-back" onClick={() => (searchSeq.current++, setSearch(null))}><ArrowLeft size={14} /> Voltar para a fila</button>
            </div>
            {search.loading && <p className="music-empty">Buscando "{search.q}"…</p>}
            {search.error && <p className="music-empty error">{search.error}</p>}
            {!search.loading && !search.error && search.results.length === 0 && <p className="music-empty">Nada encontrado para "{search.q}".</p>}
            {search.results.map((r) => (
              <button key={r.video_id} className="music-row music-result" title={`Adicionar "${r.title}" na fila`} onClick={() => pick(r)}>
                <img src={r.thumbnail} alt="" loading="lazy" />
                <div className="music-row-text">
                  <strong>{r.title}</strong>
                  {r.author && <small>{r.author}</small>}
                </div>
                <Plus size={16} className="music-result-add" />
              </button>
            ))}
          </>
        ) : !now ? (
          <p className="music-empty">
            Nada tocando. Digite o nome de uma música (ou cole um link do YouTube) e todo mundo da call ouve junto, no mesmo ponto.
          </p>
        ) : (
          <>
            <div className="music-section">Tocando agora</div>
            <div className="music-row current">
              <img src={`https://i.ytimg.com/vi/${now.video_id}/mqdefault.jpg`} alt="" loading="lazy" />
              <div className="music-row-text">
                <strong title={now.title}>{now.title}</strong>
                <small>{now.author ? `${now.author} · ` : ''}pedida por {nameOf(now.added_by)}</small>
              </div>
              <button className="icon small" title={music!.playing ? 'Pausar para todos' : 'Tocar para todos'} onClick={() => send('toggle')}>
                {music!.playing ? <Pause size={16} /> : <Play size={16} />}
              </button>
              <button className="icon small" title="Pular" onClick={() => send('skip', { track_id: now.id })}><SkipForward size={16} /></button>
            </div>
            <div className="music-section">
              A seguir · {next.length}
              {next.length > 0 && <button className="link" onClick={() => send('clear')}>Limpar fila</button>}
            </div>
            {next.length === 0 && <p className="music-empty">A fila está vazia. Adicione mais músicas acima.</p>}
            {next.map((t, i) => (
              <div key={t.id} className="music-row">
                <span className="music-pos">{i + 1}</span>
                <img src={`https://i.ytimg.com/vi/${t.video_id}/mqdefault.jpg`} alt="" loading="lazy" />
                <div className="music-row-text">
                  <strong title={t.title}>{t.title}</strong>
                  <small>pedida por {nameOf(t.added_by)}</small>
                </div>
                <button className="icon small" title="Tirar da fila" onClick={() => send('remove', { track_id: t.id })}><Trash2 size={14} /></button>
              </div>
            ))}
          </>
        )}
      </div>
      <small className="music-note">Toca pelo player oficial do YouTube de cada pessoa da call. O volume da música é só seu.</small>
    </aside>
  );
}

// ---------- Comandos no chat (/play, /pause, /skip, /stop) ----------
export const MUSIC_COMMANDS = [
  { name: 'play', args: '<nome ou link>', desc: 'Toca uma música do YouTube na sua call (ou põe na fila)' },
  { name: 'pause', args: '', desc: 'Pausa a música para todos da call' },
  { name: 'resume', args: '', desc: 'Volta a tocar a música pausada' },
  { name: 'skip', args: '', desc: 'Pula para a próxima música da fila' },
  { name: 'stop', args: '', desc: 'Para a música e limpa a fila' },
] as const;
const ALIASES: Record<string, (typeof MUSIC_COMMANDS)[number]['name']> = {
  play: 'play', p: 'play', tocar: 'play',
  pause: 'pause', pausar: 'pause',
  resume: 'resume', continuar: 'resume',
  skip: 'skip', s: 'skip', pular: 'skip', next: 'skip',
  stop: 'stop', parar: 'stop',
};

/**
 * Trata "/play despacito" e afins digitados no chat. Devolve true se era um comando de música
 * (aí a mensagem não vai para o canal). Funciona de qualquer canal de texto, desde que a pessoa esteja numa call.
 */
export function runMusicCommand(raw: string, gateway: Gateway, inVoice: boolean): boolean {
  const m = /^\/(\S+)\s*([\s\S]*)$/.exec(raw.trim());
  const cmd = m && ALIASES[m[1].toLowerCase()];
  if (!m || !cmd) return false;
  if (!inVoice) {
    toast('Entre num canal de voz para usar os comandos de música.', 'error');
    return true;
  }
  const arg = m[2].trim();
  if (cmd === 'play') {
    if (!arg) toast('Use /play seguido do nome da música ou de um link do YouTube.', 'error');
    else {
      gateway.send({ op: 'music', action: 'add', url: arg });
      toast(`Procurando "${arg.length > 60 ? `${arg.slice(0, 60)}…` : arg}"…`);
    }
  } else gateway.send({ op: 'music', action: cmd });
  return true;
}
