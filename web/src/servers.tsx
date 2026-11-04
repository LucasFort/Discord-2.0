import { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft, BookOpen, Camera, Check, ChevronRight, Copy, Gamepad2, Hash, Heart, Link2, Megaphone, Search, Sparkles, Users, Volume2, X,
} from 'lucide-react';
import { api, isDm, type Guild, type Presence, type User } from './api';
import { Avatar, GuildIcon, pickImage } from './profile';
import { dmText, openDm } from './friends';
import { getSettings } from './settings';
import { toast } from './toast';
import type { State } from './store';

/**
 * Criar servidor (com modelos), entrar com convite, convidar amigos e o cartão de convite no chat.
 * Os modelos espelham server/src/templates.ts (o servidor cria de verdade; aqui é só a prévia).
 */
type TemplateId = 'blank' | 'friends' | 'gaming' | 'study' | 'community';
const TEMPLATES: { id: TemplateId; title: string; desc: string; icon: JSX.Element; color: string; text: string[]; voice: string[]; roles?: string[] }[] = [
  { id: 'friends', title: 'Amigos', desc: 'Um cantinho para a galera conversar, mandar memes e entrar na call.', icon: <Heart size={22} />, color: '#e91e63', text: ['geral', 'memes', 'fotos'], voice: ['Sala', 'Jogando'] },
  { id: 'gaming', title: 'Jogos', desc: 'Lobby e salas de partida, clipes e procurar grupo.', icon: <Gamepad2 size={22} />, color: '#2ecc71', text: ['geral', 'clipes', 'procurando-grupo'], voice: ['Lobby', 'Partida 1', 'Partida 2'], roles: ['Moderador'] },
  { id: 'study', title: 'Estudos', desc: 'Avisos, dúvidas, materiais e sala para estudar junto.', icon: <BookOpen size={22} />, color: '#3498db', text: ['avisos', 'geral', 'duvidas', 'materiais'], voice: ['Sala de estudo', 'Foco em silêncio'], roles: ['Monitor'] },
  { id: 'community', title: 'Comunidade', desc: 'Boas-vindas, regras e anúncios, com Admin e Moderador prontos.', icon: <Megaphone size={22} />, color: '#f1c40f', text: ['boas-vindas', 'regras', 'anuncios', 'geral'], voice: ['Geral', 'Eventos'], roles: ['Admin', 'Moderador'] },
];
const BLANK = { id: 'blank' as const, title: 'Do zero', desc: 'Só um canal de texto e um de voz. Você monta o resto.', icon: <Sparkles size={22} />, color: '#7c5cff', text: ['geral'], voice: ['Geral'] };

/** Pega o código de um link de convite (ou o próprio código colado). */
export const inviteCodeOf = (input: string) => {
  const t = input.trim();
  const m = t.match(/\/convite\/([A-Za-z0-9]{4,32})/);
  if (m) return m[1];
  return /^[A-Za-z0-9]{4,32}$/.test(t) ? t : null;
};
export const inviteLink = (code: string) => `${location.origin}/convite/${code}`;

type Step = 'pick' | 'custom' | 'join';

