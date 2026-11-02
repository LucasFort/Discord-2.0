import { useEffect, useRef, useState } from 'react';
import { Circle, Moon, MinusCircle, Pencil, Settings as SettingsIcon, SmilePlus, X } from 'lucide-react';
import { api, STATUS_LABELS, type Presence, type User, type UserStatus } from './api';
import { ask } from './ask';
import { useSettings } from './settings';

export function initials(name: string) {
  return name.split(/\s+/).map((w) => w[0]).join('').slice(0, 3).toUpperCase();
}

const hueOf = (id: string) => [...id].reduce((h, c) => h + c.charCodeAt(0), 0) % 360;
/** Cor padrão do banner/foto quando a pessoa não escolheu. */
export const defaultColor = (id: string) => `hsl(${hueOf(id)} 55% 45%)`;

/** Foto de perfil (ou iniciais) com a bolinha de status: verde, amarelo (ausente), vermelho (não perturbe), cinza. */
export function Avatar({ user, size = 32, status }: { user: User; size?: number; status?: Presence }) {
  return (
    <span className="avatar" style={{ width: size, height: size, background: user.avatar ? 'transparent' : defaultColor(user.id), fontSize: size * 0.4 }}>
      {user.avatar ? <img src={user.avatar} alt="" /> : initials(user.display_name)}
      {status && <StatusDot status={status} />}
    </span>
  );
}

export function StatusDot({ status }: { status: Presence }) {
  return <span className={`dot ${status}`} title={status === 'offline' ? 'Offline' : STATUS_LABELS[status]} />;
}

/** Ícone redondo do servidor: imagem ou iniciais. */
export function GuildIcon({ name, icon }: { name: string; icon?: string | null }) {
  return icon ? <img className="guild-img" src={icon} alt="" /> : <>{initials(name)}</>;
}

/** Reduz uma imagem escolhida para um quadrado de até `size` px e devolve em data URL (vai para o servidor). */
export async function pickImage(size = 128): Promise<string | null> {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/png,image/jpeg,image/webp,image/gif';
  const file = await new Promise<File | null>((resolve) => {
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.click();
  });
  if (!file) return null;
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const side = Math.min(img.width, img.height);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    canvas.getContext('2d')!.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size);
    const webp = canvas.toDataURL('image/webp', 0.85);
    return webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/jpeg', 0.85);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Cartão de perfil (clique no nome ou na foto de alguém), como no Discord. */
export function ProfileCard({ user, status, x, y, onClose, isMe, onEdit }: {
  user: User;
  status: Presence;
  x: number;
  y: number;
  onClose: () => void;
  isMe?: boolean;
  onEdit?: () => void;
}) {
  const s = useSettings();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  useEffect(() => {
    const el = ref.current;
    if (el) {
      const r = el.getBoundingClientRect();
      setPos({ left: Math.max(8, Math.min(x, innerWidth - r.width - 8)), top: Math.max(8, Math.min(y, innerHeight - r.height - 8)) });
    }
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', close);
    };
  }, [x, y, onClose]);
  return (
    <div className="profile-card" ref={ref} style={pos}>
      <ProfileBody user={user} status={status} hideUsername={s.streamerMode && s.streamerHideNames && !isMe} />
      {isMe && onEdit && (
        <button className="profile-edit" onClick={onEdit}><Pencil size={14} /> Editar perfil</button>
      )}
    </div>
  );
}

/** O conteúdo do cartão (também usado na prévia das configurações). */
export function ProfileBody({ user, status, hideUsername }: { user: User; status?: Presence; hideUsername?: boolean }) {
  return (
    <>
      <div className="profile-banner" style={{ background: user.banner_color || defaultColor(user.id) }} />
      <div className="profile-avatar"><Avatar user={user} size={80} status={status} /></div>
      <div className="profile-info">
        <h3>{user.display_name}</h3>
        <div className="muted">
          {!hideUsername && <>@{user.username}</>}
          {user.pronouns && <> · {user.pronouns}</>}
        </div>
        {user.custom_status && <div className="profile-status">{user.custom_status}</div>}
        {user.bio && (
          <>
            <h4>Sobre mim</h4>
            <p className="profile-bio">{user.bio}</p>
          </>
        )}
      </div>
    </>
  );
}

const STATUS_ICONS: Record<UserStatus, JSX.Element> = {
  online: <Circle size={12} className="st-online" fill="currentColor" />,
  idle: <Moon size={12} className="st-idle" fill="currentColor" />,
  dnd: <MinusCircle size={12} className="st-dnd" />,
  invisible: <Circle size={12} className="st-invisible" />,
};
const STATUS_HINTS: Partial<Record<UserStatus, string>> = {
  dnd: 'Você não recebe avisos nem sons de mensagem.',
  invisible: 'Você aparece como offline, mas usa o Nexo normalmente.',
};

/** Menu do status (clique na sua foto lá embaixo): status, status personalizado, editar perfil. */
export function StatusMenu({ user, status, onClose, onEditProfile }: { user: User; status: UserStatus; onClose: () => void; onEditProfile: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose();
    const t = setTimeout(() => window.addEventListener('mousedown', close));
    return () => {
      clearTimeout(t);
      window.removeEventListener('mousedown', close);
    };
  }, [onClose]);
  const set = async (st: UserStatus) => {
    onClose();
    await api('PUT', '/users/@me/status', { status: st }).catch((e) => alert(e.message));
  };
  const custom = async () => {
    onClose();
    const v = await ask('Status personalizado (vazio para tirar)', { value: user.custom_status ?? '', okText: 'Salvar' });
    if (v !== null && v !== undefined) await api('PATCH', '/users/@me', { custom_status: v.trim() || null }).catch((e) => alert(e.message));
  };
  return (
    <div className="status-menu" ref={ref}>
      <div className="status-menu-head">
        <Avatar user={user} size={40} />
        <div>
          <strong>{user.display_name}</strong>
          <small className="muted">{user.custom_status || `@${user.username}`}</small>
        </div>
      </div>
      {(Object.keys(STATUS_LABELS) as UserStatus[]).map((st) => (
        <button key={st} className={`status-option ${st === status ? 'active' : ''}`} onClick={() => set(st)}>
          {STATUS_ICONS[st]}
          <span>
            {STATUS_LABELS[st]}
            {STATUS_HINTS[st] && <small>{STATUS_HINTS[st]}</small>}
          </span>
        </button>
      ))}
      <div className="menu-sep" />
      <button className="status-option" onClick={custom}><SmilePlus size={14} /> <span>{user.custom_status ? 'Editar status personalizado' : 'Definir status personalizado'}</span></button>
      {user.custom_status && (
        <button className="status-option" onClick={() => (onClose(), void api('PATCH', '/users/@me', { custom_status: null }))}><X size={14} /> <span>Tirar status personalizado</span></button>
      )}
      <button className="status-option" onClick={() => (onClose(), onEditProfile())}><SettingsIcon size={14} /> <span>Editar perfil</span></button>
    </div>
  );
}

/** Abre o cartão de perfil de alguém perto do elemento clicado (o App registra quem mostra). */
export type ProfileOpen = { user: User; x: number; y: number };
let openProfileFn: ((p: ProfileOpen | null) => void) | null = null;
export const setProfileOpener = (fn: ((p: ProfileOpen | null) => void) | null) => void (openProfileFn = fn);
export const openProfile = (user: User, e: React.MouseEvent) => {
  e.stopPropagation();
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  openProfileFn?.({ user, x: r.right + 8, y: r.top });
};
