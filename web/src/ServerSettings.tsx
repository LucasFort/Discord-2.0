import { useEffect, useState } from 'react';
import { ChevronDown, ChevronUp, Hash, LayoutGrid, Link2, Lock, Plus, Shield, Trash2, Users, Volume2, X } from 'lucide-react';
import { api, ownsGuild, type Channel, type Guild, type Presence, type User } from './api';
import { can, CHANNEL_PERM_LIST, outranks, P, PERM_INFO, permsOf, rolesOf, topOf, type Role } from './permissions';
import { Toggle } from './UserSettings';
import { ask } from './ask';
import { Avatar, GuildIcon, pickImage } from './profile';
import { getSettings } from './settings';

type Tab = 'overview' | 'roles' | 'channels' | 'members' | 'invites' | 'delete';

/** Configurações do servidor: cada aba aparece para quem tem a permissão dela (o dono vê todas). */
export function ServerSettings({ guild, me, presenceOf, onClose }: { guild: Guild; me: User; presenceOf: (id: string) => Presence; onClose: () => void }) {
  const has = (perm: number) => can(guild, me.id, perm);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const all: [Tab, string, JSX.Element, boolean][] = [
    ['overview', 'Visão geral', <LayoutGrid size={16} />, has(P.MANAGE_GUILD)],
    ['roles', 'Cargos', <Shield size={16} />, has(P.MANAGE_ROLES)],
    ['channels', 'Canais', <Hash size={16} />, has(P.MANAGE_CHANNELS)],
    ['members', 'Membros', <Users size={16} />, has(P.KICK_MEMBERS) || has(P.MANAGE_ROLES)],
    ['invites', 'Convites', <Link2 size={16} />, has(P.CREATE_INVITE)],
  ];
  const tabs = all.filter((t) => t[3]);
  const isOwner = ownsGuild(guild, me.id);
  const [chosen, setTab] = useState<Tab>(tabs[0]?.[0] ?? 'delete');
  // Perdeu a permissão com a janela aberta: cai na primeira aba que ainda pode ver.
  const tab = chosen === 'delete' ? (isOwner ? 'delete' : tabs[0]?.[0]) : tabs.some((t) => t[0] === chosen) ? chosen : tabs[0]?.[0];
  return (
    <div className="settings">
      <nav className="settings-nav">
        <div className="settings-group">
          <h3>{guild.name}</h3>
          {tabs.map(([t, label, icon]) => (
            <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>{icon} {label}</button>
          ))}
        </div>
        {isOwner && (
          <div className="settings-group">
            <button className={`danger-text ${tab === 'delete' ? 'active' : ''}`} onClick={() => setTab('delete')}><Trash2 size={16} /> Apagar servidor</button>
          </div>
        )}
      </nav>
      <section className="settings-body">
        {tab === 'overview' && <Overview key={guild.id} guild={guild} />}
        {tab === 'roles' && <Roles guild={guild} me={me} />}
        {tab === 'channels' && <Channels guild={guild} me={me} />}
        {tab === 'members' && <Members guild={guild} me={me} presenceOf={presenceOf} />}
        {tab === 'invites' && <Invites guild={guild} />}
        {!tab && <p className="muted">Você não tem mais permissão para mexer neste servidor.</p>}
        {tab === 'delete' && <DeleteGuild guild={guild} onDone={onClose} />}
      </section>
      <button className="settings-close" title="Fechar (Esc)" onClick={onClose}><X size={20} /><small>ESC</small></button>
    </div>
  );
}