export function CreateServerModal({ me, start = 'pick', initialInvite = '', onClose, onDone }: { me: User; start?: Step; initialInvite?: string; onClose: () => void; onDone: (guildId: string) => void }) {
  const [step, setStep] = useState<Step>(start);
  const [tpl, setTpl] = useState<typeof BLANK | (typeof TEMPLATES)[number]>(BLANK);
  const [name, setName] = useState(`Servidor de ${me.display_name}`);
  const [icon, setIcon] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const create = async () => {
    setBusy(true);
    try {
      const g = await api<Guild>('POST', '/guilds', { name: name.trim(), icon, template: tpl.id });
      onDone(g.id);
    } catch (e) {
      toast((e as Error).message, 'error');
      setBusy(false);
    }
  };
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal create-server" onClick={(e) => e.stopPropagation()}>
        <button className="icon modal-x" title="Fechar" onClick={onClose}><X size={20} /></button>
        {step === 'pick' && (
          <>
            <div className="cs-head">
              <h2>Crie seu servidor</h2>
              <p className="muted">Seu servidor é onde você e seus amigos se encontram. Escolha um modelo para começar com tudo pronto.</p>
            </div>
            <button className="cs-option" onClick={() => (setTpl(BLANK), setStep('custom'))}>
              <span className="cs-option-icon" style={{ background: BLANK.color }}>{BLANK.icon}</span>
              <span className="cs-option-text"><strong>{BLANK.title}</strong><small>{BLANK.desc}</small></span>
              <ChevronRight size={18} />
            </button>
            <h3>Começar com um modelo</h3>
            <div className="cs-list">
              {TEMPLATES.map((t) => (
                <button key={t.id} className="cs-option" onClick={() => (setTpl(t), setStep('custom'))}>
                  <span className="cs-option-icon" style={{ background: t.color }}>{t.icon}</span>
                  <span className="cs-option-text"><strong>{t.title}</strong><small>{t.desc}</small></span>
                  <ChevronRight size={18} />
                </button>
              ))}
            </div>
            <div className="cs-foot">
              <h3>Já tem um convite?</h3>
              <button className="cs-join" onClick={() => setStep('join')}>Entrar num servidor</button>
            </div>
          </>
        )}
        {step === 'custom' && (
          <>
            <div className="cs-head">
              <h2>Personalize seu servidor</h2>
              <p className="muted">Dê um nome e um ícone. Dá para mudar tudo depois nas configurações.</p>
            </div>
            <div className="cs-upload-wrap">
              <button className={`cs-upload ${icon ? 'has' : ''}`} title="Escolher ícone" onClick={async () => setIcon((await pickImage(128).catch(() => null)) ?? icon)}>
                {icon ? <img src={icon} alt="" /> : <><Camera size={22} /><small>ENVIAR</small></>}
                <span className="cs-upload-plus">+</span>
              </button>
              {icon && <button className="link" onClick={() => setIcon(null)}>Tirar ícone</button>}
            </div>
            <label className="field">
              <span>Nome do servidor</span>
              <input value={name} maxLength={64} autoFocus onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && name.trim() && !busy && void create()} />
            </label>
            <div className="cs-preview">
              <div className="cs-preview-head">
                <span className="guild small"><GuildIcon name={name || '?'} icon={icon} /></span>
                <strong>{name || 'Seu servidor'}</strong>
                <span className="cs-tag" style={{ background: tpl.color }}>{tpl.title}</span>
              </div>
              <div className="cs-preview-cols">
                <div>{tpl.text.map((c) => <span key={c}><Hash size={14} /> {c}</span>)}</div>
                <div>{tpl.voice.map((c) => <span key={c}><Volume2 size={14} /> {c}</span>)}</div>
              </div>
              {'roles' in tpl && tpl.roles && <small className="muted">Cargos prontos: {tpl.roles.join(', ')}</small>}
            </div>
            <p className="muted small-print">Ao criar, você concorda em seguir as regras de convivência do Nexo.</p>
            <div className="modal-actions spread">
              <button className="link" onClick={() => setStep('pick')}><ArrowLeft size={16} /> Voltar</button>
              <button className="primary" disabled={!name.trim() || busy} onClick={create}>{busy ? 'Criando…' : 'Criar'}</button>
            </div>
          </>
        )}
        {step === 'join' && <JoinStep initial={initialInvite} onBack={start === 'join' ? undefined : () => setStep('pick')} onDone={onDone} />}
      </div>
    </div>
  );
}

type InvitePreview = {
  code: string;
  guild: { id: string; name: string; icon: string | null };
  member_count: number;
  online_count: number;
  inviter: { id: string; display_name: string; avatar: string | null } | null;
  expires_at: number | null;
  joined: boolean;
};
const previewCache = new Map<string, Promise<InvitePreview | null>>();
const fetchPreview = (code: string, fresh = false) => {
  if (fresh || !previewCache.has(code)) previewCache.set(code, api<InvitePreview>('GET', `/invites/${code}`).catch(() => null));
  return previewCache.get(code)!;
};

function JoinStep({ initial, onBack, onDone }: { initial: string; onBack?: () => void; onDone: (guildId: string) => void }) {
  const [input, setInput] = useState(initial);
  const [preview, setPreview] = useState<InvitePreview | null | undefined>(undefined);
  const [error, setError] = useState('');
  const code = inviteCodeOf(input);
  useEffect(() => {
    setPreview(undefined);
    setError('');
    if (!code) return;
    const t = setTimeout(() => void fetchPreview(code, true).then(setPreview), 300);
    return () => clearTimeout(t);
  }, [code]);
  const join = async () => {
    if (!code) return setError('Cole um link de convite válido, como ' + inviteLink('hTKzmak'));
    try {
      const g = await api<Guild>('POST', `/invites/${code}`);
      previewCache.delete(code);
      onDone(g.id);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <>
      <div className="cs-head">
        <h2>Entrar num servidor</h2>
        <p className="muted">Cole um convite para entrar num servidor que já existe.</p>
      </div>
      <label className="field">
        <span>Link do convite</span>
        <input autoFocus value={input} placeholder={inviteLink('hTKzmak')} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void join()} />
      </label>
      {code && preview && <InviteCardBody p={preview} />}
      {code && preview === null && <p className="error">Esse convite não existe ou já expirou.</p>}
      {error && <p className="error">{error}</p>}
      <div className="cs-hint">
        <strong>Os convites são assim:</strong>
        <code>hTKzmak</code>
        <code>{inviteLink('hTKzmak')}</code>
      </div>
      <div className="modal-actions spread">
        {onBack ? <button className="link" onClick={onBack}><ArrowLeft size={16} /> Voltar</button> : <span />}
        <button className="primary" disabled={!code || preview === null} onClick={join}>{preview?.joined ? 'Abrir servidor' : 'Entrar no servidor'}</button>
      </div>
    </>
  );
}

