import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { LocalVideoTrack, RemoteVideoTrack, type Track } from 'livekit-client';
import {
  Activity, Bell, Settings as SettingsIcon, BellOff, Expand, SmilePlus, Hash, Headphones, HeadphoneOff, LogIn, LogOut, Maximize, Mic, MicOff, MonitorUp, MonitorX, Pencil,
  Phone, PhoneOff, Plus, Users, UserCheck, UserX, MessageCircle, Radio, Trash2, UserPlus, Video, VideoOff, Volume2, X,
} from 'lucide-react';
import { api, APP_NAME, getToken, REACTIONS, setToken, type Channel, type Guild, type Message, type User } from './api';
import { playSound, setSoundsEnabled, soundsEnabled } from './sounds';
import { toast, useToasts } from './toast';
import { ask, AskHost } from './ask';
import { SettingsView } from './SettingsView';
import { updateSettings, useSettings } from './settings';
import { onGatewayEvent, useStore, type Gateway, type State } from './store';
import { CALL_EMOJIS, QUALITY, useVoice, type ShareOptions, type ShareQuality, type Voice, type VoiceUser } from './voice';

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
  const [sounds, setSounds] = useState(soundsEnabled);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const incomingCount = Object.values(state.relationships).filter((r) => r.type === 'incoming').length;

  const [dmId, setDmId] = useState<string | null>(null);
  const servers = state.guilds.filter((g) => !g.is_dm);
  const dms = state.guilds.filter((g) => g.is_dm);
  const home = guildId === '@me' || (guildId === null && servers.length === 0);
  const guild = home ? dms.find((g) => g.id === dmId) : servers.find((g) => g.id === guildId) ?? servers[0];
  const dmPeer = (g?: Guild) => g?.members.find((m) => m.id !== state.user?.id);
  const openDm = async (userId: string) => {
    const g = await api<Guild>('POST', `/dms/${userId}`).catch((e) => (alert(e.message), null));
    if (!g) return;
    setGuildId('@me');
    setDmId(g.id);
    setView('text');
  };

  // Avisos: mensagem direta nova (fora da conversa aberta) e pedido de amizade.
  const openRef = useRef<string | undefined>(undefined);
  useEffect(
    () =>
      onGatewayEvent((e) => {
        if (e.t === 'MESSAGE_CREATE' && e.d.author?.id !== state.user?.id) {
          const g = state.guilds.find((x) => x.channels.some((c) => c.id === e.d.channel_id));
          if (g?.is_dm && (openRef.current !== e.d.channel_id || document.hidden)) {
            toast(`💬 ${e.d.author.display_name}: ${String(e.d.content).slice(0, 60)}`);
            playSound('message');
          }
        }
        if (e.t === 'RELATIONSHIP_ADD' && e.d.type === 'incoming') {
          toast(`${e.d.user.display_name} quer ser seu amigo`, 'join');
          playSound('message');
        }
        if (e.t === 'RELATIONSHIP_ADD' && e.d.type === 'friend' && state.relationships[e.d.user.id]?.type === 'outgoing')
          toast(`${e.d.user.display_name} aceitou seu pedido de amizade`, 'join');
      }),
    [state.guilds, state.user?.id, state.relationships],
  );
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
    const name = await ask('Nome do servidor', { okText: 'Criar' });
    if (name) setGuildId((await api<Guild>('POST', '/guilds', { name })).id);
  };
  const joinGuild = async () => {
    const input = await ask('Cole o link ou o código do convite', { okText: 'Entrar' });
    const code = input?.trim().split('/').pop();
    if (code) setGuildId((await api<Guild>('POST', `/invites/${code}`).catch((e) => (alert(e.message), null)))?.id ?? guildId);
  };

  const voiceGuild = state.guilds.find((g) => g.channels.some((c) => c.id === voice.channelId));
  const voiceChannelName = voiceGuild?.is_dm
    ? `Chamada com ${dmPeer(voiceGuild)?.display_name ?? ''}`
    : voiceGuild?.channels.find((c) => c.id === voice.channelId)?.name ?? 'Voz';
  openRef.current = view === 'text' ? textChannel?.id : undefined;

  return (
    <div className="app">
      <nav className="guilds">
        <button className={`guild home ${home ? 'active' : ''}`} title="Amigos e mensagens diretas" onClick={() => { setGuildId('@me'); setView('text'); }}>
          <Users size={22} />
          {incomingCount > 0 && <span className="guild-badge">{incomingCount}</span>}
        </button>
        <div className="guild-sep" />
        {servers.map((g) => (
          <button key={g.id} className={`guild ${!home && g.id === guild?.id ? 'active' : ''}`} title={g.name} onClick={() => { setGuildId(g.id); setView('text'); }}>
            {initials(g.name)}
          </button>
        ))}
        <div className="guild-sep" />
        <button className="guild add" title="Criar servidor" onClick={createGuild}><Plus size={22} /></button>
        <button className="guild add" title="Entrar com convite" onClick={joinGuild}><LogIn size={20} /></button>
      </nav>

      <aside className="sidebar">
        {home ? (
          <HomeSidebar
            dms={dms}
            state={state}
            activeId={dmId}
            onFriends={() => { setDmId(null); setView('text'); }}
            onOpen={(id) => { setDmId(id); setView('text'); }}
          />
        ) : guild ? (
          <ChannelList
            guild={guild}
            state={state}
            me={state.user}
            activeId={view === 'voice' ? voice.channelId : textChannel?.id}
            onOpen={openChannel}
            voiceSpeaking={new Set(voice.users.filter((u) => u.speaking).map((u) => u.identity))}
          />
        ) : (
          <div className="empty">Crie um servidor ou entre com um convite.</div>
        )}
        {voice.channelId && (
          <VoiceBar
            voice={voice}
            channelName={voiceChannelName}
            onOpen={() => {
              if (voiceGuild?.is_dm) { setGuildId('@me'); setDmId(voiceGuild.id); } else if (voiceGuild) setGuildId(voiceGuild.id);
              setView('voice');
            }}
          />
        )}
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
          <button className="icon" title="Configurações" onClick={() => setSettingsOpen(true)}><SettingsIcon size={18} /></button>
          <button className="icon" title="Sair da conta" onClick={onLogout}><LogOut size={18} /></button>
        </div>
      </aside>

      <main className="content">
        {view === 'voice' && voice.channelId ? (
          <VoiceView voice={voice} channelName={voiceChannelName} onSettings={() => setSettingsOpen(true)} />
        ) : home && !guild ? (
          <FriendsView state={state} onMessage={openDm} />
        ) : textChannel ? (
          <Chat
            key={textChannel.id}
            channel={textChannel}
            state={state}
            dispatch={dispatch}
            gateway={gateway}
            dm={guild?.is_dm ? dmPeer(guild) : undefined}
            onCall={() => {
              const vc = guild?.channels.find((c) => c.type === 'voice');
              if (vc) openChannel(vc);
            }}
          />
        ) : (
          <div className="empty">Nenhum canal de texto.</div>
        )}
      </main>

      {guild && !home && view === 'text' && <MemberList guild={guild} state={state} />}
      <Toasts />
      <AskHost />
      {settingsOpen && <SettingsView onClose={() => { setSettingsOpen(false); setSounds(soundsEnabled()); }} />}
    </div>
  );
}

