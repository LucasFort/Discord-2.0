import { useState } from 'react';
import { ask } from './ask';
import { Ban, Check, Copy, Crown, LogOut, MessageCircle, Pencil, Phone, Plus, UserMinus, UserPlus, Users, X } from 'lucide-react';
import { api, dmOther, groupName, isDm, isGroup, type Guild, type Presence, type Relationship, type User } from './api';
import { Avatar, openProfile, ProfileBody } from './profile';
import { isUnread, mentionCount, useUnreadVersion } from './unread';
import { toast } from './toast';
import type { State } from './store';
import { friendSuggestions } from './servers';

/**
 * Amigos e mensagens diretas, como a tela inicial do Discord:
 * - na barra lateral, "Amigos" e a lista de conversas diretas;
 * - no meio, a lista de amigos (Online, Todos, Pendentes) e "Adicionar amigo".
 * Conversa direta = "servidor" escondido (is_dm) com as duas pessoas, então o chat e a chamada são os mesmos dos servidores.
 */

export const dmGuilds = (state: State) =>
  state.guilds
    .filter(isDm)
    .sort((a, b) => lastActivity(b).localeCompare(lastActivity(a)));
const lastActivity = (g: Guild) => g.channels.find((c) => c.type === 'text')?.last_message_id ?? g.id;
export const dmText = (g: Guild) => g.channels.find((c) => c.type === 'text');
export const dmVoice = (g: Guild) => g.channels.find((c) => c.type === 'voice');

/** Abre (ou cria) a conversa direta com alguém e devolve ela. */
export async function openDm(userId: string): Promise<Guild | null> {
  try {
    return await api<Guild>('POST', `/dms/${userId}`);
  } catch (e) {
    toast((e as Error).message, 'error');
    return null;
  }
}

/** Manda pedido de amizade (por id ou nome de usuário). */
export async function addFriend(by: { user_id: string } | { username: string }) {
  const r = await api<{ type: Relationship['type'] }>('POST', '/relationships', by);
  return r.type;
}

/** Bolinha vermelha do botão inicial: pedidos recebidos + mensagens diretas não lidas. */
export function homeBadge(state: State) {
  const pending = Object.values(state.relationships).filter((r) => r.type === 'incoming').length;
  const dms = dmGuilds(state).reduce((n, g) => n + (dmText(g) ? mentionCount(dmText(g)!.id) : 0), 0);
  return pending + dms;
}