function InviteCardBody({ p }: { p: InvitePreview }) {
  return (
    <div className="invite-card-body">
      <span className="guild"><GuildIcon name={p.guild.name} icon={p.guild.icon} /></span>
      <div>
        <strong>{p.guild.name}</strong>
        <small className="invite-counts">
          <span className="dot on" /> {p.online_count} online <span className="dot" /> {p.member_count} {p.member_count === 1 ? 'membro' : 'membros'}
        </small>
      </div>
    </div>
  );
}

/** Cartão que aparece embaixo de uma mensagem com link de convite, com o botão "Entrar". */
export function InviteEmbed({ code }: { code: string }) {
  const [p, setP] = useState<InvitePreview | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let on = true;
    void fetchPreview(code).then((r) => on && setP(r));
    return () => void (on = false);
  }, [code]);
  if (p === undefined) return <div className="invite-embed loading"><small>CARREGANDO CONVITE…</small></div>;
  if (!p)
    return (
      <div className="invite-embed">
        <small className="invite-embed-title">CONVITE INVÁLIDO</small>
        <p className="muted">Esse convite expirou ou foi usado até o limite.</p>
      </div>
    );
  const join = async () => {
    setBusy(true);
    try {
      if (!p.joined) await api('POST', `/invites/${code}`);
      previewCache.delete(code);
      setP({ ...p, joined: true });
      window.dispatchEvent(new CustomEvent('nexo:open-guild', { detail: p.guild.id }));
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="invite-embed">
      <small className="invite-embed-title">{p.inviter ? `${p.inviter.display_name.toUpperCase()} TE CONVIDOU PARA UM SERVIDOR` : 'VOCÊ RECEBEU UM CONVITE'}</small>
      <div className="invite-embed-row">
        <InviteCardBody p={p} />
        <button className={p.joined ? '' : 'ok-button'} disabled={busy} onClick={join}>{p.joined ? 'Abrir' : 'Entrar'}</button>
      </div>
    </div>
  );
}

const EXPIRY: [number | null, string][] = [[0.5, '30 minutos'], [1, '1 hora'], [6, '6 horas'], [24, '1 dia'], [168, '7 dias'], [null, 'Nunca']];
const USES: [number | null, string][] = [[null, 'Sem limite'], [1, '1 uso'], [5, '5 usos'], [10, '10 usos'], [25, '25 usos'], [100, '100 usos']];
const expiryText = (h: number | null) => (h === null ? 'Seu convite nunca expira.' : `Seu convite expira em ${EXPIRY.find((e) => e[0] === h)?.[1] ?? `${h} horas`}.`);

