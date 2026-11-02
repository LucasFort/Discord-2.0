import { useEffect, useState } from 'react';
import { Hash, LayoutGrid, Link2, Trash2, Users, Volume2, X } from 'lucide-react';
import { api, type Channel, type Guild, type Presence, type User } from './api';
import { ask } from './ask';
import { Avatar, GuildIcon, pickImage } from './profile';
import { getSettings } from './settings';

type Tab = 'overview' | 'channels' | 'members' | 'invites' | 'delete';

/** Configurações do servidor (só o dono abre): visão geral, canais, membros, convites e apagar. */
export function ServerSettings({ guild, me, presenceOf, onClose }: { guild: Guild; me: User; presenceOf: (id: string) => Presence; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('overview');
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const tabs: [Tab, string, JSX.Element][] = [
    ['overview', 'Visão geral', <LayoutGrid size={16} />],
    ['channels', 'Canais', <Hash size={16} />],
    ['members', 'Membros', <Users size={16} />],
    ['invites', 'Convites', <Link2 size={16} />],
  ];
  return (
    <div className="settings">
      <nav className="settings-nav">
        <div className="settings-group">
          <h3>{guild.name}</h3>
          {tabs.map(([t, label, icon]) => (
            <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>{icon} {label}</button>
          ))}
        </div>
        <div className="settings-group">
          <button className={`danger-text ${tab === 'delete' ? 'active' : ''}`} onClick={() => setTab('delete')}><Trash2 size={16} /> Apagar servidor</button>
        </div>
      </nav>
      <section className="settings-body">
        {tab === 'overview' && <Overview key={guild.id} guild={guild} />}
        {tab === 'channels' && <Channels guild={guild} />}
        {tab === 'members' && <Members guild={guild} me={me} presenceOf={presenceOf} />}
        {tab === 'invites' && <Invites guild={guild} />}
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

function Channels({ guild }: { guild: Guild }) {
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
            <div key={c.id} className="admin-row">
              {type === 'text' ? <Hash size={16} /> : <Volume2 size={16} />}
              <div className="admin-row-main">
                <strong>{c.name}</strong>
                {c.topic && <small className="muted">{c.topic}</small>}
              </div>
              <button onClick={() => rename(c)}>Renomear</button>
              {type === 'text' && <button onClick={() => topic(c)}>Tópico</button>}
              <button className="icon danger" title="Apagar canal" onClick={() => remove(c)}><Trash2 size={16} /></button>
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
            </div>
            {m.id !== me.id && m.id !== guild.owner_id && <button className="danger" onClick={() => kick(m)}>Expulsar</button>}
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
