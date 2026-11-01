import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Track } from 'livekit-client';
import {
  Expand, Hash, Headphones, HeadphoneOff, LogIn, LogOut, Maximize, Mic, MicOff, MonitorUp, MonitorX, Pencil,
  PhoneOff, Plus, Radio, Trash2, UserPlus, Video, VideoOff, Volume2, X,
} from 'lucide-react';
import { api, APP_NAME, getToken, setToken, type Channel, type Guild, type Message, type User } from './api';
import { useStore, type Gateway, type State } from './store';
import { QUALITY, useVoice, type ShareOptions, type ShareQuality, type Voice, type VoiceUser } from './voice';

export function App() {
  const [authed, setAuthed] = useState(!!getToken());
  const logout = useCallback(() => {
    setToken(null);
    setAuthed(false);
  }, []);
  return authed ? <Main onLogout={logout} /> : <Auth onDone={() => setAuthed(true)} />;
}

// ---------------------------------------------------------------- Login
function Auth({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      const r = await api<{ token: string }>('POST', `/auth/${mode}`, { username, password });
      setToken(r.token);
      onDone();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <div className="auth">
      <form onSubmit={submit} className="auth-card">
        <div className="logo"><Radio size={28} /></div>
        <h1>{mode === 'login' ? `Bem-vindo de volta ao ${APP_NAME}` : 'Criar uma conta'}</h1>
        <label>
          Usuário
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus required />
        </label>
        <label>
          Senha
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={6} />
        </label>
        {error && <p className="error">{error}</p>}
        <button className="primary">{mode === 'login' ? 'Entrar' : 'Continuar'}</button>
        <button type="button" className="link" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
          {mode === 'login' ? 'Precisa de uma conta? Registre-se' : 'Já tem uma conta? Entrar'}
        </button>
        <p className="auth-sub">Voz, vídeo e transmissão de tela com seus amigos.</p>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------- Layout
function Main({ onLogout }: { onLogout: () => void }) {
  const { state, dispatch, gateway, failures } = useStore(onLogout);
  const voice = useVoice(gateway);

  // Se a conexão em tempo real caiu e voltou, avisa de novo em qual canal de voz estamos.
  useEffect(() => {
    if (state.ready && voice.channelId) gateway.send({ op: 'voice_state', channel_id: voice.channelId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.connection]);
  const [guildId, setGuildId] = useState<string | null>(null);
  const [channelId, setChannelId] = useState<string | null>(null);
  const [view, setView] = useState<'text' | 'voice'>('text');

  const guild = state.guilds.find((g) => g.id === guildId) ?? state.guilds[0];
  const textChannel = guild?.channels.find((c) => c.id === channelId && c.type === 'text') ?? guild?.channels.find((c) => c.type === 'text');

  useEffect(() => {
    // Abre o convite de um link /convite/CODIGO
    const m = location.pathname.match(/^\/convite\/(\w+)/);
    if (m && state.ready) {
      history.replaceState(null, '', '/');
      api<Guild>('POST', `/invites/${m[1]}`).then((g) => setGuildId(g.id)).catch((e) => alert(e.message));
    }
  }, [state.ready]);

  if (!state.ready || !state.user)
    return (
      <div className="loading">
        <div>
          <p>{failures >= 3 ? 'Não foi possível conectar ao servidor. Tentando de novo…' : 'Conectando…'}</p>
          {failures >= 3 && (
            <>
              <p className="muted">Se o site acabou de acordar, pode levar até 1 minuto.</p>
              <button onClick={onLogout}>Sair e entrar de novo</button>
            </>
          )}
        </div>
      </div>
    );

  const openChannel = (c: Channel) => {
    if (c.type === 'voice') {
      if (voice.channelId !== c.id) voice.join(c.id);
      setView('voice');
    } else {
      setChannelId(c.id);
      setView('text');
    }
  };

  const createGuild = async () => {
    const name = prompt('Nome do servidor');
    if (name) setGuildId((await api<Guild>('POST', '/guilds', { name })).id);
  };
  const joinGuild = async () => {
    const input = prompt('Cole o link ou o código do convite');
    const code = input?.trim().split('/').pop();
    if (code) setGuildId((await api<Guild>('POST', `/invites/${code}`).catch((e) => (alert(e.message), null)))?.id ?? guildId);
  };

  const voiceChannel = guild?.channels.find((c) => c.id === voice.channelId);

  return (
    <div className="app">
      <nav className="guilds">
        {state.guilds.map((g) => (
          <button key={g.id} className={`guild ${g.id === guild?.id ? 'active' : ''}`} title={g.name} onClick={() => setGuildId(g.id)}>
            {initials(g.name)}
          </button>
        ))}
        <div className="guild-sep" />
        <button className="guild add" title="Criar servidor" onClick={createGuild}><Plus size={22} /></button>
        <button className="guild add" title="Entrar com convite" onClick={joinGuild}><LogIn size={20} /></button>
      </nav>

      <aside className="sidebar">
        {guild ? (
          <ChannelList
            guild={guild}
            state={state}
            me={state.user}
            activeId={view === 'voice' ? voice.channelId : textChannel?.id}
            onOpen={openChannel}
          />
        ) : (
          <div className="empty">Crie um servidor ou entre com um convite.</div>
        )}
        {voice.channelId && <VoiceBar voice={voice} channelName={voiceChannel?.name ?? 'Voz'} onOpen={() => setView('voice')} />}
        <div className="userbar">
          <Avatar user={state.user} online />
          <div className="userbar-name">
            <strong>{state.user.display_name}</strong>
            <small>@{state.user.username}</small>
          </div>
          <button className={`icon ${voice.muted ? 'danger' : ''}`} title={voice.muted ? 'Ativar microfone' : 'Silenciar'} onClick={voice.toggleMute}>
            {voice.muted ? <MicOff size={18} /> : <Mic size={18} />}
          </button>
          <button className={`icon ${voice.deafened ? 'danger' : ''}`} title={voice.deafened ? 'Ouvir' : 'Ensurdecer'} onClick={voice.toggleDeafen}>
            {voice.deafened ? <HeadphoneOff size={18} /> : <Headphones size={18} />}
          </button>
          <button className="icon" title="Sair da conta" onClick={onLogout}><LogOut size={18} /></button>
        </div>
      </aside>

      <main className="content">
        {view === 'voice' && voice.channelId ? (
          <VoiceView voice={voice} channelName={voiceChannel?.name ?? 'Voz'} />
        ) : textChannel ? (
          <Chat key={textChannel.id} channel={textChannel} state={state} dispatch={dispatch} gateway={gateway} />
        ) : (
          <div className="empty">Nenhum canal de texto.</div>
        )}
      </main>

      {guild && view === 'text' && <MemberList guild={guild} state={state} />}
    </div>
  );
}

// ---------------------------------------------------------------- Canais
function ChannelList(props: { guild: Guild; state: State; me: User; activeId?: string | null; onOpen: (c: Channel) => void }) {
  const { guild, state, me, activeId, onOpen } = props;
  const isOwner = guild.owner_id === me.id;
  const add = async (type: 'text' | 'voice') => {
    const name = prompt(type === 'text' ? 'Nome do canal de texto' : 'Nome do canal de voz');
    if (name) await api('POST', `/guilds/${guild.id}/channels`, { name, type }).catch((e) => alert(e.message));
  };
  const invite = async () => {
    const { code } = await api<{ code: string }>('POST', `/guilds/${guild.id}/invites`, {});
    const link = `${location.origin}/convite/${code}`;
    await navigator.clipboard?.writeText(link).catch(() => {});
    prompt('Convite copiado (válido por 7 dias):', link);
  };
  const section = (type: 'text' | 'voice', title: string) => (
    <>
      <div className="section">
        <span>{title}</span>
        {isOwner && <button className="icon small" title="Criar canal" onClick={() => add(type)}><Plus size={16} /></button>}
      </div>
      {guild.channels
        .filter((c) => c.type === type)
        .map((c) => (
          <div key={c.id}>
            <button className={`channel ${c.id === activeId ? 'active' : ''}`} onClick={() => onOpen(c)}>
              <span className="hash">{type === 'text' ? <Hash size={18} /> : <Volume2 size={18} />}</span> <span className="channel-name">{c.name}</span>
            </button>
            {type === 'voice' &&
              guild.members
                .filter((m) => state.voice[m.id] === c.id)
                .map((m) => (
                  <div key={m.id} className="voice-member">
                    <Avatar user={m} size={20} /> {m.display_name}
                  </div>
                ))}
          </div>
        ))}
    </>
  );
  return (
    <div className="channels">
      <header className="guild-header">
        <span>{guild.name}</span>
        <button className="icon small" title="Convidar pessoas" onClick={invite}><UserPlus size={18} /></button>
      </header>
      {section('text', 'Canais de texto')}
      {section('voice', 'Canais de voz')}
    </div>
  );
}

function MemberList({ guild, state }: { guild: Guild; state: State }) {
  const online = guild.members.filter((m) => state.online[m.id]);
  const offline = guild.members.filter((m) => !state.online[m.id]);
  return (
    <aside className="members">
      <div className="section">Online — {online.length}</div>
      {online.map((m) => (
        <div key={m.id} className="member"><Avatar user={m} online /> {m.display_name}</div>
      ))}
      <div className="section">Offline — {offline.length}</div>
      {offline.map((m) => (
        <div key={m.id} className="member offline"><Avatar user={m} /> {m.display_name}</div>
      ))}
    </aside>
  );
}

// ---------------------------------------------------------------- Chat
function Chat(props: { channel: Channel; state: State; dispatch: (a: any) => void; gateway: Gateway }) {
  const { channel, state, dispatch, gateway } = props;
  const messages = state.messages[channel.id];
  const [text, setText] = useState('');
  const [hasMore, setHasMore] = useState(true);
  const listRef = useRef<HTMLDivElement>(null);
  const lastTyping = useRef(0);
  const stick = useRef(true);

  useEffect(() => {
    api<Message[]>('GET', `/channels/${channel.id}/messages?limit=50`).then((m) => {
      dispatch({ t: 'MESSAGES_LOADED', d: { channel_id: channel.id, messages: m, older: false } });
      setHasMore(m.length === 50);
    });
  }, [channel.id, dispatch]);

  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages?.length]);

  const loadOlder = async () => {
    if (!messages?.length || !hasMore) return;
    const el = listRef.current!;
    const prevHeight = el.scrollHeight;
    const older = await api<Message[]>('GET', `/channels/${channel.id}/messages?limit=50&before=${messages[0].id}`);
    setHasMore(older.length === 50);
    stick.current = false;
    dispatch({ t: 'MESSAGES_LOADED', d: { channel_id: channel.id, messages: older, older: true } });
    requestAnimationFrame(() => (el.scrollTop = el.scrollHeight - prevHeight));
  };

  const onScroll = () => {
    const el = listRef.current!;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (el.scrollTop < 60) loadOlder();
  };

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    const content = text.trim();
    if (!content) return;
    setText('');
    stick.current = true;
    await api('POST', `/channels/${channel.id}/messages`, { content }).catch((err) => alert(err.message));
  };

  const onType = (v: string) => {
    setText(v);
    if (Date.now() - lastTyping.current > 6000) {
      lastTyping.current = Date.now();
      gateway.send({ op: 'typing', channel_id: channel.id });
    }
  };

  const typingNames = Object.keys(state.typing[channel.id] ?? {})
    .map((id) => state.guilds.flatMap((g) => g.members).find((m) => m.id === id)?.display_name)
    .filter(Boolean);

  return (
    <div className="chat">
      <header className="topbar"><span className="hash"><Hash size={20} /></span> {channel.name}</header>
      <div className="messages" ref={listRef} onScroll={onScroll}>
        {!hasMore && <div className="channel-start"><h2>Bem-vindo a #{channel.name}!</h2><p>Este é o começo do canal.</p></div>}
        {messages?.map((m, i) => {
          const prev = messages[i - 1];
          const grouped = prev && prev.author.id === m.author.id && m.created_at - prev.created_at < 5 * 60_000;
          return <MessageRow key={m.id} msg={m} grouped={!!grouped} mine={m.author.id === state.user?.id} />;
        })}
      </div>
      <form className="composer" onSubmit={send}>
        <input value={text} onChange={(e) => onType(e.target.value)} placeholder={`Conversar em #${channel.name}`} maxLength={4000} />
      </form>
      <div className="typing">{typingNames.length > 0 && `${typingNames.join(', ')} ${typingNames.length > 1 ? 'estão' : 'está'} digitando…`}</div>
    </div>
  );
}

function MessageRow({ msg, grouped, mine }: { msg: Message; grouped: boolean; mine: boolean }) {
  const time = new Date(msg.created_at);
  const edit = async () => {
    const content = prompt('Editar mensagem', msg.content);
    if (content && content !== msg.content) await api('PATCH', `/messages/${msg.id}`, { content });
  };
  const remove = async () => {
    if (confirm('Apagar esta mensagem?')) await api('DELETE', `/messages/${msg.id}`).catch((e) => alert(e.message));
  };
  return (
    <div className={`message ${grouped ? 'grouped' : ''}`}>
      {grouped ? <span className="gutter-time">{time.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</span> : <Avatar user={msg.author} size={40} />}
      <div className="message-body">
        {!grouped && (
          <div className="message-head">
            <strong>{msg.author.display_name}</strong>
            <small>{time.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}</small>
          </div>
        )}
        <div className="message-content">
          <Markdown text={msg.content} />
          {msg.edited_at && <small className="edited"> (editado)</small>}
        </div>
      </div>
      <div className="message-actions">
        {mine && <button className="icon small" title="Editar" onClick={edit}><Pencil size={16} /></button>}
        <button className="icon small" title="Apagar" onClick={remove}><Trash2 size={16} /></button>
      </div>
    </div>
  );
}

/** Markdown mínimo: **negrito**, *itálico*, `código`, ||spoiler|| e links. */
function Markdown({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\|\|[^|]+\|\||https?:\/\/\S+)/g);
  return (
    <>
      {parts.map((p, i) => {
        if (p.startsWith('**') && p.endsWith('**') && p.length > 4) return <strong key={i}>{p.slice(2, -2)}</strong>;
        if (p.startsWith('||') && p.endsWith('||') && p.length > 4) return <Spoiler key={i} text={p.slice(2, -2)} />;
        if (p.startsWith('*') && p.endsWith('*') && p.length > 2) return <em key={i}>{p.slice(1, -1)}</em>;
        if (p.startsWith('`') && p.endsWith('`') && p.length > 2) return <code key={i}>{p.slice(1, -1)}</code>;
        if (/^https?:\/\//.test(p)) return <a key={i} href={p} target="_blank" rel="noreferrer noopener">{p}</a>;
        return <span key={i}>{p}</span>;
      })}
    </>
  );
}
function Spoiler({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return <span className={`spoiler ${open ? 'open' : ''}`} onClick={() => setOpen(true)}>{text}</span>;
}

// ---------------------------------------------------------------- Voz
function VoiceBar({ voice, channelName, onOpen }: { voice: Voice; channelName: string; onOpen: () => void }) {
  return (
    <div className="voicebar">
      <button className="link voicebar-info" onClick={onOpen}>
        <strong className={voice.reconnecting || voice.connecting ? 'warn' : 'ok'}>
          <Radio size={14} /> {voice.connecting ? 'Conectando…' : voice.reconnecting ? 'Reconectando…' : 'Voz conectada'}
        </strong>
        <small>{channelName}</small>
      </button>
      {voice.sharing && <span className="live small">AO VIVO</span>}
      <button className="icon danger" title="Desconectar" onClick={voice.leave}><PhoneOff size={18} /></button>
    </div>
  );
}

function VoiceView({ voice, channelName }: { voice: Voice; channelName: string }) {
  const [shareOpen, setShareOpen] = useState(false);
  const [focus, setFocus] = useState<string | null>(null);
  const streams = voice.users.filter((u) => u.isSharing);
  const focused = streams.find((u) => u.identity === focus && u.screen);

  return (
    <div className="voice-view">
      <header className="topbar">
        <span className="hash"><Volume2 size={20} /></span> {channelName}
        {voice.reconnecting && <span className="badge warn">Reconectando…</span>}
      </header>
      {focused ? (
        <div className="stage">
          <VideoTrack track={focused.screen!} contain />
          <div className="stage-bar">
            <span className="live">AO VIVO</span> {focused.name}
            <button className="link" onClick={() => setFocus(null)}>Voltar para a grade</button>
          </div>
        </div>
      ) : (
        <div className="grid">
          {streams.map((u) => (
            <StreamTile key={`s-${u.identity}`} user={u} voice={voice} onFocus={() => setFocus(u.identity)} />
          ))}
          {voice.users.map((u) => (
            <div key={u.identity} className={`tile ${u.speaking ? 'speaking' : ''}`}>
              {u.camera ? <VideoTrack track={u.camera} mirror={u.isLocal} /> : <div className="tile-avatar">{initials(u.name)}</div>}
              <div className="tile-name">
                {u.micMuted && <MicOff size={14} className="muted-icon" />}
                {u.name}
                {u.isSharing && <span className="live">AO VIVO</span>}
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="controls">
        <button className={`round ${voice.muted ? 'off' : ''}`} title={voice.muted ? 'Ativar microfone' : 'Silenciar'} onClick={voice.toggleMute}>
          {voice.muted ? <MicOff size={22} /> : <Mic size={22} />}
        </button>
        <button className={`round ${voice.deafened ? 'off' : ''}`} title={voice.deafened ? 'Ouvir' : 'Ensurdecer'} onClick={voice.toggleDeafen}>
          {voice.deafened ? <HeadphoneOff size={22} /> : <Headphones size={22} />}
        </button>
        <button className={`round ${voice.camera ? 'on' : ''}`} title={voice.camera ? 'Desligar câmera' : 'Ligar câmera'} onClick={voice.toggleCamera}>
          {voice.camera ? <Video size={22} /> : <VideoOff size={22} />}
        </button>
        {voice.sharing ? (
          <button className="round on" title="Parar transmissão" onClick={voice.stopShare}><MonitorX size={22} /></button>
        ) : (
          <button className="round accent" title="Transmitir tela" onClick={() => setShareOpen(true)}><MonitorUp size={22} /></button>
        )}
        <button className="round danger" title="Desconectar" onClick={voice.leave}><PhoneOff size={22} /></button>
      </div>
      {shareOpen && (
        <ShareDialog
          onClose={() => setShareOpen(false)}
          onStart={async (o) => {
            setShareOpen(false);
            await voice.startShare(o).catch((e) => e?.name !== 'NotAllowedError' && alert(`Falha ao transmitir: ${e.message}`));
          }}
        />
      )}
    </div>
  );
}

function StreamTile({ user, voice, onFocus }: { user: VoiceUser; voice: Voice; onFocus: () => void }) {
  if (!user.watching || !user.screen) {
    return (
      <div className="tile stream">
        <div className="stream-cta">
          <span className="live">AO VIVO</span>
          <p>{user.name} está transmitindo</p>
          <button className="primary" onClick={() => voice.setWatch(user.identity, true)}>Assistir transmissão</button>
        </div>
      </div>
    );
  }
  return (
    <div className="tile stream" onDoubleClick={onFocus}>
      <VideoTrack track={user.screen} contain />
      <div className="tile-name">
        <span className="live">AO VIVO</span> {user.isLocal ? 'Sua transmissão' : user.name}
        <span className="tile-actions">
          <button className="icon small" title="Ampliar" onClick={onFocus}><Expand size={16} /></button>
          <button className="icon small" title="Tela cheia" onClick={(e) => (e.currentTarget.closest('.tile')?.querySelector('video') as HTMLVideoElement)?.requestFullscreen()}><Maximize size={16} /></button>
          {!user.isLocal && <button className="icon small" title="Parar de assistir" onClick={() => voice.setWatch(user.identity, false)}><X size={16} /></button>}
        </span>
      </div>
    </div>
  );
}

function ShareDialog({ onClose, onStart }: { onClose: () => void; onStart: (o: ShareOptions) => void }) {
  const [quality, setQuality] = useState<ShareQuality>('1080p30');
  const [audio, setAudio] = useState(true);
  const [optimizeFor, setOptimizeFor] = useState<'detail' | 'motion'>('detail');
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Transmitir tela</h2>
        <p className="muted">Depois de confirmar, o navegador pergunta se você quer mostrar a tela inteira, uma janela ou uma aba.</p>
        <h3>Qualidade</h3>
        <div className="options">
          {(Object.keys(QUALITY) as ShareQuality[]).map((q) => (
            <button key={q} className={`option ${q === quality ? 'selected' : ''}`} onClick={() => setQuality(q)}>
              {QUALITY[q].label}
            </button>
          ))}
        </div>
        <h3>Otimizar para</h3>
        <div className="options">
          <button className={`option ${optimizeFor === 'detail' ? 'selected' : ''}`} onClick={() => setOptimizeFor('detail')}>Texto nítido</button>
          <button className={`option ${optimizeFor === 'motion' ? 'selected' : ''}`} onClick={() => setOptimizeFor('motion')}>Movimento fluido</button>
        </div>
        <label className="check">
          <input type="checkbox" checked={audio} onChange={(e) => setAudio(e.target.checked)} /> Transmitir o áudio também
        </label>
        <div className="modal-actions">
          <button className="link" onClick={onClose}>Cancelar</button>
          <button className="primary" onClick={() => onStart({ quality, audio, optimizeFor })}>Ao vivo</button>
        </div>
      </div>
    </div>
  );
}

function VideoTrack({ track, contain, mirror }: { track: Track; contain?: boolean; mirror?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current!;
    track.attach(el);
    return () => void track.detach(el);
  }, [track]);
  return <video ref={ref} className={`${contain ? 'contain' : ''} ${mirror ? 'mirror' : ''}`} autoPlay playsInline muted />;
}

// ---------------------------------------------------------------- Utilitários
function initials(name: string) {
  return name.split(/\s+/).map((w) => w[0]).join('').slice(0, 3).toUpperCase();
}

function Avatar({ user, size = 32, online }: { user: User; size?: number; online?: boolean }) {
  const hue = [...user.id].reduce((h, c) => h + c.charCodeAt(0), 0) % 360;
  return (
    <span className="avatar" style={{ width: size, height: size, background: `hsl(${hue} 55% 45%)`, fontSize: size * 0.4 }}>
      {initials(user.display_name)}
      {online && <span className="dot" />}
    </span>
  );
}
