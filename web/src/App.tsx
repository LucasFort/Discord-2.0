import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { LocalVideoTrack, RemoteVideoTrack, type Track } from 'livekit-client';
import {
  Activity, Bell, Settings as SettingsIcon, BellOff, Expand, SmilePlus, Hash, Headphones, HeadphoneOff, LogIn, LogOut, Maximize, Mic, MicOff, MonitorUp, MonitorX, Pencil,
  PhoneOff, Plus, Radio, SlidersHorizontal, Trash2, UserPlus, Users, Video, VideoOff, Volume2, VolumeX, X, ArrowRightLeft, ShieldAlert,
  ChevronDown, DoorOpen, Music, MessageCircle, Check, Lock,
} from 'lucide-react';
import { can, canAny, MANAGE_ANY, nameColor, outranks, P } from './permissions';
import { addFriend, DmProfilePanel, dmGuilds, dmText, dmVoice, FriendsView, HomeSidebar, homeBadge, openDm } from './friends';
import { DjTile, MusicMiniPlayer, MusicPanel, OPEN_MUSIC_EVENT } from './music';
import { api, API_MISSING, APP_NAME, dmOther, getToken, isDm, ownsGuild, setToken, type Channel, type Guild, type Message, type User } from './api';
import { playSound, setSoundsEnabled, soundsEnabled } from './sounds';
import { toast, useToasts } from './toast';
import { useUpdateAvailable } from './update';
import { useVoiceShortcuts } from './shortcuts';
import { ask, AskHost } from './ask';
import { SettingsView } from './SettingsView';
import { updateSettings, useSettings, getSettings, type Settings } from './settings';
import { myPresence, useStore, type Gateway, type State, type VoiceFlags } from './store';
import { Avatar, GuildIcon, initials, openProfile, ProfileCard, setProfileOpener, StatusMenu, type ProfileOpen } from './profile';
import { Chat } from './chat';
import { Splash } from './splash';
import { isUnread, mentionCount, useUnreadVersion } from './unread';
import { ServerSettings } from './ServerSettings';
import { CreateServerModal, InviteModal } from './servers';
import { mentionsMe } from './notify';
import type { Presence } from './api';
import {
  CALL_EMOJIS, CODECS, FPS_OPTIONS, RESOLUTIONS, shareBitrate, useVoice,
  type ShareCodec, type ShareFps, type ShareOptions, type ShareResolution, type Voice, type VoiceUser,
} from './voice';

/** O que eu posso fazer com alguém na call: silenciar/ensurdecer e mover/desconectar (só com quem está abaixo de mim). */
export type ModRights = { mute: boolean; move: boolean };
const modRights = (g: Guild | undefined, meId: string, target: string): ModRights => {
  if (!g || isDm(g) || (target !== meId && !outranks(g, meId, target))) return { mute: false, move: false };
  return { mute: can(g, meId, P.MUTE_MEMBERS), move: can(g, meId, P.MOVE_MEMBERS) };
};
/** Canal privado: o @everyone não pode ver. */
const isPrivate = (c: Channel) => !!c.overwrites?.some((o) => o.id === c.guild_id && o.deny & P.VIEW_CHANNEL);