// ---------------------------------------------------------------- Amigos e mensagens diretas
function HomeSidebar(props: { dms: Guild[]; state: State; activeId: string | null; onFriends: () => void; onOpen: (id: string) => void }) {
  const { dms, state, activeId, onFriends, onOpen } = props;
  const me = state.user?.id;
  return (
    <div className="channels">
      <header className="guild-header"><span>Mensagens diretas</span></header>
      <button className={`channel ${activeId === null ? 'active' : ''}`} onClick={onFriends}>
        <span className="hash"><Users size={18} /></span> <span className="channel-name">Amigos</span>
      </button>
      <div className="section"><span>Conversas</span></div>
      {dms.length === 0 && <p className="muted small-pad">Abra uma conversa pela lista de amigos.</p>}
      {dms.map((g) => {
        const peer = g.members.find((m) => m.id !== me);
        if (!peer) return null;
        const inCall = Object.entries(state.voice).some(([, ch]) => g.channels.some((c) => c.id === ch));
        return (
          <button key={g.id} className={`channel dm ${activeId === g.id ? 'active' : ''}`} onClick={() => onOpen(g.id)}>
            <Avatar user={peer} size={28} online={!!state.online[peer.id]} />
            <span className="channel-name">{peer.display_name}</span>
            {inCall && <Volume2 size={14} className="ok" />}
          </button>
        );
      })}
    </div>
  );
}