function Overview({ guild }: { guild: Guild }) {
  const [name, setName] = useState(guild.name);
  const [icon, setIcon] = useState(guild.icon ?? null);
  const [msg, setMsg] = useState('');
  const changed = name.trim() !== guild.name || icon !== (guild.icon ?? null);
  const save = async () => {
    try {
      await api('PATCH', `/guilds/${guild.id}`, { name: name.trim(), icon });
      setMsg('Salvo.');
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  return (
    <>
      <h2>Visão geral do servidor</h2>
      <div className="server-overview">
        <div className="server-icon-edit">
          <span className="guild big"><GuildIcon name={name || guild.name} icon={icon} /></span>
          <button onClick={async () => { const img = await pickImage(128).catch(() => null); if (img) setIcon(img); }}>Trocar ícone</button>
          {icon && <button className="link" onClick={() => setIcon(null)}>Tirar ícone</button>}
        </div>
        <label className="field">
          <span>Nome do servidor</span>
          <input value={name} maxLength={64} onChange={(e) => (setName(e.target.value), setMsg(''))} />
        </label>
      </div>
      {(changed || msg) && (
        <div className="save-bar">
          <span>{msg || 'Você tem alterações que não foram salvas.'}</span>
          {changed && (
            <>
              <button className="link" onClick={() => (setName(guild.name), setIcon(guild.icon ?? null))}>Redefinir</button>
              <button className="primary" disabled={!name.trim()} onClick={save}>Salvar alterações</button>
            </>
          )}
        </div>
      )}
    </>
  );
}

function Channels({ guild, me }: { guild: Guild; me: User }) {
  const [permsOpen, setPermsOpen] = useState<string | null>(null);
  const create = async (type: 'text' | 'voice') => {
    const name = await ask(type === 'text' ? 'Nome do canal de texto' : 'Nome do canal de voz', { okText: 'Criar' });
    if (name) await api('POST', `/guilds/${guild.id}/channels`, { name, type }).catch((e) => alert(e.message));
  };
  const rename = async (c: Channel) => {
    const name = await ask('Nome do canal', { value: c.name, okText: 'Salvar' });
    if (name && name !== c.name) await api('PATCH', `/channels/${c.id}`, { name }).catch((e) => alert(e.message));
  };
  const topic = async (c: Channel) => {
    const t = await ask('Tópico do canal (aparece no topo do chat)', { value: c.topic ?? '', okText: 'Salvar' });
    if (t !== null) await api('PATCH', `/channels/${c.id}`, { topic: t.trim() || null }).catch((e) => alert(e.message));
  };
  const remove = async (c: Channel) => {
    if (confirm(`Apagar o canal ${c.name}? As mensagens dele somem para sempre.`)) await api('DELETE', `/channels/${c.id}`).catch((e) => alert(e.message));
  };
  const list = (type: 'text' | 'voice') => guild.channels.filter((c) => c.type === type);
  return (
    <>
      <h2>Canais</h2>
      {(['text', 'voice'] as const).map((type) => (
        <div key={type}>
          <h3>{type === 'text' ? 'Canais de texto' : 'Canais de voz'}</h3>
          {list(type).map((c) => (
            <div key={c.id}>
              <div className="admin-row">
                {type === 'text' ? <Hash size={16} /> : <Volume2 size={16} />}
                <div className="admin-row-main">
                  <strong>{c.name} {isPrivate(c) && <Lock size={12} className="channel-lock" aria-label="Canal privado" />}</strong>
                  {c.topic && <small className="muted">{c.topic}</small>}
                </div>
                <button className={permsOpen === c.id ? 'primary' : ''} onClick={() => setPermsOpen(permsOpen === c.id ? null : c.id)}>Permissões</button>
                <button onClick={() => rename(c)}>Renomear</button>
                {type === 'text' && <button onClick={() => topic(c)}>Tópico</button>}
                <button className="icon danger" title="Apagar canal" onClick={() => remove(c)}><Trash2 size={16} /></button>
              </div>
              {permsOpen === c.id && <ChannelPerms guild={guild} channel={c} me={me} />}
            </div>
          ))}
          <button className="link" onClick={() => create(type)}>+ Criar canal {type === 'text' ? 'de texto' : 'de voz'}</button>
        </div>
      ))}
    </>
  );
}

function Members({ guild, me, presenceOf }: { guild: Guild; me: User; presenceOf: (id: string) => Presence }) {
  const [q, setQ] = useState('');
  const canKick = can(guild, me.id, P.KICK_MEMBERS);
  const canRoles = can(guild, me.id, P.MANAGE_ROLES);
  const myTop = topOf(guild, me.id);
  // Cargos que eu posso dar: os abaixo do meu cargo mais alto (sem o @everyone).
  const assignable = (guild.roles ?? []).filter((r) => r.id !== guild.id && r.position < myTop);
  const setRole = (m: User, r: Role, on: boolean) =>
    api(on ? 'PUT' : 'DELETE', `/guilds/${guild.id}/members/${m.id}/roles/${r.id}`).catch((e) => alert(e.message));
  const kick = async (m: User) => {
    if (!confirm(`Expulsar ${m.display_name}? A pessoa só volta com um convite novo.`)) return;
    await api('DELETE', `/guilds/${guild.id}/members/${m.id}`).catch((e) => alert(e.message));
  };
  const shown = guild.members.filter((m) => !q || `${m.display_name} ${m.username}`.toLowerCase().includes(q.toLowerCase()));
  const hideNames = getSettings().streamerMode && getSettings().streamerHideNames;
  return (
    <>
      <h2>Membros · {guild.members.length}</h2>
      <input placeholder="Procurar membro" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="admin-list">
        {shown.map((m) => (
          <div key={m.id} className="admin-row">
            <Avatar user={m} size={32} status={presenceOf(m.id)} />
            <div className="admin-row-main">
              <strong>{m.display_name}{m.id === guild.owner_id && ' 👑'}</strong>
              {!hideNames && <small className="muted">@{m.username}</small>}
              <div className="role-chips">
                {rolesOf(guild, m.id).map((r) => (
                  <span key={r.id} className="role-chip">
                    <i className="role-dot" style={{ background: r.color ?? 'var(--text-muted)' }} />
                    {r.name}
                    {canRoles && r.position < myTop && <button className="icon tiny" title={`Tirar ${r.name}`} onClick={() => setRole(m, r, false)}><X size={10} /></button>}
                  </span>
                ))}
                {canRoles && assignable.some((r) => !guild.member_roles?.[m.id]?.includes(r.id)) && (
                  <select className="role-add" value="" title="Dar cargo" onChange={(e) => {
                    const r = assignable.find((x) => x.id === e.target.value);
                    if (r) void setRole(m, r, true);
                  }}>
                    <option value="">+ Cargo</option>
                    {assignable.filter((r) => !guild.member_roles?.[m.id]?.includes(r.id)).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                  </select>
                )}
              </div>
            </div>
            {canKick && m.id !== me.id && outranks(guild, me.id, m.id) && <button className="danger" onClick={() => kick(m)}>Expulsar</button>}
          </div>
        ))}
      </div>
    </>
  );
}

const EXPIRY: [number | null, string][] = [[0.5, '30 minutos'], [1, '1 hora'], [6, '6 horas'], [12, '12 horas'], [24, '1 dia'], [168, '7 dias'], [null, 'Nunca']];
const USES: [number | null, string][] = [[null, 'Sem limite'], [1, '1 uso'], [5, '5 usos'], [10, '10 usos'], [25, '25 usos'], [100, '100 usos']];

function Invites({ guild }: { guild: Guild }) {
  const [hours, setHours] = useState<number | null>(168);
  const [uses, setUses] = useState<number | null>(null);
  const [link, setLink] = useState('');
  const create = async () => {
    const { code } = await api<{ code: string }>('POST', `/guilds/${guild.id}/invites`, {
      max_uses: uses,
      // "Nunca": 10 anos (o servidor sempre põe uma validade).
      expires_in_hours: hours ?? 24 * 365 * 10,
    });
    const url = `${location.origin}/convite/${code}`;
    await navigator.clipboard?.writeText(url).catch(() => {});
    setLink(url);
  };
  const hide = getSettings().streamerMode && getSettings().streamerHideInvites;
  return (
    <>
      <h2>Convites</h2>
      <label className="field">
        <span>Expira depois de</span>
        <select value={String(hours)} onChange={(e) => setHours(e.target.value === 'null' ? null : +e.target.value)}>
          {EXPIRY.map(([v, l]) => <option key={l} value={String(v)}>{l}</option>)}
        </select>
      </label>
      <label className="field">
        <span>Número máximo de usos</span>
        <select value={String(uses)} onChange={(e) => setUses(e.target.value === 'null' ? null : +e.target.value)}>
          {USES.map(([v, l]) => <option key={l} value={String(v)}>{l}</option>)}
        </select>
      </label>
      <button className="primary" onClick={create}>Gerar link de convite</button>
      {link && (
        <p className="ok-text">
          Link copiado. {hide ? '(escondido no modo streamer)' : <code className="invite-link">{link}</code>}
        </p>
      )}
    </>
  );
}

function DeleteGuild({ guild, onDone }: { guild: Guild; onDone: () => void }) {
  const [typed, setTyped] = useState('');
  const remove = async () => {
    await api('DELETE', `/guilds/${guild.id}`).then(onDone).catch((e) => alert(e.message));
  };
  return (
    <>
      <h2>Apagar "{guild.name}"</h2>
      <p className="warn-box">Isso apaga o servidor para todo mundo, com todos os canais e mensagens. Não dá para desfazer.</p>
      <label className="field">
        <span>Digite o nome do servidor para confirmar</span>
        <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={guild.name} />
      </label>
      <button className="danger" disabled={typed.trim() !== guild.name} onClick={remove}>Apagar servidor</button>
    </>
  );
}

/** Canal privado: o @everyone não pode ver. */
const isPrivate = (c: Channel) => !!c.overwrites?.some((o) => o.id === c.guild_id && o.deny & P.VIEW_CHANNEL);

const ROLE_COLORS = ['#1abc9c', '#2ecc71', '#3498db', '#9b59b6', '#e91e63', '#f1c40f', '#e67e22', '#e74c3c', '#95a5a6', '#607d8b', '#7c5cff', '#2dd4a4'];

/** Aba "Cargos": lista do mais alto para o mais baixo, criar, reordenar e editar nome, cor e permissões. */
function Roles({ guild, me }: { guild: Guild; me: User }) {
  const roles = guild.roles ?? [];
  const [sel, setSel] = useState<string>(roles.find((r) => r.id !== guild.id)?.id ?? guild.id);
  const role = roles.find((r) => r.id === sel) ?? roles.find((r) => r.id === guild.id);
  const myTop = topOf(guild, me.id);
  const others = roles.filter((r) => r.id !== guild.id); // já vêm do mais alto para o mais baixo
  const count = (id: string) => Object.values(guild.member_roles ?? {}).filter((list) => list.includes(id)).length;
  const create = async () => {
    const r = await api<Role>('POST', `/guilds/${guild.id}/roles`, { name: 'novo cargo' }).catch((e) => (alert(e.message), null));
    if (r) setSel(r.id);
  };
  const move = async (id: string, dir: -1 | 1) => {
    const ids = others.map((r) => r.id);
    const i = ids.indexOf(id);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    await api('PUT', `/guilds/${guild.id}/roles/order`, { ids }).catch((e) => alert(e.message));
  };
  return (
    <>
      <h2>Cargos</h2>
      <p className="muted">Cargos dão permissões e cor no nome. Quem tem um cargo mais alto manda em quem está abaixo. O @everyone vale para todo mundo do servidor.</p>
      <div className="roles-layout">
        <div className="role-list">
          <button className="primary" onClick={create}><Plus size={14} /> Criar cargo</button>
          {[...others, ...roles.filter((r) => r.id === guild.id)].map((r, i) => {
            const editable = r.position < myTop;
            const everyone = r.id === guild.id;
            return (
              <div key={r.id} className={`role-item ${r.id === role?.id ? 'active' : ''}`} onClick={() => setSel(r.id)}>
                <i className="role-dot" style={{ background: r.color ?? 'var(--text-muted)' }} />
                <span className="role-item-name">{r.name}</span>
                {!everyone && <small className="muted">{count(r.id)}</small>}
                {!everyone && editable && (
                  <span className="role-move">
                    <button className="icon tiny" title="Subir" disabled={i === 0 || others[i - 1].position >= myTop} onClick={(e) => (e.stopPropagation(), void move(r.id, -1))}><ChevronUp size={12} /></button>
                    <button className="icon tiny" title="Descer" disabled={i === others.length - 1} onClick={(e) => (e.stopPropagation(), void move(r.id, 1))}><ChevronDown size={12} /></button>
                  </span>
                )}
                {!editable && <Lock size={12} className="muted" aria-label="Acima do seu cargo" />}
              </div>
            );
          })}
        </div>
        {role && <RoleEditor key={role.id + role.permissions + role.name + role.color + role.hoist} guild={guild} role={role} me={me} editable={role.position < myTop} />}
      </div>
    </>
  );
}

function RoleEditor({ guild, role, me, editable }: { guild: Guild; role: Role; me: User; editable: boolean }) {
  const everyone = role.id === guild.id;
  const [name, setName] = useState(role.name);
  const [color, setColor] = useState<string | null>(role.color);
  const [hoist, setHoist] = useState(!!role.hoist);
  const [perms, setPerms] = useState(role.permissions);
  const [msg, setMsg] = useState('');
  const mine = permsOf(guild, me.id);
  const changed = name.trim() !== role.name || color !== role.color || hoist !== !!role.hoist || perms !== role.permissions;
  const save = async () => {
    const body: Record<string, unknown> = { permissions: perms };
    if (!everyone) Object.assign(body, { name: name.trim(), color, hoist });
    await api('PATCH', `/guilds/${guild.id}/roles/${role.id}`, body).then(() => setMsg('Salvo.')).catch((e) => setMsg(e.message));
  };
  const remove = async () => {
    if (confirm(`Apagar o cargo ${role.name}? Quem tem esse cargo perde as permissões dele.`))
      await api('DELETE', `/guilds/${guild.id}/roles/${role.id}`).catch((e) => alert(e.message));
  };
  const reset = () => (setName(role.name), setColor(role.color), setHoist(!!role.hoist), setPerms(role.permissions), setMsg(''));
  return (
    <div className="role-editor">
      {!editable && <p className="warn-box">Esse cargo está no seu nível ou acima. Só quem tem um cargo mais alto (ou o dono) pode mudar.</p>}
      <fieldset disabled={!editable}>
        {!everyone && (
          <>
            <label className="field">
              <span>Nome do cargo</span>
              <input value={name} maxLength={64} onChange={(e) => (setName(e.target.value), setMsg(''))} />
            </label>
            <div className="field">
              <span>Cor do nome</span>
              <div className="color-swatches">
                <button className={`swatch none ${color === null ? 'active' : ''}`} title="Sem cor" onClick={() => setColor(null)}><X size={12} /></button>
                {ROLE_COLORS.map((c) => (
                  <button key={c} className={`swatch ${color === c ? 'active' : ''}`} style={{ background: c }} title={c} onClick={() => setColor(c)} />
                ))}
                <input type="color" value={color ?? '#99aab5'} title="Outra cor" onChange={(e) => setColor(e.target.value)} />
              </div>
            </div>
            <Toggle label="Mostrar separado na lista de membros" hint="Quem está online com esse cargo aparece num grupo próprio, como no Discord." checked={hoist} onChange={setHoist} />
          </>
        )}
        <h3>Permissões{everyone ? ' de todo mundo (@everyone)' : ''}</h3>
        {PERM_INFO.map((g) => (
          <div key={g.group} className="perm-group">
            <h4>{g.group}</h4>
            {g.items.map(([bit, label, hint]) => (
              <div key={bit} className={(mine & bit) === 0 ? 'perm-locked' : ''} title={(mine & bit) === 0 ? 'Você não tem essa permissão, então não pode dar nem tirar' : undefined}>
                <Toggle label={label} hint={hint} checked={(perms & bit) !== 0} onChange={(on) => (mine & bit) !== 0 && setPerms(on ? perms | bit : perms & ~bit)} />
              </div>
            ))}
          </div>
        ))}
        {!everyone && <button className="danger" onClick={remove}><Trash2 size={14} /> Apagar cargo</button>}
      </fieldset>
      {(changed || msg) && (
        <div className="save-bar">
          <span>{msg || 'Você tem alterações que não foram salvas.'}</span>
          {changed && (
            <>
              <button className="link" onClick={reset}>Redefinir</button>
              <button className="primary" disabled={!everyone && !name.trim()} onClick={save}>Salvar alterações</button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** Permissões de um canal: tornar privado e, para cada cargo, permitir / padrão / negar cada coisa. */
function ChannelPerms({ guild, channel, me }: { guild: Guild; channel: Channel; me: User }) {
  const roles = guild.roles ?? [];
  const ow = (id: string) => channel.overwrites?.find((o) => o.id === id) ?? { id, allow: 0, deny: 0 };
  const [sel, setSel] = useState(guild.id);
  const mine = permsOf(guild, me.id);
  const save = (id: string, allow: number, deny: number) =>
    api('PUT', `/channels/${channel.id}/overwrites/${id}`, { allow, deny }).catch((e) => alert(e.message));
  const set = (id: string, bit: number, state: 'allow' | 'none' | 'deny') => {
    const o = ow(id);
    const allow = state === 'allow' ? o.allow | bit : o.allow & ~bit;
    const deny = state === 'deny' ? o.deny | bit : o.deny & ~bit;
    void save(id, allow, deny);
  };
  const priv = isPrivate(channel);
  const role = roles.find((r) => r.id === sel);
  const o = ow(sel);
  return (
    <div className="channel-perms">
      <Toggle
        label="Canal privado"
        hint="Só o dono, administradores e os cargos que você liberar abaixo (com “Ver canal” em ✓) veem este canal."
        checked={priv}
        onChange={(on) => set(guild.id, P.VIEW_CHANNEL, on ? 'deny' : 'none')}
      />
      <label className="field">
        <span>Cargo</span>
        <select value={sel} onChange={(e) => setSel(e.target.value)}>
          {roles.map((r) => (
            <option key={r.id} value={r.id}>{r.name}{channel.overwrites?.some((x) => x.id === r.id) ? ' •' : ''}</option>
          ))}
        </select>
      </label>
      {role && (
        <div className="perm-grid">
          {CHANNEL_PERM_LIST(channel.type).map(([bit, label, hint]) => {
            const state = o.allow & bit ? 'allow' : o.deny & bit ? 'deny' : 'none';
            const locked = (mine & bit) === 0;
            return (
              <div key={bit} className="perm-row" title={locked ? 'Você não tem essa permissão' : hint}>
                <span>{label}<small className="muted">{hint}</small></span>
                <div className="tri">
                  <button disabled={locked} className={state === 'deny' ? 'on deny' : ''} title="Negar" onClick={() => set(sel, bit, 'deny')}>✕</button>
                  <button disabled={locked} className={state === 'none' ? 'on' : ''} title="Padrão (segue o cargo)" onClick={() => set(sel, bit, 'none')}>/</button>
                  <button disabled={locked} className={state === 'allow' ? 'on allow' : ''} title="Permitir" onClick={() => set(sel, bit, 'allow')}>✓</button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