export function App() {
  const [authed, setAuthed] = useState(!!getToken());
  const logout = useCallback(() => {
    setToken(null);
    setAuthed(false);
  }, []);
  return authed ? (
    <Main onLogout={logout} />
  ) : (
    <>
      <Auth onDone={() => setAuthed(true)} />
      <UpdateWatcher />
    </>
  );
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
        <img className="auth-logo" src="/nexo-logo.webp" width={168} height={168} alt={APP_NAME} />
        <h1>{mode === 'login' ? `Bem-vindo de volta ao ${APP_NAME}` : 'Criar uma conta'}</h1>
        <label>
          Usuário
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus required />
        </label>
        <label>
          Senha
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={6} />
        </label>
        {API_MISSING && <p className="error">Servidor do app ainda não conectado: entrar e criar conta ficam indisponíveis por enquanto.</p>}
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
  useVoiceShortcuts({ mute: () => void voice.toggleMute(), deafen: () => voice.toggleDeafen() });

  // Conta para todo mundo em qual canal de voz estamos e se estamos mutados, ensurdecidos,
  // transmitindo ou com câmera (aparece na lista ao lado). Repete quando a conexão volta.
  useEffect(() => {
    if (!state.ready || !voice.channelId) return;
    gateway.send({
      op: 'voice_state',
      channel_id: voice.channelId,
      self_mute: voice.muted || voice.deafened,
      self_deaf: voice.deafened,
      self_stream: voice.sharing,
      self_video: voice.camera,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.connection, state.ready, voice.channelId, voice.muted, voice.deafened, voice.sharing, voice.camera]);
  const [guildId, setGuildId] = useState<string | null>(null);
  const [channelId, setChannelId] = useState<string | null>(null);
  const [view, setView] = useState<'text' | 'voice'>('text');
  const [musicOpen, setMusicOpen] = useState(false);
  // /queue no chat abre a fila da call.
  useEffect(() => {
    const open = () => {
      if (!voice.channelId) return toast('Entre num canal de voz para ver a fila de músicas.', 'error');
      setView('voice');
      setMusicOpen(true);
    };
    window.addEventListener(OPEN_MUSIC_EVENT, open);
    return () => window.removeEventListener(OPEN_MUSIC_EVENT, open);
  }, [voice.channelId]);
  const [sideMenu, setSideMenu] = useState<CallMenuState | null>(null);

  // Silenciado/ensurdecido no servidor: o microfone e o som seguem o que o servidor manda.
  const myFlags = state.user ? state.voiceFlags[state.user.id] : undefined;
  // Sem a permissão "Falar" no canal, o microfone fica travado como no silêncio do servidor.
  const cantSpeak =
    !!voice.channelId && !can(state.guilds.find((g) => g.channels.some((c) => c.id === voice.channelId)), state.user?.id, P.SPEAK, voice.channelId);
  useEffect(() => {
    if (voice.channelId) voice.setServerState(!!myFlags?.server_mute || cantSpeak, !!myFlags?.server_deaf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voice.channelId, myFlags?.server_mute, myFlags?.server_deaf, cantSpeak]);

  // O dono do servidor desconectou ou moveu esta pessoa.
  useEffect(() => {
    const a = state.voiceAction;
    if (!a) return;
    if (a.action === 'disconnect') {
      if (voice.channelId) void voice.leave();
      toast(`${a.by} desconectou você da call`, 'leave');
    } else if (a.action === 'move' && a.channel_id) {
      const ch = state.guilds.flatMap((g) => g.channels).find((c) => c.id === a.channel_id);
      void voice.join(a.channel_id);
      setView('voice');
      toast(`${a.by} moveu você para ${ch?.name ?? 'outro canal'}`, 'join');
    } else if (a.action === 'mute') toast(`${a.by} silenciou você no servidor`);
    else if (a.action === 'deafen') toast(`${a.by} ensurdeceu você no servidor`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.voiceAction?.n]);
  const [sounds, setSounds] = useState(soundsEnabled);
  const [settingsOpen, setSettingsOpen] = useState<false | string>(false); // aba aberta
  const [statusMenu, setStatusMenu] = useState(false);
  const [profile, setProfile] = useState<ProfileOpen | null>(null);
  useUnreadVersion();
  const [serverSettings, setServerSettings] = useState<string | null>(null);
  const settings = useSettings();
  const streamer = streamerOn(settings, voice.sharing);
  useEffect(() => {
    setProfileOpener(setProfile);
    return () => setProfileOpener(null);
  }, []);
  const presenceOf = (id: string): Presence => (id === state.user?.id ? myPresence(state.status) : state.presence[id] ?? 'offline');
  const toggleSounds = () => {
    setSoundsEnabled(!sounds);
    setSounds(!sounds);
    if (!sounds) playSound('join');
  };

  // Atualizou no meio da call: entra de novo no mesmo canal de voz sozinho.
  useEffect(() => {
    if (!state.ready) return;
    const rejoin = sessionStorage.getItem(REJOIN_KEY);
    if (!rejoin) return;
    sessionStorage.removeItem(REJOIN_KEY);
    if (state.guilds.some((g) => g.channels.some((c) => c.id === rejoin))) {
      void voice.join(rejoin);
      setView('voice');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.ready]);

  // Servidores de verdade na barra da esquerda; conversas diretas ficam na tela inicial (Amigos).
  const servers = state.guilds.filter((g) => !isDm(g));
  const selected = state.guilds.find((g) => g.id === guildId);
  const dm = isDm(selected) ? selected : undefined;
  const home = guildId === HOME || !!dm || (!selected && servers.length === 0);
  const guild = home ? dm : selected ?? servers[0];
  const dmUser = dm && state.user ? dmOther(dm, state.user.id) : undefined;
  // Canal de voz apagado ou saí do servidor: sai da call.
  useEffect(() => {
    if (voice.channelId && state.ready && !state.guilds.some((g) => g.channels.some((c) => c.id === voice.channelId))) void voice.leave();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.guilds, voice.channelId]);
  const textChannel = guild?.channels.find((c) => c.id === channelId && c.type === 'text') ?? guild?.channels.find((c) => c.type === 'text');

  // Criar servidor / entrar com convite (tela própria em servers.tsx).
  const [createOpen, setCreateOpen] = useState<null | { start: 'pick' | 'join'; invite?: string }>(null);
  useEffect(() => {
    // Abriu um link /convite/CODIGO: mostra a prévia do servidor antes de entrar.
    const m = location.pathname.match(/^\/convite\/(\w+)/);
    if (m && state.ready) {
      history.replaceState(null, '', '/');
      setCreateOpen({ start: 'join', invite: m[1] });
    }
  }, [state.ready]);
  // Clicou "Entrar"/"Abrir" num cartão de convite do chat.
  useEffect(() => {
    const open = (e: Event) => {
      setGuildId((e as CustomEvent<string>).detail);
      setChannelId(null);
      setView('text');
    };
    window.addEventListener('nexo:open-guild', open);
    return () => window.removeEventListener('nexo:open-guild', open);
  }, []);

  if (!state.ready || !state.user)
    return (
      <Splash status={failures >= 3 ? 'Não foi possível conectar ao servidor. Tentando de novo…' : 'Conectando…'}>
        {failures >= 3 && (
          <>
            <p className="muted">Se o servidor acabou de acordar, pode levar até 1 minuto.</p>
            <button onClick={onLogout}>Sair e entrar de novo</button>
          </>
        )}
      </Splash>
    );

  const openChannel = (c: Channel) => {
    if (c.type === 'voice') {
      const g = state.guilds.find((x) => x.id === c.guild_id);
      if (voice.channelId !== c.id && !can(g, state.user!.id, P.CONNECT, c.id)) return void toast('Você não tem permissão para entrar neste canal de voz', 'error');
      if (voice.channelId !== c.id) voice.join(c.id);
      setView('voice');
    } else {
      setChannelId(c.id);
      setView('text');
    }
  };

  const createGuild = () => setCreateOpen({ start: 'pick' });
  const joinGuild = () => setCreateOpen({ start: 'join' });

  const leaveGuild = async (g: Guild) => {
    if (!confirm(`Sair do servidor ${g.name}? Você só volta com um convite novo.`)) return;
    await api('DELETE', `/guilds/${g.id}/members/@me`).catch((e) => alert(e.message));
  };
  const voiceGuild = state.guilds.find((g) => g.channels.some((c) => c.id === voice.channelId));
  const voiceChannel = voiceGuild?.channels.find((c) => c.id === voice.channelId);
  const voiceName = voiceGuild && isDm(voiceGuild) ? `Chamada com ${dmOther(voiceGuild, state.user.id).display_name}` : voiceChannel?.name ?? 'Voz';

  // Amigos e conversas diretas
  const showDm = (id: string) => {
    setGuildId(id);
    setChannelId(null);
    setView('text');
  };
  const messageUser = async (userId: string) => {
    const g = await openDm(userId);
    if (g) showDm(g.id);
  };
  const callUser = async (userId: string) => {
    const g = await openDm(userId);
    const vc = g && dmVoice(g);
    if (!g || !vc) return;
    setGuildId(g.id);
    openChannel(vc);
  };
  const profileActions = (u: User) => {
    const rel = state.relationships[u.id];
    if (rel?.type === 'friend')
      return <button className="profile-edit primary" onClick={() => (setProfile(null), void messageUser(u.id))}><MessageCircle size={14} /> Mandar mensagem</button>;
    if (rel?.type === 'incoming')
      return <button className="profile-edit primary" onClick={() => api('PUT', `/relationships/${u.id}`).catch((e) => toast(e.message, 'error'))}><Check size={14} /> Aceitar pedido de amizade</button>;
    if (rel?.type === 'outgoing') return <button className="profile-edit" disabled>Pedido de amizade enviado</button>;
    return (
      <button className="profile-edit primary" onClick={() => addFriend({ user_id: u.id }).then(() => toast(`Pedido enviado para ${u.display_name}`)).catch((e) => toast(e.message, 'error'))}>
        <UserPlus size={14} /> Adicionar amigo
      </button>
    );
  };
  const badge = homeBadge(state);
  const unreadDms = dmGuilds(state).filter((g) => g.id !== dm?.id && dmText(g) && mentionCount(dmText(g)!.id) > 0);

  return (
    <div className="app">
      <nav className="guilds">
        <button className={`guild home ${home ? 'active' : ''}`} title="Amigos e mensagens diretas" onClick={() => setGuildId(HOME)}>
          <img className="home-icon" src="/icon-192.png" alt="" />
          {badge > 0 && <span className="count-badge">{badge > 99 ? '99+' : badge}</span>}
        </button>
        {unreadDms.map((g) => {
          const other = dmOther(g, state.user!.id);
          const n = mentionCount(dmText(g)!.id);
          return (
            <button key={g.id} className="guild has-icon dm-bubble" title={other.display_name} onClick={() => showDm(g.id)}>
              <Avatar user={other} size={48} />
              <span className="count-badge">{n > 99 ? '99+' : n}</span>
            </button>
          );
        })}
        {servers.length > 0 && <div className="guild-sep" />}
        {servers.map((g) => {
          const text = g.channels.filter((c) => c.type === 'text');
          const unread = (home || g.id !== guild?.id) && text.some((c) => isUnread(c.id, c.last_message_id));
          const mentions = text.reduce((n, c) => n + mentionCount(c.id), 0);
          return (
            <button key={g.id} className={`guild ${!home && g.id === guild?.id ? 'active' : ''} ${g.icon ? 'has-icon' : ''} ${unread ? 'unread' : ''}`} title={g.name} onClick={() => setGuildId(g.id)}>
              <GuildIcon name={g.name} icon={g.icon} />
              {mentions > 0 && <span className="count-badge">{mentions > 99 ? '99+' : mentions}</span>}
            </button>
          );
        })}
        <div className="guild-sep" />
        <button className="guild add" title="Criar servidor" onClick={createGuild}><Plus size={22} /></button>
        <button className="guild add" title="Entrar com convite" onClick={joinGuild}><LogIn size={20} /></button>
      </nav>

      <aside className="sidebar">
        {home ? (
          <HomeSidebar
            state={state}
            me={state.user}
            activeDm={dm?.id ?? null}
            onFriends={() => (setGuildId(HOME), setView('text'))}
            onOpenDm={showDm}
            presenceOf={presenceOf}
          />
        ) : guild ? (
          <ChannelList
            onLeave={() => leaveGuild(guild)}
            guild={guild}
            state={state}
            me={state.user}
            activeId={view === 'voice' ? voice.channelId : textChannel?.id}
            onOpen={openChannel}
            streamer={streamer}
            onServerSettings={() => setServerSettings(guild.id)}
            presenceOf={presenceOf}
            onMemberMenu={(e, m) => {
              if (m.id === state.user?.id) return;
              e.preventDefault();
              setSideMenu({
                x: e.clientX,
                y: e.clientY,
                kind: 'user',
                user: { identity: m.id, name: m.display_name, isLocal: false, speaking: false, micMuted: false, isSharing: false, watching: false },
              });
            }}
            voiceSpeaking={new Set(voice.users.filter((u) => u.speaking).map((u) => u.identity))}
          />
        ) : (
          <div className="empty">Crie um servidor ou entre com um convite.</div>
        )}
        {voice.channelId && state.music[voice.channelId] && (
          <MusicMiniPlayer
            key={voice.channelId}
            music={state.music[voice.channelId]}
            gateway={gateway}
            deafened={voice.deafened || voice.serverDeafened}
            onOpenQueue={() => (setView('voice'), setMusicOpen(true))}
          />
        )}
        {voice.channelId && <VoiceBar voice={voice} channelName={voiceName} onOpen={() => (voiceGuild && setGuildId(voiceGuild.id), setView('voice'))} />}
        <div className="userbar">
          <button className="userbar-me" title="Mudar status" onClick={() => setStatusMenu((v) => !v)}>
            <Avatar user={state.user} status={myPresence(state.status) === 'offline' ? 'offline' : myPresence(state.status)} />
            <div className="userbar-name">
              <strong>{state.user.display_name}</strong>
              <small>{state.user.custom_status || (streamer && settings.streamerHideNames ? STATUS_TEXT[state.status] : `@${state.user.username}`)}</small>
            </div>
          </button>
          {statusMenu && (
            <StatusMenu user={state.user} status={state.status} onClose={() => setStatusMenu(false)} onEditProfile={() => setSettingsOpen('profile')} />
          )}
          <button className={`icon ${voice.muted || voice.serverMuted ? 'danger' : ''}`} title={voice.serverMuted ? 'Silenciado no servidor' : voice.muted ? 'Ativar microfone' : 'Silenciar'} onClick={voice.toggleMute}>
            {voice.muted || voice.serverMuted ? <MicOff size={18} /> : <Mic size={18} />}
          </button>
          <button className={`icon ${voice.deafened || voice.serverDeafened ? 'danger' : ''}`} title={voice.serverDeafened ? 'Ensurdecido no servidor' : voice.deafened ? 'Ouvir' : 'Ensurdecer'} onClick={voice.toggleDeafen}>
            {voice.deafened || voice.serverDeafened ? <HeadphoneOff size={18} /> : <Headphones size={18} />}
          </button>
          <button className={`icon ${sounds ? '' : 'danger'}`} title={sounds ? 'Desligar sons' : 'Ligar sons'} onClick={toggleSounds}>
            {sounds ? <Bell size={18} /> : <BellOff size={18} />}
          </button>
          <button className="icon" title="Configurações" onClick={() => setSettingsOpen('account')}><SettingsIcon size={18} /></button>
        </div>
      </aside>

      <main className="content">
        {view === 'voice' && voice.channelId ? (
          <VoiceView
            voice={voice}
            channelName={voiceName}
            voiceFlags={state.voiceFlags}
            guild={voiceGuild}
            mod={(id) => modRights(voiceGuild, state.user!.id, id)}
            canStream={can(voiceGuild, state.user.id, P.STREAM, voice.channelId)}
            onSettings={() => setSettingsOpen('voice')}
            music={state.music[voice.channelId]}
            gateway={gateway}
            musicOpen={musicOpen}
            setMusicOpen={setMusicOpen}
          />
        ) : home && !dm ? (
          <FriendsView state={state} presenceOf={presenceOf} onMessage={messageUser} onCall={callUser} />
        ) : guild && textChannel ? (
          <Chat
            key={textChannel.id}
            channel={textChannel}
            guild={guild}
            state={state}
            dispatch={dispatch}
            gateway={gateway}
            onOpenChannel={(id) => (setChannelId(id), setView('text'))}
            dm={dmUser}
            onCall={dm && dmUser ? () => openChannel(dmVoice(dm)!) : undefined}
          />
        ) : (
          <div className="empty">Nenhum canal de texto.</div>
        )}
      </main>

      {view === 'text' && dm && dmUser && (
        <DmProfilePanel
          user={dmUser}
          status={presenceOf(dmUser.id)}
          relationship={state.relationships[dmUser.id]}
          onAdd={() => addFriend({ user_id: dmUser.id }).catch((e) => toast(e.message, 'error'))}
        />
      )}
      {guild && !dm && view === 'text' && <MemberList guild={guild} presenceOf={presenceOf} />}
      {sideMenu && guild && (
        <CallMenu
          menu={sideMenu}
          voice={voice}
          guild={guild}
          mod={(id) => modRights(guild, state.user!.id, id)}
          flags={state.voiceFlags[sideMenu.user.identity]}
          onClose={() => setSideMenu(null)}
          onFullscreen={() => {}}
        />
      )}
      {createOpen && (
        <CreateServerModal
          me={state.user}
          start={createOpen.start}
          initialInvite={createOpen.invite}
          onClose={() => setCreateOpen(null)}
          onDone={(id) => (setCreateOpen(null), setGuildId(id), setChannelId(null), setView('text'))}
        />
      )}
      <Toasts />
      <UpdateWatcher voiceChannelId={voice.channelId} sharing={voice.sharing} />
      <AskHost />
      {settingsOpen && (
        <SettingsView
          tab={settingsOpen}
          user={state.user}
          status={state.status}
          onLogout={onLogout}
          onClose={() => { setSettingsOpen(false); setSounds(soundsEnabled()); }}
        />
      )}
      {profile && (
        <ProfileCard
          user={state.guilds.flatMap((g) => g.members).find((m) => m.id === profile.user.id) ?? state.relationships[profile.user.id]?.user ?? (profile.user.id === state.user.id ? state.user : profile.user)}
          status={presenceOf(profile.user.id)}
          x={profile.x}
          y={profile.y}
          isMe={profile.user.id === state.user.id}
          onEdit={() => (setProfile(null), setSettingsOpen('profile'))}
          actions={profileActions(profile.user)}
          onClose={() => setProfile(null)}
        />
      )}
      {serverSettings && state.guilds.some((g) => g.id === serverSettings) && (
        <ServerSettings
          guild={state.guilds.find((g) => g.id === serverSettings)!}
          me={state.user}
          presenceOf={presenceOf}
          onClose={() => setServerSettings(null)}
        />
      )}
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
  onMemberMenu?: (e: React.MouseEvent, m: User) => void;
  voiceSpeaking?: Set<string>;
  streamer?: boolean;
  onServerSettings?: () => void;
  onLeave?: () => void;
  presenceOf?: (id: string) => Presence;
}) {
  const { guild, state, me, activeId, onOpen, onMemberMenu, voiceSpeaking, streamer, onServerSettings, onLeave } = props;
  const isOwner = ownsGuild(guild, me.id);
  const manageChannels = can(guild, me.id, P.MANAGE_CHANNELS);
  const canInvite = can(guild, me.id, P.CREATE_INVITE);
  const canModerate = can(guild, me.id, P.MUTE_MEMBERS) || can(guild, me.id, P.MOVE_MEMBERS);
  useUnreadVersion();
  const [menu, setMenu] = useState(false);
  const [chMenu, setChMenu] = useState<{ c: Channel; x: number; y: number } | null>(null);
  useEffect(() => {
    if (!menu && !chMenu) return;
    const close = () => (setMenu(false), setChMenu(null));
    const t = setTimeout(() => window.addEventListener('click', close));
    return () => (clearTimeout(t), window.removeEventListener('click', close));
  }, [menu, chMenu]);
  const editChannel = async (c: Channel) => {
    const name = await ask('Nome do canal', { value: c.name, okText: 'Salvar' });
    if (!name || name === c.name) return;
    await api('PATCH', `/channels/${c.id}`, { name }).catch((e) => alert(e.message));
  };
  const editTopic = async (c: Channel) => {
    const topic = await ask('Tópico do canal (aparece no topo do chat)', { value: c.topic ?? '', okText: 'Salvar' });
    if (topic === null) return;
    await api('PATCH', `/channels/${c.id}`, { topic: topic.trim() || null }).catch((e) => alert(e.message));
  };
  const deleteChannel = async (c: Channel) => {
    if (!confirm(`Apagar o canal ${c.name}? As mensagens dele somem para sempre.`)) return;
    await api('DELETE', `/channels/${c.id}`).catch((e) => alert(e.message));
  };
  const add = async (type: 'text' | 'voice') => {
    const name = await ask(type === 'text' ? 'Nome do canal de texto' : 'Nome do canal de voz', { okText: 'Criar' });
    if (name) await api('POST', `/guilds/${guild.id}/channels`, { name, type }).catch((e) => alert(e.message));
  };
  const [inviteOpen, setInviteOpen] = useState(false);
  const invite = () => setInviteOpen(true);
  const section = (type: 'text' | 'voice', title: string) => (
    <>
      <div className="section">
        <span>{title}</span>
        {manageChannels && <button className="icon small" title="Criar canal" onClick={() => add(type)}><Plus size={16} /></button>}
      </div>
      {guild.channels
        .filter((c) => c.type === type)
        .map((c) => (
          <div key={c.id}>
            <button
              className={`channel ${c.id === activeId ? 'active' : ''} ${type === 'text' && c.id !== activeId && isUnread(c.id, c.last_message_id) ? 'unread' : ''}`}
              onClick={() => onOpen(c)}
              onContextMenu={(e) => {
                if (!manageChannels) return;
                e.preventDefault();
                setChMenu({ c, x: e.clientX, y: e.clientY });
              }}
            >
              <span className="hash">{type === 'text' ? <Hash size={18} /> : <Volume2 size={18} />}</span> <span className="channel-name">{c.name}</span>
              {isPrivate(c) && <Lock size={12} className="channel-lock" aria-label="Canal privado" />}
              {type === 'text' && mentionCount(c.id) > 0 && <span className="count-badge">{mentionCount(c.id)}</span>}
            </button>
            {type === 'voice' && state.music[c.id] && (
              // O Nexo DJ aparece na call como um membro (bot), com a música que está tocando.
              <div className="voice-member voice-dj" title={`${state.music[c.id].playing ? 'Tocando' : 'Pausada'}: ${state.music[c.id].queue[0].title}`}>
                <span className="dj-avatar small"><Music size={11} /></span>
                <span className="voice-member-name">Nexo DJ</span>
                <span className="bot-tag">BOT</span>
                <span className="voice-dj-song">{state.music[c.id].playing ? '♪' : '❚❚'} {state.music[c.id].queue[0].title}</span>
              </div>
            )}
            {type === 'voice' &&
              guild.members
                .filter((m) => state.voice[m.id] === c.id)
                .map((m) => {
                  const f = state.voiceFlags[m.id] ?? {};
                  return (
                  <div
                    key={m.id}
                    className={`voice-member ${voiceSpeaking?.has(m.id) ? 'speaking' : ''}`}
                    onContextMenu={(e) => onMemberMenu?.(e, m)}
                    title={m.id === me.id ? undefined : 'Botão direito: volume' + (canModerate ? ' e moderação' : '')}
                  >
                    <Avatar user={m} size={20} /> <span className="voice-member-name" style={{ color: nameColor(guild, m.id) }} onClick={(e) => openProfile(m, e)}>{m.display_name}</span>
                    <span className="voice-member-icons">
                      {f.self_stream && <span className="live small">AO VIVO</span>}
                      {f.self_video && <Video size={14} aria-label="Câmera ligada" />}
                      <VoiceStatus flags={f} />
                    </span>
                  </div>
                  );
                })}
          </div>
        ))}
    </>
  );
  return (
    <div className="channels">
      <header className="guild-header">
        <button className="guild-name" onClick={() => setMenu((v) => !v)}>
          <span>{guild.name}</span> <ChevronDown size={16} />
        </button>
        {canInvite && <button className="icon small" title="Convidar pessoas" onClick={invite}><UserPlus size={18} /></button>}
      </header>
      {menu && (
        <div className="guild-menu" onClick={(e) => e.stopPropagation()}>
          {canInvite && <button onClick={() => (setMenu(false), void invite())}><UserPlus size={16} /> Convidar pessoas</button>}
          {canAny(guild, me.id, MANAGE_ANY) && <button onClick={() => (setMenu(false), onServerSettings?.())}><SettingsIcon size={16} /> Configurações do servidor</button>}
          {manageChannels && <button onClick={() => (setMenu(false), void add('text'))}><Hash size={16} /> Criar canal de texto</button>}
          {manageChannels && <button onClick={() => (setMenu(false), void add('voice'))}><Volume2 size={16} /> Criar canal de voz</button>}
          {!isOwner && <button className="danger-text" onClick={() => (setMenu(false), onLeave?.())}><DoorOpen size={16} /> Sair do servidor</button>}
        </div>
      )}
      {chMenu && (
        <div className="context-menu" style={{ left: chMenu.x, top: chMenu.y }} onClick={(e) => e.stopPropagation()}>
          <button onClick={() => (setChMenu(null), void editChannel(chMenu.c))}><Pencil size={14} /> Renomear canal</button>
          {chMenu.c.type === 'text' && <button onClick={() => (setChMenu(null), void editTopic(chMenu.c))}><Hash size={14} /> Editar tópico</button>}
          <button className="danger-text" onClick={() => (setChMenu(null), void deleteChannel(chMenu.c))}><Trash2 size={14} /> Apagar canal</button>
        </div>
      )}
      {section('text', 'Canais de texto')}
      {section('voice', 'Canais de voz')}
      {inviteOpen && <InviteModal guild={guild} state={state} presenceOf={props.presenceOf ?? (() => 'offline')} onClose={() => setInviteOpen(false)} />}
    </div>
  );
}

function MemberList({ guild, presenceOf }: { guild: Guild; presenceOf: (id: string) => Presence }) {
  const online = guild.members.filter((m) => presenceOf(m.id) !== 'offline');
  const offline = guild.members.filter((m) => presenceOf(m.id) === 'offline');
  // Como no Discord: quem está online aparece no grupo do cargo "separado" mais alto que tem.
  const hoisted = (guild.roles ?? []).filter((r) => r.hoist && r.id !== guild.id);
  const groupOf = (m: User) => hoisted.find((r) => guild.member_roles?.[m.id]?.includes(r.id))?.id;
  const groups = hoisted.map((r) => ({ role: r, list: online.filter((m) => groupOf(m) === r.id) })).filter((g) => g.list.length);
  const rest = online.filter((m) => !groupOf(m));
  const row = (m: User, off?: boolean) => (
    <div key={m.id} className={`member ${off ? 'offline' : ''}`} onClick={(e) => openProfile(m, e)}>
      <Avatar user={m} status={presenceOf(m.id)} />
      <div className="member-name">
        <span style={{ color: nameColor(guild, m.id) }}>{m.display_name}{m.id === guild.owner_id && <span className="crown" title="Dono do servidor"> 👑</span>}</span>
        {m.custom_status && !off && <small>{m.custom_status}</small>}
      </div>
    </div>
  );
  return (
    <aside className="members">
      {groups.map(({ role, list }) => (
        <div key={role.id}>
          <div className="section">{role.name} — {list.length}</div>
          {list.map((m) => row(m))}
        </div>
      ))}
      {rest.length > 0 && <div className="section">Online — {rest.length}</div>}
      {rest.map((m) => row(m))}
      <div className="section">Offline — {offline.length}</div>
      {offline.map((m) => row(m, true))}
    </aside>
  );
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

function VoiceView({ voice, channelName, voiceFlags, guild, mod, canStream, onSettings, music, gateway, musicOpen, setMusicOpen }: {
  voice: Voice;
  channelName: string;
  voiceFlags: State['voiceFlags'];
  guild?: Guild;
  mod: (userId: string) => ModRights;
  canStream: boolean;
  onSettings: () => void;
  music?: State['music'][string];
  gateway: Gateway;
  musicOpen: boolean;
  setMusicOpen: (open: boolean) => void;
}) {
  const [shareOpen, setShareOpen] = useState(false);
  const [peopleOpenRaw, setPeopleOpen] = useState(false);
  // Um painel lateral por vez: abrir a música fecha "Pessoas" e vice-versa.
  const peopleOpen = peopleOpenRaw && !musicOpen;
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [stageStats, setStageStats] = useState(false);
  // Em destaque: 's:<id>' para a transmissão de alguém, 'u:<id>' para a pessoa (câmera ou avatar).
  const [focus, setFocus] = useState<string | null>(null);
  const [menu, setMenu] = useState<CallMenuState | null>(null);
  const openMenu = (e: React.MouseEvent, user: VoiceUser, kind: CallMenuState['kind']) => {
    if (user.isLocal) return;
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, user, kind });
  };
  const streams = voice.users.filter((u) => u.isSharing);
  const tiles: CallTile[] = [
    ...streams.map((u) => ({ key: `s:${u.identity}`, kind: 'stream' as const, user: u })),
    ...voice.users.map((u) => ({ key: `u:${u.identity}`, kind: 'user' as const, user: u })),
  ];
  const focused = tiles.find((t) => t.key === focus);
  // Quem sai da call ou para de transmitir sai do destaque.
  useEffect(() => {
    if (focus && !focused) setFocus(null);
  }, [focus, focused]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !document.fullscreenElement && setFocus(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /** Clique numa transmissão ou pessoa: põe em destaque. Clicar de novo no destaque volta para a grade. */
  const toggleFocus = (key: string) => setFocus((f) => (f === key ? null : key));
  const renderTile = (t: CallTile, mode: 'grid' | 'strip') =>
    t.kind === 'stream' ? (
      <StreamTile
        key={t.key}
        user={t.user}
        voice={voice}
        compact={mode === 'strip'}
        onFocus={() => toggleFocus(t.key)}
        onMenu={(e) => openMenu(e, t.user, 'stream')}
      />
    ) : (
      <UserTile
        key={t.key}
        user={t.user}
        flags={voiceFlags[t.user.identity]}
        deafened={t.user.isLocal ? voice.deafened : undefined}
        compact={mode === 'strip'}
        onFocus={() => toggleFocus(t.key)}
        onMenu={(e) => openMenu(e, t.user, 'user')}
      />
    );

  return (
    <div className={`voice-view ${peopleOpen || musicOpen ? 'with-people' : ''}`}>
      <header className="topbar">
        <span className="hash"><Volume2 size={20} /></span> {channelName}
        {voice.reconnecting && <span className="badge warn">Reconectando…</span>}
        <span className="topbar-end">
          <button className={`icon ${musicOpen ? 'active' : ''} ${music?.playing ? 'music-on' : ''}`} title="Ouvir junto (música do YouTube)" onClick={() => (setMusicOpen(!musicOpen), setPeopleOpen(false))}>
            <Music size={20} />
            {music && <small>{music.queue.length}</small>}
          </button>
          <button className={`icon ${peopleOpen ? 'active' : ''}`} title="Pessoas na call e volumes" onClick={() => (setPeopleOpen(!peopleOpen), setMusicOpen(false))}>
            <Users size={20} /> <small>{voice.users.length}</small>
          </button>
        </span>
      </header>
      {musicOpen && <MusicPanel music={music} gateway={gateway} guild={guild} onClose={() => setMusicOpen(false)} />}
      {peopleOpen && (
        <PeoplePanel voice={voice} voiceFlags={voiceFlags} guild={guild} mod={mod} onClose={() => setPeopleOpen(false)} />
      )}
      {focused ? (
        <div className="focus-layout">
          {focused.kind === 'stream' && focused.user.screen ? (
            <div className="stage" onContextMenu={(e) => openMenu(e, focused.user, 'stream')} onDoubleClick={(e) => (e.currentTarget.querySelector('video') as HTMLVideoElement)?.requestFullscreen()}>
              <VideoTrack track={focused.user.screen} contain />
              {stageStats && <StreamStats track={focused.user.screen} />}
              <div className="stage-bar">
                <span className="live">AO VIVO</span> {focused.user.isLocal ? 'Sua transmissão' : focused.user.name}
                {!focused.user.isLocal && <StreamVolume identity={focused.user.identity} className="stage-volume" />}
                <button className="link" onClick={() => setStageStats((v) => !v)}>{stageStats ? 'Esconder estatísticas' : 'Estatísticas'}</button>
                <button className="icon small" title="Tela cheia" onClick={(e) => (e.currentTarget.closest('.stage')?.querySelector('video') as HTMLVideoElement)?.requestFullscreen()}><Maximize size={16} /></button>
                <button className="link" onClick={() => setFocus(null)}>Voltar para a grade</button>
              </div>
            </div>
          ) : (
            <div className="stage stage-tile">
              {renderTile(focused, 'grid')}
              <div className="stage-bar">
                <button className="link" onClick={() => setFocus(null)}>Voltar para a grade</button>
              </div>
            </div>
          )}
          <div className="strip">
            {tiles.filter((t) => t !== focused).map((t) => renderTile(t, 'strip'))}
            {music && <DjTile music={music} compact onOpen={() => setMusicOpen(true)} />}
          </div>
        </div>
      ) : (
        <div className="grid">
          {tiles.map((t) => renderTile(t, 'grid'))}
          {music && <DjTile music={music} onOpen={() => setMusicOpen(true)} />}
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
        <button className={`round ${voice.muted || voice.serverMuted ? 'off' : ''}`} title={voice.serverMuted ? 'Silenciado no servidor' : voice.muted ? 'Ativar microfone' : 'Silenciar'} onClick={voice.toggleMute}>
          {voice.muted || voice.serverMuted ? <MicOff size={22} /> : <Mic size={22} />}
        </button>
        <button className={`round ${voice.deafened || voice.serverDeafened ? 'off' : ''}`} title={voice.serverDeafened ? 'Ensurdecido no servidor' : voice.deafened ? 'Ouvir' : 'Ensurdecer'} onClick={voice.toggleDeafen}>
          {voice.deafened || voice.serverDeafened ? <HeadphoneOff size={22} /> : <Headphones size={22} />}
        </button>
        <button className={`round ${voice.camera ? 'on' : ''}`} disabled={!canStream && !voice.camera} title={!canStream && !voice.camera ? 'Sem permissão para vídeo neste canal' : voice.camera ? 'Desligar câmera' : 'Ligar câmera'} onClick={voice.toggleCamera}>
          {voice.camera ? <Video size={22} /> : <VideoOff size={22} />}
        </button>
        {voice.sharing ? (
          <>
            <button className="round" title="Qualidade da transmissão" onClick={() => setShareOpen(true)}><SlidersHorizontal size={22} /></button>
            <button className="round on" title="Parar transmissão" onClick={voice.stopShare}><MonitorX size={22} /></button>
          </>
        ) : (
          <button className="round accent" disabled={!canStream} title={canStream ? 'Transmitir tela' : 'Sem permissão para transmitir neste canal'} onClick={() => setShareOpen(true)}><MonitorUp size={22} /></button>
        )}
        <button className="round" title="Configurações de voz" onClick={onSettings}><SettingsIcon size={22} /></button>
        <button className="round danger" title="Desconectar" onClick={voice.leave}><PhoneOff size={22} /></button>
      </div>
      {menu && (
        <CallMenu
          menu={menu}
          voice={voice}
          guild={guild}
          mod={mod}
          flags={voiceFlags[menu.user.identity]}
          onClose={() => setMenu(null)}
          onFullscreen={() => setFocus(`s:${menu.user.identity}`)}
        />
      )}
      {shareOpen && (
        <ShareDialog
          live={voice.sharing}
          onClose={() => setShareOpen(false)}
          onSwitch={async () => {
            setShareOpen(false);
            await voice.switchShare().catch((e) => e?.name !== 'NotAllowedError' && alert(`Falha ao trocar a tela: ${e.message}`));
          }}
          onStart={async (o) => {
            setShareOpen(false);
            if (voice.sharing) return voice.updateShare(o);
            await voice.startShare(o).catch((e) => e?.name !== 'NotAllowedError' && alert(`Falha ao transmitir: ${e.message}`));
          }}
        />
      )}
    </div>
  );
}

type CallTile = { key: string; kind: 'stream' | 'user'; user: VoiceUser };

/** Clique no card põe em destaque, menos quando o clique foi num botão ou controle dentro dele. */
const onTileClick = (fn: () => void) => (e: React.MouseEvent) => {
  if ((e.target as HTMLElement).closest('button, input, label, .tile-volume, .stream-stats')) return;
  fn();
};

function UserTile({ user, flags, deafened, compact, onFocus, onMenu }: {
  user: VoiceUser;
  flags?: VoiceFlags;
  deafened?: boolean;
  compact?: boolean;
  onFocus: () => void;
  onMenu: (e: React.MouseEvent) => void;
}) {
  const settings = useSettings();
  const deaf = deafened ?? !!flags?.self_deaf;
  return (
    <div
      className={`tile ${user.speaking ? 'speaking' : ''} ${compact ? 'compact' : ''}`}
      onClick={onTileClick(onFocus)}
      onContextMenu={onMenu}
      title="Clique para destacar"
    >
      {user.camera ? <VideoTrack track={user.camera} mirror={user.isLocal} /> : <div className="tile-avatar">{initials(user.name)}</div>}
      <div className="tile-name">
        {flags?.server_deaf || flags?.server_mute ? (
          <VoiceStatus flags={flags} />
        ) : deaf ? (
          <HeadphoneOff size={14} className="muted-icon" />
        ) : (
          user.micMuted && <MicOff size={14} className="muted-icon" />
        )}
        <span className="tile-label">{user.name}</span>
        {user.isSharing && <span className="live">AO VIVO</span>}
      </div>
      {!user.isLocal && !compact && (
        <label className="tile-volume" title={`Volume de ${user.name}`}>
          <Volume2 size={14} />
          <input
            type="range"
            min={0}
            max={100}
            value={settings.userVolumes[user.identity] ?? 100}
            onChange={(e) => updateSettings({ userVolumes: { ...settings.userVolumes, [user.identity]: +e.target.value } })}
          />
          <small>{settings.userVolumes[user.identity] ?? 100}%</small>
        </label>
      )}
    </div>
  );
}

function StreamTile({ user, voice, compact, onFocus, onMenu }: {
  user: VoiceUser;
  voice: Voice;
  compact?: boolean;
  onFocus: () => void;
  onMenu: (e: React.MouseEvent) => void;
}) {
  const [stats, setStats] = useState(false);
  if (!user.watching || !user.screen) {
    return (
      <div className={`tile stream ${compact ? 'compact' : ''}`} onContextMenu={onMenu}>
        <div className="stream-cta">
          <span className="live">AO VIVO</span>
          {!compact && <p>{user.name} está transmitindo</p>}
          <button className="primary" onClick={() => (voice.setWatch(user.identity, true), compact && onFocus())}>{compact ? `Assistir ${user.name}` : 'Assistir transmissão'}</button>
        </div>
      </div>
    );
  }
  return (
    <div
      className={`tile stream ${compact ? 'compact' : ''}`}
      onClick={onTileClick(onFocus)}
      onDoubleClick={(e) => (e.currentTarget.querySelector('video') as HTMLVideoElement)?.requestFullscreen()}
      onContextMenu={onMenu}
      title={compact ? 'Clique para destacar' : 'Clique para destacar · botão direito: volume'}
    >
      <VideoTrack track={user.screen} contain />
      {stats && <StreamStats track={user.screen} />}
      <div className="tile-name">
        <span className="live">AO VIVO</span> <span className="tile-label">{user.isLocal ? 'Sua transmissão' : user.name}</span>
        {!compact && (
          <span className="tile-actions">
            <button className={`icon small ${stats ? 'active' : ''}`} title="Estatísticas da transmissão" onClick={() => setStats((v) => !v)}><Activity size={16} /></button>
            <button className="icon small" title="Destacar" onClick={onFocus}><Expand size={16} /></button>
            <button className="icon small" title="Tela cheia" onClick={(e) => (e.currentTarget.closest('.tile')?.querySelector('video') as HTMLVideoElement)?.requestFullscreen()}><Maximize size={16} /></button>
            {!user.isLocal && <button className="icon small" title="Parar de assistir" onClick={() => voice.setWatch(user.identity, false)}><X size={16} /></button>}
          </span>
        )}
      </div>
    </div>
  );
}

type CallMenuState = { x: number; y: number; user: VoiceUser; kind: 'stream' | 'user' };

/** Menu do botão direito numa transmissão ou numa pessoa da call: volume, silenciar, parar de assistir. */
function CallMenu({ menu, voice, guild, mod, flags, onClose, onFullscreen }: {
  menu: CallMenuState;
  voice: Voice;
  guild?: Guild;
  mod?: (userId: string) => ModRights;
  flags?: VoiceFlags;
  onClose: () => void;
  onFullscreen: () => void;
}) {
  const settings = useSettings();
  const ref = useRef<HTMLDivElement>(null);
  const { user, kind } = menu;
  const key = kind === 'stream' ? 'streamVolumes' : 'userVolumes';
  const vol = settings[key][user.identity] ?? 100;
  const set = (v: number) => updateSettings({ [key]: { ...settings[key], [user.identity]: v } });
  // Guarda o volume de antes de silenciar, para o "Ativar som" voltar nele.
  const before = useRef(vol || 100);

  useEffect(() => {
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener('pointerdown', close, true);
    window.addEventListener('keydown', close);
    window.addEventListener('resize', onClose);
    return () => {
      window.removeEventListener('pointerdown', close, true);
      window.removeEventListener('keydown', close);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);

  // Não deixa o menu sair da tela.
  const [pos, setPos] = useState({ left: menu.x, top: menu.y });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ left: Math.max(8, Math.min(menu.x, innerWidth - r.width - 8)), top: Math.max(8, Math.min(menu.y, innerHeight - r.height - 8)) });
  }, [menu.x, menu.y]);

  return (
    <div className="call-menu" ref={ref} style={pos} onContextMenu={(e) => e.preventDefault()}>
      <div className="call-menu-title">{kind === 'stream' ? `Transmissão de ${user.name}` : user.name}</div>
      <label className="call-menu-volume">
        <span>{kind === 'stream' ? 'Volume da transmissão' : 'Volume do usuário'} · {vol}%</span>
        <input
          type="range"
          min={0}
          max={100}
          value={vol}
          autoFocus
          onChange={(e) => {
            const v = +e.target.value;
            if (v > 0) before.current = v;
            set(v);
          }}
        />
      </label>
      <button onClick={() => set(vol === 0 ? before.current : 0)}>
        {vol === 0 ? <Volume2 size={16} /> : <VolumeX size={16} />} {vol === 0 ? 'Ativar som' : kind === 'stream' ? 'Silenciar transmissão' : 'Silenciar usuário'}
      </button>
      {kind === 'stream' && user.watching && (
        <>
          <button onClick={() => (onFullscreen(), onClose())}><Expand size={16} /> Ampliar</button>
          <button onClick={() => (voice.setWatch(user.identity, false), onClose())}><X size={16} /> Parar de assistir</button>
        </>
      )}
      {kind === 'user' && guild && mod && (mod(user.identity).mute || mod(user.identity).move) && (
        <ModActions guild={guild} userId={user.identity} rights={mod(user.identity)} flags={flags} onDone={onClose} />
      )}
    </div>
  );
}

/** Pede ao servidor uma ação de moderação de voz (precisa de "Silenciar membros" ou "Mover membros"). */
function moderate(guildId: string, userId: string, action: 'mute' | 'unmute' | 'deafen' | 'undeafen' | 'disconnect' | 'move', channelId?: string) {
  return api('POST', `/guilds/${guildId}/members/${userId}/voice`, { action, channel_id: channelId }).catch((e) => toast(e.message));
}

/** Moderação no menu do botão direito: silenciar, ensurdecer, mover e desconectar (cada um com a sua permissão). */
function ModActions({ guild, userId, rights, flags, onDone }: { guild: Guild; userId: string; rights: ModRights; flags?: VoiceFlags; onDone: () => void }) {
  const [moveOpen, setMoveOpen] = useState(false);
  const inVoice = !!flags;
  return (
    <>
      <div className="call-menu-sep" />
      <div className="call-menu-title"><ShieldAlert size={12} /> Moderação</div>
      {rights.mute && <>
      <button className={flags?.server_mute ? 'checked' : ''} onClick={() => (moderate(guild.id, userId, flags?.server_mute ? 'unmute' : 'mute'), onDone())}>
        <MicOff size={16} /> {flags?.server_mute ? 'Tirar silêncio do servidor' : 'Silenciar no servidor'}
      </button>
      <button className={flags?.server_deaf ? 'checked' : ''} onClick={() => (moderate(guild.id, userId, flags?.server_deaf ? 'undeafen' : 'deafen'), onDone())}>
        <HeadphoneOff size={16} /> {flags?.server_deaf ? 'Tirar ensurdecer do servidor' : 'Ensurdecer no servidor'}
      </button>
      </>}
      {inVoice && rights.move && (
        <>
          <button onClick={() => setMoveOpen((o) => !o)}><ArrowRightLeft size={16} /> Mover para…</button>
          {moveOpen &&
            guild.channels
              .filter((c) => c.type === 'voice')
              .map((c) => (
                <button key={c.id} className="call-menu-sub" onClick={() => (moderate(guild.id, userId, 'move', c.id), onDone())}>
                  <Volume2 size={14} /> {c.name}
                </button>
              ))}
          <button className="danger" onClick={() => (moderate(guild.id, userId, 'disconnect'), onDone())}><PhoneOff size={16} /> Desconectar</button>
        </>
      )}
    </>
  );
}

/** Ícones de mutado/ensurdecido. Os do servidor (dono silenciou) aparecem em vermelho forte. */
function VoiceStatus({ flags }: { flags: VoiceFlags }) {
  if (flags.server_deaf) return <HeadphoneOff size={14} className="off server" aria-label="Ensurdecido pelo servidor"><title>Ensurdecido no servidor</title></HeadphoneOff>;
  if (flags.self_deaf) return <HeadphoneOff size={14} className="off" aria-label="Ensurdecido" />;
  if (flags.server_mute) return <MicOff size={14} className="off server" aria-label="Silenciado pelo servidor"><title>Silenciado no servidor</title></MicOff>;
  if (flags.self_mute) return <MicOff size={14} className="off" aria-label="Mutado" />;
  return null;
}

/** Painel "Pessoas na call": volume de cada um (voz e transmissão) e, para o dono, a moderação. */
function PeoplePanel({ voice, voiceFlags, guild, mod, onClose }: {
  voice: Voice;
  voiceFlags: State['voiceFlags'];
  guild?: Guild;
  mod: (userId: string) => ModRights;
  onClose: () => void;
}) {
  const settings = useSettings();
  const setVol = (id: string, v: number) => updateSettings({ userVolumes: { ...settings.userVolumes, [id]: v } });
  const others = voice.users.filter((u) => !u.isLocal);
  return (
    <aside className="people-panel">
      <header>
        <strong>Pessoas na call · {voice.users.length}</strong>
        <button className="icon small" title="Fechar" onClick={onClose}><X size={16} /></button>
      </header>
      {others.length > 1 && (
        <div className="people-all">
          <button className="link" onClick={() => updateSettings({ userVolumes: { ...settings.userVolumes, ...Object.fromEntries(others.map((u) => [u.identity, 100])) } })}>
            Voltar todo mundo para 100%
          </button>
        </div>
      )}
      <div className="people-list">
        {voice.users.map((u) => {
          const f = voiceFlags[u.identity] ?? {};
          const vol = settings.userVolumes[u.identity] ?? 100;
          return (
            <div key={u.identity} className={`people-row ${u.speaking ? 'speaking' : ''}`}>
              <div className="people-head">
                <div className="tile-avatar small">{initials(u.name)}</div>
                <span className="people-name">{u.isLocal ? `${u.name} (você)` : u.name}</span>
                <span className="voice-member-icons">
                  {u.isSharing && <span className="live small">AO VIVO</span>}
                  <VoiceStatus flags={u.isLocal ? { ...f, self_mute: voice.muted, self_deaf: voice.deafened } : f} />
                </span>
              </div>
              {!u.isLocal && (
                <>
                  <div className="people-volume">
                    <button className="icon small" title={vol === 0 ? 'Ativar som' : 'Silenciar para mim'} onClick={() => setVol(u.identity, vol === 0 ? 100 : 0)}>
                      {vol === 0 ? <VolumeX size={14} /> : <Volume2 size={14} />}
                    </button>
                    <input type="range" min={0} max={100} value={vol} onChange={(e) => setVol(u.identity, +e.target.value)} aria-label={`Volume de ${u.name}`} />
                    <small>{vol}%</small>
                  </div>
                  {u.isSharing && (
                    <div className="people-stream">
                      <span>Transmissão</span>
                      <StreamVolume identity={u.identity} className="people-volume" />
                    </div>
                  )}
                  {guild && (mod(u.identity).mute || mod(u.identity).move) && (
                    <div className="people-mod">
                      {mod(u.identity).mute && <>
                      <button className={`icon small ${f.server_mute ? 'danger' : ''}`} title={f.server_mute ? 'Tirar silêncio do servidor' : 'Silenciar no servidor'} onClick={() => moderate(guild.id, u.identity, f.server_mute ? 'unmute' : 'mute')}>
                        <MicOff size={14} />
                      </button>
                      <button className={`icon small ${f.server_deaf ? 'danger' : ''}`} title={f.server_deaf ? 'Tirar ensurdecer do servidor' : 'Ensurdecer no servidor'} onClick={() => moderate(guild.id, u.identity, f.server_deaf ? 'undeafen' : 'deafen')}>
                        <HeadphoneOff size={14} />
                      </button>
                      </>}
                      {mod(u.identity).move && <>
                      <select
                        value=""
                        title="Mover para outro canal de voz"
                        onChange={(e) => e.target.value && moderate(guild.id, u.identity, 'move', e.target.value)}
                      >
                        <option value="">Mover para…</option>
                        {guild.channels.filter((c) => c.type === 'voice' && c.id !== voice.channelId).map((c) => (
                          <option key={c.id} value={c.id}>{c.name}</option>
                        ))}
                      </select>
                      <button className="icon small danger" title="Desconectar da call" onClick={() => moderate(guild.id, u.identity, 'disconnect')}>
                        <PhoneOff size={14} />
                      </button>
                      </>}
                    </div>
                  )}
                </>
              )}
            </div>
          );
        })}
      </div>
    </aside>
  );
}

/** Volume só do áudio da transmissão (jogo, vídeo), separado do volume da voz da pessoa. */
function StreamVolume({ identity, className }: { identity: string; className: string }) {
  const settings = useSettings();
  const vol = settings.streamVolumes[identity] ?? 100;
  const set = (v: number) => updateSettings({ streamVolumes: { ...settings.streamVolumes, [identity]: v } });
  return (
    <div className={className} title="Volume da transmissão" onDoubleClick={(e) => e.stopPropagation()}>
      <button type="button" className="icon small" title={vol === 0 ? 'Ativar som da transmissão' : 'Silenciar transmissão'} onClick={() => set(vol === 0 ? 100 : 0)}>
        {vol === 0 ? <VolumeX size={14} /> : <Volume2 size={14} />}
      </button>
      <input type="range" min={0} max={100} value={vol} onChange={(e) => set(+e.target.value)} />
      <small>{vol}%</small>
    </div>
  );
}

/**
 * Janela "Transmitir tela" (como o Go Live do Discord): resolução, fps, otimização, codec e áudio.
 * Abre com a última escolha. Durante a transmissão serve para mudar a qualidade ao vivo.
 */
function ShareDialog({ live, onClose, onStart, onSwitch }: {
  live?: boolean;
  onClose: () => void;
  onStart: (o: ShareOptions) => void;
  onSwitch?: () => void;
}) {
  const s = useSettings();
  const [resolution, setResolution] = useState<ShareResolution>(s.streamResolution);
  const [fps, setFps] = useState<ShareFps>(s.streamFps);
  const [optimizeFor, setOptimizeFor] = useState<'detail' | 'motion'>(s.streamOptimize);
  const [codec, setCodec] = useState<ShareCodec>(s.streamCodec);
  const [audio, setAudio] = useState(s.streamAudio);
  const mbps = (shareBitrate(resolution, fps) / 1_000_000).toFixed(1);
  const go = () => {
    updateSettings({ streamResolution: resolution, streamFps: fps, streamOptimize: optimizeFor, streamCodec: codec, streamAudio: audio });
    onStart({ resolution, fps, optimizeFor, codec, audio });
  };
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{live ? 'Qualidade da transmissão' : 'Transmitir tela'}</h2>
        <p className="muted">
          {live
            ? 'Muda na hora, sem parar a transmissão.'
            : 'Depois de confirmar, o navegador pergunta se você quer mostrar a tela inteira, uma janela ou uma aba.'}
        </p>
        <h3>Resolução</h3>
        <div className="options">
          {(Object.keys(RESOLUTIONS) as ShareResolution[]).map((r) => (
            <button key={r} className={`option ${r === resolution ? 'selected' : ''}`} onClick={() => setResolution(r)}>{RESOLUTIONS[r].label}</button>
          ))}
        </div>
        <h3>Taxa de quadros</h3>
        <div className="options">
          {FPS_OPTIONS.map((f) => (
            <button key={f} className={`option ${f === fps ? 'selected' : ''}`} onClick={() => setFps(f)}>{f} fps</button>
          ))}
        </div>
        <small className="muted">Usa até {mbps} Mbps de upload.</small>
        <h3>Otimizar para</h3>
        <div className="options">
          <button className={`option ${optimizeFor === 'motion' ? 'selected' : ''}`} onClick={() => setOptimizeFor('motion')}>Movimento fluido (jogos e vídeo)</button>
          <button className={`option ${optimizeFor === 'detail' ? 'selected' : ''}`} onClick={() => setOptimizeFor('detail')}>Texto nítido (código, documentos)</button>
        </div>
        {!live && (
          <>
            <h3>Codec de vídeo</h3>
            <div className="options">
              {(Object.keys(CODECS) as ShareCodec[]).map((c) => (
                <button key={c} className={`option ${c === codec ? 'selected' : ''}`} title={CODECS[c].hint} onClick={() => setCodec(c)}>{CODECS[c].label}</button>
              ))}
            </div>
            <small className="muted">{CODECS[codec].hint}</small>
            <label className="check">
              <input type="checkbox" checked={audio} onChange={(e) => setAudio(e.target.checked)} /> Transmitir o áudio também
            </label>
          </>
        )}
        <div className="modal-actions">
          {live && onSwitch && <button onClick={onSwitch}>Trocar tela ou janela</button>}
          <button className="link" onClick={onClose}>Cancelar</button>
          <button className="primary" onClick={go}>{live ? 'Aplicar' : 'Ao vivo'}</button>
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

const REJOIN_KEY = 'nexo.rejoinVoice';
/** guildId especial da tela inicial (Amigos e mensagens diretas). */
const HOME = '@home';

/**
 * Quando sai versão nova, recarrega o app sozinho. Fora da call: em 5 segundos (espera se você
 * estiver digitando). Na call: em 10 segundos e já volta para o mesmo canal de voz. Transmitindo:
 * só avisa, para não derrubar a transmissão, e atualiza quando ela acabar.
 */
function UpdateWatcher({ voiceChannelId = null, sharing = false }: { voiceChannelId?: string | null; sharing?: boolean }) {
  const available = useUpdateAvailable();
  const [left, setLeft] = useState<number | null>(null);
  const reload = useCallback(() => {
    try {
      if (voiceChannelId) sessionStorage.setItem(REJOIN_KEY, voiceChannelId);
    } catch {
      /* ignora */
    }
    location.reload();
  }, [voiceChannelId]);

  useEffect(() => {
    if (!available || sharing) return setLeft(null);
    let n = voiceChannelId ? 10 : 5;
    setLeft(n);
    const t = setInterval(() => {
      // Não atualiza no meio de uma mensagem sendo escrita.
      const el = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
      const typing = !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && el.type !== 'range' && !!el.value;
      if (typing) return;
      n -= 1;
      setLeft(n);
      if (n <= 0) {
        clearInterval(t);
        reload();
      }
    }, 1000);
    return () => clearInterval(t);
  }, [available, sharing, voiceChannelId, reload]);

  if (!available) return null;
  return (
    <div className="update-bar">
      <strong>Nova versão do Nexo.</strong>{' '}
      {sharing
        ? 'Atualiza quando você parar de transmitir.'
        : voiceChannelId
          ? `Atualizando em ${left ?? 0}s, você volta para a call sozinho.`
          : `Atualizando em ${left ?? 0}s…`}
      <button className="primary" onClick={reload}>Atualizar agora</button>
    </div>
  );
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
        // Com camadas (simulcast) vem uma estatística por camada: mostra a maior e soma o envio.
        const all = await track.getSenderStats();
        const s = all.reduce<(typeof all)[number] | undefined>((a, b) => (!a || (b.frameWidth ?? 0) > (a.frameWidth ?? 0) ? b : a), undefined);
        if (!s) return;
        const bytes = all.reduce((n, x) => n + (x.bytesSent ?? 0), 0);
        const reason = s.qualityLimitationReason;
        const rate = prevSent && s.timestamp > prevSent.t ? mbps(bytes - prevSent.bytes, s.timestamp - prevSent.t) : '…';
        prevSent = { t: s.timestamp, bytes };
        const lowSent = all.length > 1 && all.some((x) => x !== s && (x.framesPerSecond ?? 0) > 0);
        setLines({
          text: `Enviando ${s.frameWidth}×${s.frameHeight} · ${Math.round(s.framesPerSecond ?? 0)} fps · ${rate}${lowSent ? ' · + versão 720p' : ''}`,
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
const STATUS_TEXT = { online: 'Disponível', idle: 'Ausente', dnd: 'Não perturbe', invisible: 'Invisível' } as const;
/** Modo streamer ligado agora (sempre, ou sozinho enquanto transmite a tela). */
export const streamerOn = (s: Settings, sharing: boolean) => s.streamerMode || (s.streamerAuto && sharing);