function FriendsView({ state, onMessage }: { state: State; onMessage: (userId: string) => void }) {
  const [tab, setTab] = useState<'online' | 'all' | 'pending' | 'add'>('online');
  const [name, setName] = useState('');
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const rels = Object.values(state.relationships);
  const friends = rels.filter((r) => r.type === 'friend');
  const pending = rels.filter((r) => r.type !== 'friend');
  const list = tab === 'online' ? friends.filter((r) => state.online[r.user.id]) : tab === 'all' ? friends : tab === 'pending' ? pending : [];

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    const username = name.trim();
    if (!username) return;
    try {
      await api('POST', '/relationships', { username });
      setResult({ ok: true, text: `Pedido enviado para ${username}!` });
      setName('');
    } catch (err) {
      setResult({ ok: false, text: (err as Error).message });
    }
  };
  const act = (method: 'PUT' | 'DELETE', id: string) => api(method, `/relationships/${id}`).catch((e) => alert(e.message));

  return (
    <div className="chat friends">
      <header className="topbar">
        <Users size={20} /> Amigos
        <nav className="friend-tabs">
          <button className={tab === 'online' ? 'active' : ''} onClick={() => setTab('online')}>Online</button>
          <button className={tab === 'all' ? 'active' : ''} onClick={() => setTab('all')}>Todos</button>
          <button className={tab === 'pending' ? 'active' : ''} onClick={() => setTab('pending')}>
            Pendentes{pending.some((r) => r.type === 'incoming') && <span className="guild-badge inline">{pending.filter((r) => r.type === 'incoming').length}</span>}
          </button>
          <button className={`add ${tab === 'add' ? 'active' : ''}`} onClick={() => setTab('add')}>Adicionar amigo</button>
        </nav>
      </header>
      <div className="friends-body">
        {tab === 'add' ? (
          <div className="add-friend">
            <h2>Adicionar amigo</h2>
            <p className="muted">Digite o nome de usuário da pessoa (o que aparece com @ embaixo do nome dela).</p>
            <form onSubmit={send} className="add-friend-form">
              <input value={name} onChange={(e) => { setName(e.target.value); setResult(null); }} placeholder="nome de usuário" autoFocus />
              <button className="primary" disabled={!name.trim()}>Enviar pedido</button>
            </form>
            {result && <p className={result.ok ? 'ok' : 'error'}>{result.text}</p>}
            <p className="muted">Seu nome de usuário: <strong>@{state.user?.username}</strong></p>
          </div>
        ) : (
          <>
            <div className="section">
              {tab === 'online' ? 'Online' : tab === 'all' ? 'Todos os amigos' : 'Pendentes'} — {list.length}
            </div>
            {list.length === 0 && (
              <div className="empty friends-empty">
                {tab === 'pending' ? 'Nenhum pedido pendente.' : tab === 'online' ? 'Nenhum amigo online agora.' : 'Você ainda não adicionou ninguém.'}
                <button className="primary" onClick={() => setTab('add')}><UserPlus size={16} /> Adicionar amigo</button>
              </div>
            )}
            {list.map((r) => (
              <div key={r.user.id} className="friend-row" onDoubleClick={() => r.type === 'friend' && onMessage(r.user.id)}>
                <Avatar user={r.user} size={36} online={!!state.online[r.user.id]} />
                <div className="friend-name">
                  <strong>{r.user.display_name}</strong>
                  <small>
                    {r.type === 'incoming' ? 'Pedido de amizade recebido' : r.type === 'outgoing' ? 'Pedido enviado' : state.online[r.user.id] ? 'Online' : 'Offline'}
                    {' · @'}{r.user.username}
                  </small>
                </div>
                <div className="friend-actions">
                  {r.type === 'friend' && <button className="icon round-sm" title="Mensagem" onClick={() => onMessage(r.user.id)}><MessageCircle size={18} /></button>}
                  {r.type === 'incoming' && <button className="icon round-sm ok" title="Aceitar" onClick={() => act('PUT', r.user.id)}><UserCheck size={18} /></button>}
                  <button
                    className="icon round-sm danger"
                    title={r.type === 'friend' ? 'Desfazer amizade' : r.type === 'incoming' ? 'Recusar' : 'Cancelar pedido'}
                    onClick={() => (r.type !== 'friend' || confirm(`Desfazer amizade com ${r.user.display_name}?`)) && act('DELETE', r.user.id)}
                  >
                    <UserX size={18} />
                  </button>
                </div>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Canais
function ChannelList(props: {
  guild: Guild;
  state: State;
  me: User;
  activeId?: string | null;
  onOpen: (c: Channel) => void;
  voiceSpeaking?: Set<string>;
}) {
  const { guild, state, me, activeId, onOpen, voiceSpeaking } = props;
  const isOwner = guild.owner_id === me.id;
  const add = async (type: 'text' | 'voice') => {
    const name = await ask(type === 'text' ? 'Nome do canal de texto' : 'Nome do canal de voz', { okText: 'Criar' });
    if (name) await api('POST', `/guilds/${guild.id}/channels`, { name, type }).catch((e) => alert(e.message));
  };
  const invite = async () => {
    const { code } = await api<{ code: string }>('POST', `/guilds/${guild.id}/invites`, {});
    const link = `${location.origin}/convite/${code}`;
    await navigator.clipboard?.writeText(link).catch(() => {});
    await ask('Convite copiado (válido por 7 dias)', { value: link, readOnly: true });
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
                  <div key={m.id} className={`voice-member ${voiceSpeaking?.has(m.id) ? 'speaking' : ''}`}>
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

/** Botão "adicionar amigo" na lista de membros (some para você mesmo e para quem já é amigo). */
function AddFriend({ user, state }: { user: User; state: State }) {
  if (user.id === state.user?.id) return null;
  const rel = state.relationships[user.id];
  if (rel?.type === 'friend') return null;
  const label = rel?.type === 'outgoing' ? 'Pedido enviado' : rel?.type === 'incoming' ? 'Aceitar pedido de amizade' : 'Adicionar amigo';
  return (
    <button
      className="icon small member-add"
      title={label}
      disabled={rel?.type === 'outgoing'}
      onClick={() =>
        (rel?.type === 'incoming' ? api('PUT', `/relationships/${user.id}`) : api('POST', '/relationships', { username: user.username }))
          .then(() => toast(rel?.type === 'incoming' ? `Agora você e ${user.display_name} são amigos` : `Pedido enviado para ${user.display_name}`, 'join'))
          .catch((e) => alert(e.message))
      }
    >
      {rel?.type === 'incoming' ? <UserCheck size={16} /> : <UserPlus size={16} />}
    </button>
  );
}

function MemberList({ guild, state }: { guild: Guild; state: State }) {
  const online = guild.members.filter((m) => state.online[m.id]);
  const offline = guild.members.filter((m) => !state.online[m.id]);
  return (
    <aside className="members">
      <div className="section">Online — {online.length}</div>
      {online.map((m) => (
        <div key={m.id} className="member"><Avatar user={m} online /> <span className="member-name">{m.display_name}</span><AddFriend user={m} state={state} /></div>
      ))}
      <div className="section">Offline — {offline.length}</div>
      {offline.map((m) => (
        <div key={m.id} className="member offline"><Avatar user={m} /> <span className="member-name">{m.display_name}</span><AddFriend user={m} state={state} /></div>
      ))}
    </aside>
  );
}

// ---------------------------------------------------------------- Chat
function Chat(props: { channel: Channel; state: State; dispatch: (a: any) => void; gateway: Gateway; dm?: User; onCall?: () => void }) {
  const { channel, state, dispatch, gateway, dm, onCall } = props;
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
      {dm ? (
        <header className="topbar">
          <Avatar user={dm} size={24} online={!!state.online[dm.id]} /> {dm.display_name}
          <button className="icon topbar-action" title="Ligar" onClick={onCall}><Phone size={18} /></button>
        </header>
      ) : (
        <header className="topbar"><span className="hash"><Hash size={20} /></span> {channel.name}</header>
      )}
      <div className="messages" ref={listRef} onScroll={onScroll}>
        {!hasMore && (dm ? (
          <div className="channel-start"><Avatar user={dm} size={64} /><h2>{dm.display_name}</h2><p>Este é o começo da sua conversa com @{dm.username}.</p></div>
        ) : (
          <div className="channel-start"><h2>Bem-vindo a #{channel.name}!</h2><p>Este é o começo do canal.</p></div>
        ))}
        {messages?.map((m, i) => {
          const prev = messages[i - 1];
          const grouped = prev && prev.author.id === m.author.id && m.created_at - prev.created_at < 5 * 60_000;
          return <MessageRow key={m.id} msg={m} grouped={!!grouped} mine={m.author.id === state.user?.id} me={state.user!.id} members={state.guilds.find((g) => g.id === channel.guild_id)?.members ?? []} />;
        })}
      </div>
      <form className="composer" onSubmit={send}>
        <input value={text} onChange={(e) => onType(e.target.value)} placeholder={dm ? `Mensagem para @${dm.display_name}` : `Conversar em #${channel.name}`} maxLength={4000} />
      </form>
      <div className="typing">{typingNames.length > 0 && `${typingNames.join(', ')} ${typingNames.length > 1 ? 'estão' : 'está'} digitando…`}</div>
    </div>
  );
}

function MessageRow({ msg, grouped, mine, me, members }: { msg: Message; grouped: boolean; mine: boolean; me: string; members: User[] }) {
  const time = new Date(msg.created_at);
  const [picker, setPicker] = useState(false);
  const react = async (emoji: string) => {
    setPicker(false);
    const on = !msg.reactions?.find((r) => r.emoji === emoji)?.user_ids.includes(me);
    if (on) playSound('reaction');
    await api('PUT', `/messages/${msg.id}/reactions/${encodeURIComponent(emoji)}`, { on }).catch((e) => alert(e.message));
  };
  const names = (ids: string[]) => ids.map((id) => members.find((m) => m.id === id)?.display_name ?? '?').join(', ');
  const edit = async () => {
    const content = await ask('Editar mensagem', { value: msg.content, okText: 'Salvar' });
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
        {!!msg.reactions?.length && (
          <div className="reactions">
            {msg.reactions.map((r) => (
              <button
                key={r.emoji}
                className={`reaction ${r.user_ids.includes(me) ? 'mine' : ''}`}
                title={`Reagiram com ${r.emoji}: ${names(r.user_ids)}`}
                onClick={() => react(r.emoji)}
              >
                <span className="reaction-emoji">{r.emoji}</span> {r.user_ids.length}
              </button>
            ))}
          </div>
        )}
      </div>
      {picker && (
        <div className="emoji-picker" onMouseLeave={() => setPicker(false)}>
          {REACTIONS.map((e) => (
            <button key={e} onClick={() => react(e)}>{e}</button>
          ))}
        </div>
      )}
      <div className="message-actions">
        <button className="icon small" title="Reagir" onClick={() => setPicker((p) => !p)}><SmilePlus size={16} /></button>
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

function VoiceView({ voice, channelName, onSettings }: { voice: Voice; channelName: string; onSettings: () => void }) {
  const settings = useSettings();
  const [shareOpen, setShareOpen] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [stageStats, setStageStats] = useState(false);
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
          {stageStats && <StreamStats track={focused.screen!} />}
          <div className="stage-bar">
            <span className="live">AO VIVO</span> {focused.name}
            <button className="link" onClick={() => setStageStats((v) => !v)}>{stageStats ? 'Esconder estatísticas' : 'Estatísticas'}</button>
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
              {!u.isLocal && (
                <label className="tile-volume" title={`Volume de ${u.name}`}>
                  <Volume2 size={14} />
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={settings.userVolumes[u.identity] ?? 100}
                    onChange={(e) => updateSettings({ userVolumes: { ...settings.userVolumes, [u.identity]: +e.target.value } })}
                  />
                  <small>{settings.userVolumes[u.identity] ?? 100}%</small>
                </label>
              )}
            </div>
          ))}
        </div>
      )}
      <div className="floating-layer" aria-hidden>
        {voice.floating.map((f) => (
          <div key={f.id} className="floating" style={{ left: `${f.left}%` }}>
            <span>{f.emoji}</span>
            {f.name && <small>{f.name}</small>}
          </div>
        ))}
      </div>
      <div className="controls">
        <div className="call-reactions">
          <button className={`round ${emojiOpen ? 'on' : ''}`} title="Reagir na call" onClick={() => setEmojiOpen((o) => !o)}>
            <SmilePlus size={22} />
          </button>
          {emojiOpen && (
            <div className="emoji-picker up">
              {CALL_EMOJIS.map((e) => (
                <button key={e} onClick={() => voice.sendReaction(e)}>{e}</button>
              ))}
            </div>
          )}
        </div>
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
        <button className="round" title="Configurações de voz" onClick={onSettings}><SettingsIcon size={22} /></button>
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
  const [stats, setStats] = useState(false);
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
      {stats && <StreamStats track={user.screen} />}
      <div className="tile-name">
        <span className="live">AO VIVO</span> {user.isLocal ? 'Sua transmissão' : user.name}
        <span className="tile-actions">
          <button className={`icon small ${stats ? 'active' : ''}`} title="Estatísticas da transmissão" onClick={() => setStats((v) => !v)}><Activity size={16} /></button>
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
          <button className={`option ${optimizeFor === 'detail' ? 'selected' : ''}`} onClick={() => setOptimizeFor('detail')}>Equilibrado (recomendado)</button>
          <button className={`option ${optimizeFor === 'motion' ? 'selected' : ''}`} onClick={() => setOptimizeFor('motion')}>Movimento fluido (jogos)</button>
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

function Toasts() {
  const list = useToasts();
  return (
    <div className="toasts">
      {list.map((t) => (
        <div key={t.id} className={`toast ${t.kind ?? ''}`}>{t.text}</div>
      ))}
    </div>
  );
}

/**
 * Números da transmissão em tempo real, para saber por que está travando:
 * quem transmite vê o que o navegador está mandando e o motivo de limitar (CPU ou internet);
 * quem assiste vê o que está chegando, a perda de pacotes e os quadros perdidos.
 */
function StreamStats({ track }: { track: Track }) {
  const [lines, setLines] = useState<{ text: string; warn?: string }>({ text: 'medindo…' });
  useEffect(() => {
    let prev: { t: number; frames: number; lost: number; recv: number; dropped: number; bytes: number } | null = null;
    let prevSent: { t: number; bytes: number } | null = null;
    const mbps = (bytes: number, ms: number) => {
      const bps = (bytes * 8) / (ms / 1000);
      return bps >= 1e6 ? `${(bps / 1e6).toFixed(1)} Mbps` : `${Math.round(bps / 1000)} kbps`;
    };
    const tick = async () => {
      if (track instanceof LocalVideoTrack) {
        const s = (await track.getSenderStats())[0];
        if (!s) return;
        const reason = s.qualityLimitationReason;
        const rate = prevSent && s.timestamp > prevSent.t ? mbps((s.bytesSent ?? 0) - prevSent.bytes, s.timestamp - prevSent.t) : '…';
        prevSent = { t: s.timestamp, bytes: s.bytesSent ?? 0 };
        setLines({
          text: `Enviando ${s.frameWidth}×${s.frameHeight} · ${Math.round(s.framesPerSecond ?? 0)} fps · ${rate}`,
          warn:
            reason === 'cpu' ? 'Limitado pela CPU: feche jogos/abas pesadas ou use 720p'
            : reason === 'bandwidth' && (s.framesPerSecond ?? 0) < 24 ? 'Limitado pela internet de upload: tente 720p ou 1080p 30 fps'
            : reason === 'bandwidth' ? 'Resolução reduzida para caber na internet de upload'
            : undefined,
        });
      } else if (track instanceof RemoteVideoTrack) {
        const s = await track.getReceiverStats();
        if (!s) return;
        const now = s.timestamp;
        const cur = { t: now, frames: s.framesDecoded ?? 0, lost: s.packetsLost ?? 0, recv: s.packetsReceived ?? 0, dropped: s.framesDropped ?? 0, bytes: s.bytesReceived ?? 0 };
        if (prev && now > prev.t) {
          const dt = (now - prev.t) / 1000;
          const fps = Math.round((cur.frames - prev.frames) / dt);
          const lost = cur.lost - prev.lost;
          const total = lost + (cur.recv - prev.recv);
          const lossPct = total > 0 ? (100 * lost) / total : 0;
          setLines({
            text: `Recebendo ${s.frameWidth ?? '?'}×${s.frameHeight ?? '?'} · ${fps} fps · ${mbps(cur.bytes - prev.bytes, now - prev.t)} · perda ${lossPct.toFixed(1)}%`,
            warn:
              lossPct > 3 ? 'Muita perda de pacotes: a internet de alguém está instável (Wi-Fi?)'
              : cur.dropped - prev.dropped > 5 ? 'Seu PC está descartando quadros ao decodificar'
              : undefined,
          });
        }
        prev = cur;
      }
    };
    const id = setInterval(() => void tick().catch(() => {}), 1000);
    void tick().catch(() => {});
    return () => clearInterval(id);
  }, [track]);
  return (
    <div className="stream-stats">
      <div>{lines.text}</div>
      {lines.warn && <div className="warn">{lines.warn}</div>}
    </div>
  );
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