/** "Convidar amigos": manda o convite direto para amigos (na conversa direta) ou copia o link. */
export function InviteModal({ guild, state, presenceOf, onClose }: { guild: Guild; state: State; presenceOf: (id: string) => Presence; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [code, setCode] = useState<string | null>(null);
  const [hours, setHours] = useState<number | null>(168);
  const [uses, setUses] = useState<number | null>(null);
  const [editing, setEditing] = useState(false);
  const [sent, setSent] = useState<Record<string, 'sending' | 'sent'>>({});
  const [copied, setCopied] = useState(false);
  const hide = getSettings().streamerMode && getSettings().streamerHideInvites;
  const generate = async (h = hours, u = uses) => {
    try {
      // "Nunca": 10 anos (o servidor sempre põe uma validade).
      const r = await api<{ code: string }>('POST', `/guilds/${guild.id}/invites`, { max_uses: u, expires_in_hours: h ?? 24 * 365 * 10 });
      setCode(r.code);
      return r.code;
    } catch (e) {
      toast((e as Error).message, 'error');
      return null;
    }
  };
  useEffect(() => {
    void generate();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const members = useMemo(() => new Set(guild.members.map((m) => m.id)), [guild.members]);
  const order = (u: User) => (presenceOf(u.id) === 'offline' ? 1 : 0);
  const friends = Object.values(state.relationships)
    .filter((r) => r.type === 'friend')
    .map((r) => r.user)
    .filter((u) => !q || `${u.display_name} ${u.username}`.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => order(a) - order(b) || a.display_name.localeCompare(b.display_name));
  const send = async (u: User) => {
    const c = code ?? (await generate());
    if (!c) return;
    setSent((s) => ({ ...s, [u.id]: 'sending' }));
    const dm = await openDm(u.id);
    const ch = dm && dmText(dm);
    if (!ch) return setSent(({ [u.id]: _, ...s }) => s);
    try {
      await api('POST', `/channels/${ch.id}/messages`, { content: `Bora entrar no **${guild.name}**? ${inviteLink(c)}` });
      setSent((s) => ({ ...s, [u.id]: 'sent' }));
    } catch (e) {
      toast((e as Error).message, 'error');
      setSent(({ [u.id]: _, ...s }) => s);
    }
  };
  const copy = async () => {
    if (!code) return;
    await navigator.clipboard?.writeText(inviteLink(code)).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal invite-modal" onClick={(e) => e.stopPropagation()}>
        <button className="icon modal-x" title="Fechar" onClick={onClose}><X size={20} /></button>
        <h2>Convidar amigos para {guild.name}</h2>
        <p className="muted"><Users size={13} /> {guild.members.length} {guild.members.length === 1 ? 'membro' : 'membros'} · o convite chega na conversa direta, com um botão para entrar</p>
        <div className="invite-search">
          <Search size={16} />
          <input placeholder="Procurar amigos" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
        </div>
        <div className="invite-friends">
          {friends.length === 0 && (
            <p className="muted invite-empty">{q ? 'Nenhum amigo com esse nome.' : 'Você ainda não tem amigos no Nexo. Mande o link abaixo ou adicione amigos na tela inicial.'}</p>
          )}
          {friends.map((u) => {
            const inside = members.has(u.id);
            const st = sent[u.id];
            return (
              <div key={u.id} className="invite-friend">
                <Avatar user={u} size={32} status={presenceOf(u.id)} />
                <span className="invite-friend-name"><strong>{u.display_name}</strong><small>@{u.username}</small></span>
                {inside ? (
                  <span className="muted invite-inside">Já está no servidor</span>
                ) : (
                  <button className={st === 'sent' ? 'sent' : 'ok-outline'} disabled={!!st} onClick={() => send(u)}>
                    {st === 'sent' ? <><Check size={14} /> Enviado</> : st === 'sending' ? 'Enviando…' : 'Convidar'}
                  </button>
                )}
              </div>
            );
          })}
        </div>
        <h3>Ou mande um link de convite</h3>
        <div className="invite-link-box">
          <Link2 size={16} />
          <input readOnly value={!code ? 'Gerando…' : hide ? '•••••••• (escondido no modo streamer)' : inviteLink(code)} onFocus={(e) => !hide && e.target.select()} />
          <button className={copied ? 'ok-button' : 'primary'} disabled={!code} onClick={copy}>{copied ? <><Check size={14} /> Copiado</> : <><Copy size={14} /> Copiar</>}</button>
        </div>
        {!editing ? (
          <p className="muted invite-expiry">
            {expiryText(hours)}{uses ? ` Até ${uses} ${uses === 1 ? 'uso' : 'usos'}.` : ''} <button className="link" onClick={() => setEditing(true)}>Editar link de convite</button>
          </p>
        ) : (
          <div className="invite-edit">
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
            <button className="primary" onClick={async () => { await generate(); setSent({}); setEditing(false); }}>Gerar link novo</button>
          </div>
        )}
      </div>
    </div>
  );
}

/** Pessoas dos meus servidores que ainda não são minhas amigas (sugestões em "Adicionar amigo"). */
export function friendSuggestions(state: State, meId: string) {
  const shared = new Map<string, { user: User; guilds: string[] }>();
  for (const g of state.guilds) {
    if (isDm(g)) continue;
    for (const m of g.members) {
      if (m.id === meId || state.relationships[m.id]) continue;
      const e = shared.get(m.id) ?? { user: m, guilds: [] };
      e.guilds.push(g.name);
      shared.set(m.id, e);
    }
  }
  return [...shared.values()].sort((a, b) => b.guilds.length - a.guilds.length || a.user.display_name.localeCompare(b.user.display_name));
}