// ---------------------------------------------------------------- Barra lateral
export function HomeSidebar({ state, me, activeDm, onFriends, onOpenDm, presenceOf }: {
  state: State;
  me: User;
  activeDm: string | null;
  onFriends: () => void;
  onOpenDm: (guildId: string) => void;
  presenceOf: (id: string) => Presence;
}) {
  useUnreadVersion();
  const pending = Object.values(state.relationships).filter((r) => r.type === 'incoming').length;
  const dms = dmGuilds(state);
  const [groupOpen, setGroupOpen] = useState(false);
  return (
    <div className="channels">
      <header className="guild-header home-header">Conversas</header>
      <button className={`channel ${activeDm ? '' : 'active'}`} onClick={onFriends}>
        <span className="hash"><Users size={18} /></span> <span className="channel-name">Amigos</span>
        {pending > 0 && <span className="count-badge">{pending}</span>}
      </button>
      <div className="section">
        <span>Mensagens diretas</span>
        <button className="icon small" title="Criar grupo" onClick={() => setGroupOpen(true)}><Plus size={16} /></button>
      </div>
      {groupOpen && <GroupPicker state={state} me={me} onClose={() => setGroupOpen(false)} onDone={(g) => (setGroupOpen(false), onOpenDm(g.id))} />}
      {dms.length === 0 && <p className="muted dm-empty">Abra uma conversa pela lista de amigos.</p>}
      {dms.map((g) => {
        const other = dmOther(g, me.id);
        const text = dmText(g);
        const unread = !!text && g.id !== activeDm && isUnread(text.id, text.last_message_id);
        const count = text ? mentionCount(text.id) : 0;
        const inCall = Object.entries(state.voice).some(([uid, ch]) => uid !== me.id && ch === dmVoice(g)?.id);
        if (isGroup(g))
          return (
            <button key={g.id} className={`channel dm-row ${g.id === activeDm ? 'active' : ''} ${unread ? 'unread' : ''}`} onClick={() => onOpenDm(g.id)}>
              <GroupIcon guild={g} size={32} />
              <span className="member-name">
                <span>{groupName(g, me.id)}</span>
                {inCall ? <small className="ok">Na chamada</small> : <small>{g.members.length} {g.members.length === 1 ? 'pessoa' : 'pessoas'}</small>}
              </span>
              {count > 0 && <span className="count-badge">{count > 99 ? '99+' : count}</span>}
            </button>
          );
        return (
          <button key={g.id} className={`channel dm-row ${g.id === activeDm ? 'active' : ''} ${unread ? 'unread' : ''}`} onClick={() => onOpenDm(g.id)}>
            <Avatar user={other} size={32} status={presenceOf(other.id)} />
            <span className="member-name">
              <span>{other.display_name}</span>
              {inCall ? <small className="ok">Na chamada</small> : other.custom_status && <small>{other.custom_status}</small>}
            </span>
            {count > 0 && <span className="count-badge">{count > 99 ? '99+' : count}</span>}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- Lista de amigos
type Tab = 'online' | 'all' | 'pending' | 'blocked' | 'add';

export function FriendsView({ state, presenceOf, onMessage, onCall }: {
  state: State;
  presenceOf: (id: string) => Presence;
  onMessage: (userId: string) => void;
  onCall: (userId: string) => void;
}) {
  const rels = Object.values(state.relationships).sort((a, b) => a.user.display_name.localeCompare(b.user.display_name));
  const friends = rels.filter((r) => r.type === 'friend');
  const pending = rels.filter((r) => r.type === 'incoming' || r.type === 'outgoing');
  const blocked = rels.filter((r) => r.type === 'blocked');
  const incoming = pending.filter((r) => r.type === 'incoming').length;
  const [tab, setTab] = useState<Tab>(friends.length ? 'online' : incoming ? 'pending' : 'add');

  const list = tab === 'online' ? friends.filter((r) => presenceOf(r.user.id) !== 'offline') : tab === 'all' ? friends : tab === 'blocked' ? blocked : pending;
  const title = tab === 'online' ? 'Online' : tab === 'all' ? 'Todos os amigos' : tab === 'blocked' ? 'Bloqueados' : 'Pendentes';

  const remove = async (r: Relationship) => {
    if (r.type === 'friend' && !confirm(`Desfazer a amizade com ${r.user.display_name}?`)) return;
    await api('DELETE', `/relationships/${r.user.id}`).catch((e) => toast(e.message, 'error'));
  };
  const block = async (r: Relationship) => {
    if (!confirm(`Bloquear ${r.user.display_name}? A amizade é desfeita, a pessoa não consegue te mandar mensagem direta nem pedido, e as mensagens dela ficam escondidas para você.`)) return;
    await blockUser(r.user.id);
  };
  const accept = (r: Relationship) => api('PUT', `/relationships/${r.user.id}`).catch((e) => toast(e.message, 'error'));

  return (
    <div className="friends">
      <header className="topbar">
        <span className="hash"><Users size={20} /></span> Amigos
        <nav className="friends-tabs">
          <button className={tab === 'online' ? 'on' : ''} onClick={() => setTab('online')}>Online</button>
          <button className={tab === 'all' ? 'on' : ''} onClick={() => setTab('all')}>Todos</button>
          <button className={tab === 'pending' ? 'on' : ''} onClick={() => setTab('pending')}>
            Pendentes {incoming > 0 && <span className="count-badge">{incoming}</span>}
          </button>
          {blocked.length > 0 && <button className={tab === 'blocked' ? 'on' : ''} onClick={() => setTab('blocked')}>Bloqueados</button>}
          <button className={`add-friend ${tab === 'add' ? 'on' : ''}`} onClick={() => setTab('add')}>Adicionar amigo</button>
        </nav>
      </header>
      {tab === 'add' ? (
        <AddFriend state={state} presenceOf={presenceOf} />
      ) : (
        <div className="friends-list">
          <div className="section">{title} — {list.length}</div>
          {list.length === 0 && (
            <div className="friends-empty muted">
              {tab === 'blocked' ? 'Ninguém bloqueado.' : tab === 'pending' ? 'Nenhum pedido de amizade por aqui.' : tab === 'online' ? 'Nenhum amigo online agora.' : 'Você ainda não tem amigos no Nexo.'}
              {(tab === 'online' || tab === 'all') && <button className="primary" onClick={() => setTab('add')}><UserPlus size={16} /> Adicionar amigo</button>}
            </div>
          )}
          {list.map((r) => {
            const status = presenceOf(r.user.id);
            const sub =
              r.type === 'incoming' ? 'Pedido de amizade recebido'
              : r.type === 'outgoing' ? 'Pedido de amizade enviado'
              : r.type === 'blocked' ? 'Bloqueado'
              : r.user.custom_status || STATUS_TEXT[status];
            return (
              <div key={r.user.id} className="friend-row" onClick={(e) => r.type === 'friend' ? onMessage(r.user.id) : openProfile(r.user, e)}>
                <Avatar user={r.user} size={36} status={r.type === 'friend' ? status : undefined} />
                <div className="member-name">
                  <span><strong>{r.user.display_name}</strong> <span className="muted">@{r.user.username}</span></span>
                  <small>{sub}</small>
                </div>
                <div className="friend-actions" onClick={(e) => e.stopPropagation()}>
                  {r.type === 'friend' && (
                    <>
                      <button className="icon" title="Mensagem" onClick={() => onMessage(r.user.id)}><MessageCircle size={18} /></button>
                      <button className="icon" title="Ligar" onClick={() => onCall(r.user.id)}><Phone size={18} /></button>
                      <button className="icon danger" title="Desfazer amizade" onClick={() => remove(r)}><UserMinus size={18} /></button>
                      <button className="icon danger" title="Bloquear" onClick={() => block(r)}><Ban size={18} /></button>
                    </>
                  )}
                  {r.type === 'blocked' && <button onClick={() => remove(r)}>Desbloquear</button>}
                  {r.type === 'incoming' && (
                    <>
                      <button className="icon accept" title="Aceitar" onClick={() => accept(r)}><Check size={18} /></button>
                      <button className="icon danger" title="Recusar" onClick={() => remove(r)}><X size={18} /></button>
                      <button className="icon danger" title="Bloquear" onClick={() => block(r)}><Ban size={18} /></button>
                    </>
                  )}
                  {r.type === 'outgoing' && (
                    <button className="icon danger" title="Cancelar pedido" onClick={() => remove(r)}><X size={18} /></button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const STATUS_TEXT: Record<Presence, string> = { online: 'Disponível', idle: 'Ausente', dnd: 'Não perturbe', offline: 'Offline' };

function AddFriend({ state, presenceOf }: { state: State; presenceOf: (id: string) => Presence }) {
  const me = state.user!;
  const suggestions = friendSuggestions(state, me.id).slice(0, 12);
  const [asked, setAsked] = useState<Record<string, boolean>>({});
  const [copied, setCopied] = useState(false);
  const [username, setUsername] = useState('');
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = username.trim().replace(/^@/, '');
    if (!name) return;
    setBusy(true);
    try {
      const type = await addFriend({ username: name });
      setResult({ ok: true, text: type === 'friend' ? `Agora você e ${name} são amigos!` : `Pedido de amizade enviado para ${name}.` });
      setUsername('');
    } catch (err) {
      setResult({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="add-friend-form" onSubmit={submit}>
      <h2>Adicionar amigo</h2>
      <p className="muted">Você pode adicionar amigos pelo nome de usuário deles no Nexo.</p>
      <div className={`add-friend-input ${result ? (result.ok ? 'ok' : 'bad') : ''}`}>
        <input
          autoFocus
          placeholder="Digite o nome de usuário (ex.: lucas)"
          value={username}
          maxLength={64}
          onChange={(e) => (setUsername(e.target.value), setResult(null))}
        />
        <button className="primary" disabled={!username.trim() || busy}>Enviar pedido</button>
      </div>
      {result && <p className={result.ok ? 'ok' : 'error'}>{result.text}</p>}
      <div className="share-me">
        <Avatar user={me} size={40} />
        <span className="share-me-text">
          <strong>Seu nome de usuário é @{me.username}</strong>
          <small className="muted">Mande para seus amigos te adicionarem.</small>
        </span>
        <button
          type="button"
          onClick={async () => {
            await navigator.clipboard?.writeText(me.username).catch(() => {});
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? <><Check size={14} /> Copiado</> : <><Copy size={14} /> Copiar</>}
        </button>
      </div>
      {suggestions.length > 0 && (
        <>
          <h3 className="suggest-title">Talvez você conheça</h3>
          <div className="suggest-grid">
            {suggestions.map(({ user, guilds }) => (
              <div key={user.id} className="suggest-card">
                <span className="suggest-avatar" onClick={(e) => openProfile(user, e)}><Avatar user={user} size={56} status={presenceOf(user.id)} /></span>
                <strong>{user.display_name}</strong>
                <small className="muted" title={guilds.join(', ')}>{guilds.length === 1 ? `Em ${guilds[0]}` : `${guilds.length} servidores em comum`}</small>
                <button
                  type="button"
                  className={asked[user.id] ? '' : 'primary'}
                  disabled={asked[user.id]}
                  onClick={() =>
                    addFriend({ user_id: user.id })
                      .then(() => setAsked((a) => ({ ...a, [user.id]: true })))
                      .catch((e) => toast((e as Error).message, 'error'))
                  }
                >
                  {asked[user.id] ? 'Pedido enviado' : <><UserPlus size={14} /> Adicionar</>}
                </button>
              </div>
            ))}
          </div>
        </>
      )}
    </form>
  );
}

// ---------------------------------------------------------------- Perfil ao lado da conversa
export function DmProfilePanel({ user, status, relationship, onAdd }: {
  user: User;
  status: Presence;
  relationship?: Relationship;
  onAdd: () => void;
}) {
  return (
    <aside className="members dm-profile">
      <div className="profile-card static">
        <ProfileBody user={user} status={status} />
        {!relationship && <button className="profile-edit primary" onClick={onAdd}><UserPlus size={14} /> Adicionar amigo</button>}
        {relationship?.type === 'outgoing' && <p className="muted dm-note">Pedido de amizade enviado.</p>}
        {relationship?.type === 'blocked' ? (
          <>
            <p className="muted dm-note">Você bloqueou essa pessoa.</p>
            <button className="profile-edit" onClick={() => api('DELETE', `/relationships/${user.id}`).catch((e) => toast(e.message, 'error'))}>Desbloquear</button>
          </>
        ) : (
          <button
            className="profile-edit danger-text"
            onClick={() => confirm(`Bloquear ${user.display_name}?`) && void blockUser(user.id)}
          >
            <Ban size={14} /> Bloquear
          </button>
        )}
        {relationship?.type === 'incoming' && (
          <button className="profile-edit primary" onClick={() => api('PUT', `/relationships/${user.id}`).catch((e) => toast(e.message, 'error'))}>
            <Check size={14} /> Aceitar pedido de amizade
          </button>
        )}
      </div>
    </aside>
  );
}

/** Bloqueia alguém (desfaz amizade e pedidos). */
export async function blockUser(userId: string) {
  try {
    await api('PUT', `/relationships/${userId}/block`);
    toast('Pessoa bloqueada');
  } catch (e) {
    toast((e as Error).message, 'error');
  }
}

// ---------------------------------------------------------------- Grupos
const GROUP_MAX = 10;

/** Ícone do grupo: a imagem escolhida ou as iniciais de até duas pessoas. */
export function GroupIcon({ guild, size }: { guild: Guild; size: number }) {
  if (guild.icon) return <img className="group-icon" src={guild.icon} width={size} height={size} alt="" />;
  return (
    <span className="group-icon placeholder" style={{ width: size, height: size }}>
      <Users size={Math.round(size * 0.55)} />
    </span>
  );
}

/** Escolher amigos: para criar um grupo novo ou adicionar a um grupo (exclude = quem já está). */
export function GroupPicker({ state, me, group, onClose, onDone }: {
  state: State;
  me: User;
  group?: Guild;
  onClose: () => void;
  onDone: (g: Guild) => void;
}) {
  const [filter, setFilter] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const inGroup = new Set(group?.members.map((m) => m.id) ?? []);
  const room = GROUP_MAX - (group ? group.members.length : 1);
  const friends = Object.values(state.relationships)
    .filter((r) => r.type === 'friend' && !inGroup.has(r.user.id))
    .map((r) => r.user)
    .filter((u) => !filter || `${u.display_name} ${u.username}`.toLowerCase().includes(filter.toLowerCase()))
    .sort((a, b) => a.display_name.localeCompare(b.display_name));
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length >= room ? p : [...p, id]));
  const submit = async () => {
    if (!picked.length) return;
    setBusy(true);
    try {
      if (group) {
        await api('POST', `/groups/${group.id}/members`, { user_ids: picked });
        onDone(group);
      } else if (picked.length === 1) {
        const dm = await openDm(picked[0]);
        if (dm) onDone(dm);
      } else onDone(await api<Guild>('POST', '/groups', { user_ids: picked }));
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal group-picker" onClick={(e) => e.stopPropagation()}>
        <button className="icon modal-x" title="Fechar" onClick={onClose}><X size={20} /></button>
        <h2>{group ? 'Adicionar ao grupo' : 'Criar grupo'}</h2>
        <p className="muted">
          {room > 0 ? `Dá para escolher mais ${room - picked.length} ${room - picked.length === 1 ? 'amigo' : 'amigos'}.` : 'O grupo já está cheio (10 pessoas).'}
        </p>
        <input autoFocus placeholder="Buscar amigos" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <div className="group-picker-list">
          {friends.length === 0 && <p className="muted">{filter ? 'Ninguém com esse nome.' : 'Nenhum amigo para adicionar.'}</p>}
          {friends.map((u) => (
            <label key={u.id} className={`group-pick ${picked.includes(u.id) ? 'on' : ''}`}>
              <Avatar user={u} size={32} />
              <span className="member-name"><span>{u.display_name}</span><small>@{u.username}</small></span>
              <input type="checkbox" checked={picked.includes(u.id)} onChange={() => toggle(u.id)} />
            </label>
          ))}
        </div>
        <div className="modal-actions">
          <button onClick={onClose}>Cancelar</button>
          <button className="primary" disabled={!picked.length || busy} onClick={submit}>
            {group ? 'Adicionar' : picked.length > 1 ? 'Criar grupo' : 'Abrir conversa'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Painel do lado do grupo: quem está, renomear, adicionar, tirar (quem criou) e sair. */
export function GroupPanel({ group, state, me, presenceOf, onLeft }: {
  group: Guild;
  state: State;
  me: User;
  presenceOf: (id: string) => Presence;
  onLeft: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const owner = group.owner_id === me.id;
  const rename = async () => {
    const name = await ask('Nome do grupo (deixe vazio para usar os nomes)', { value: group.name });
    if (name === null) return;
    await api('PATCH', `/groups/${group.id}`, { name }).catch((e) => toast(e.message, 'error'));
  };
  const kick = async (u: User) => {
    if (!confirm(`Tirar ${u.display_name} do grupo?`)) return;
    await api('DELETE', `/groups/${group.id}/members/${u.id}`).catch((e) => toast(e.message, 'error'));
  };
  const leave = async () => {
    if (!confirm('Sair do grupo? Você só volta se alguém te adicionar de novo.')) return;
    try {
      await api('DELETE', `/groups/${group.id}/members/@me`);
      onLeft();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const members = [...group.members].sort((a, b) => a.display_name.localeCompare(b.display_name));
  return (
    <aside className="members group-panel">
      <div className="group-panel-head">
        <GroupIcon guild={group} size={64} />
        <h3>{groupName(group, me.id)}</h3>
        <div className="group-panel-actions">
          <button onClick={rename}><Pencil size={14} /> Renomear</button>
          <button className="primary" onClick={() => setAdding(true)} disabled={group.members.length >= GROUP_MAX}><UserPlus size={14} /> Adicionar</button>
        </div>
      </div>
      <div className="section"><span>Membros — {members.length}</span></div>
      {members.map((u) => (
        <div key={u.id} className="member group-member" onClick={(e) => openProfile(u, e)}>
          <Avatar user={u} size={32} status={presenceOf(u.id)} />
          <span className="member-name">
            <span>{u.display_name} {u.id === group.owner_id && <Crown size={12} className="owner-crown" />}</span>
            {u.custom_status && <small>{u.custom_status}</small>}
          </span>
          {owner && u.id !== me.id && (
            <button className="icon small danger" title="Tirar do grupo" onClick={(e) => (e.stopPropagation(), void kick(u))}><X size={14} /></button>
          )}
        </div>
      ))}
      <button className="group-leave danger-text" onClick={leave}><LogOut size={14} /> Sair do grupo</button>
      {adding && <GroupPicker state={state} me={me} group={group} onClose={() => setAdding(false)} onDone={() => setAdding(false)} />}
    </aside>
  );
}
