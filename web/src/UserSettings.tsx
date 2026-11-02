import { useEffect, useState } from 'react';
import { api, STATUS_LABELS, type User, type UserStatus } from './api';
import { Avatar, pickImage, ProfileBody, defaultColor } from './profile';
import { comboName, updateSettings, useSettings, type Settings } from './settings';
import { requestNotifyPermission } from './notify';
import { hasDesktopAppSettings } from './appearance';
import { myPresence } from './store';

/** Interruptor com título e explicação (mesmo visual das outras abas). */
export function Toggle({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="toggle-row">
      <span>
        <strong>{label}</strong>
        {hint && <small>{hint}</small>}
      </span>
      <input type="checkbox" className="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

function Options<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="options">
      {options.map(([v, label]) => (
        <button key={v} className={`option ${v === value ? 'selected' : ''}`} onClick={() => onChange(v)}>{label}</button>
      ))}
    </div>
  );
}

function Range({ label, value, min, max, step = 1, unit, onChange }: { label: string; value: number; min: number; max: number; step?: number; unit: string; onChange: (v: number) => void }) {
  return (
    <label className="field">
      <span>{label} · {value}{unit}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(+e.target.value)} />
    </label>
  );
}

const set = (patch: Partial<Settings>) => updateSettings(patch);

// ---------------------------------------------------------------- Minha conta
export function AccountSettings({ user, status, onLogout, onEditProfile }: { user: User; status: UserStatus; onLogout: () => void; onEditProfile: () => void }) {
  const s = useSettings();
  const [reveal, setReveal] = useState(false);
  const [editing, setEditing] = useState<'' | 'display_name' | 'username' | 'password'>('');
  return (
    <>
      <h2>Minha conta</h2>
      <div className="account-card">
        <div className="profile-banner" style={{ background: user.banner_color || defaultColor(user.id) }} />
        <div className="account-head">
          <Avatar user={user} size={72} status={myPresence(status)} />
          <div>
            <h3>{user.display_name}</h3>
            <small className="muted">{STATUS_LABELS[status]}</small>
          </div>
          <button className="primary" onClick={onEditProfile}>Editar perfil</button>
        </div>
        <div className="account-rows">
          <AccountRow label="Nome de exibição" value={user.display_name} onEdit={() => setEditing('display_name')} />
          <AccountRow
            label="Nome de usuário"
            value={s.streamerMode && s.streamerHideNames && !reveal ? '••••••••' : user.username}
            extra={s.streamerMode && s.streamerHideNames && <button className="link" onClick={() => setReveal((v) => !v)}>{reveal ? 'Esconder' : 'Mostrar'}</button>}
            onEdit={() => setEditing('username')}
          />
        </div>
      </div>
      {editing === 'display_name' && <EditField label="Nome de exibição" initial={user.display_name} field="display_name" onDone={() => setEditing('')} />}
      {editing === 'username' && <EditField label="Nome de usuário" initial={user.username} field="username" hint="Letras, números, _ ou ponto. É com ele que você entra." onDone={() => setEditing('')} />}

      <h3>Senha e segurança</h3>
      {editing === 'password' ? <PasswordForm onDone={() => setEditing('')} /> : <button onClick={() => setEditing('password')}>Mudar senha</button>}

      <h3>Sessão</h3>
      <p className="muted">Sair desconecta este computador. Para entrar de novo, use seu usuário e senha.</p>
      <button className="danger" onClick={onLogout}>Sair da conta</button>
    </>
  );
}

function AccountRow({ label, value, extra, onEdit }: { label: string; value: string; extra?: React.ReactNode; onEdit: () => void }) {
  return (
    <div className="account-row">
      <div>
        <small>{label}</small>
        <div>{value} {extra}</div>
      </div>
      <button onClick={onEdit}>Editar</button>
    </div>
  );
}

function EditField({ label, initial, field, hint, onDone }: { label: string; initial: string; field: 'display_name' | 'username'; hint?: string; onDone: () => void }) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState('');
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api('PATCH', '/users/@me', { [field]: value.trim() });
      onDone();
    } catch (err) {
      setError(friendly((err as Error).message));
    }
  };
  return (
    <form className="edit-box" onSubmit={save}>
      <label className="field">
        <span>{label}</span>
        <input value={value} onChange={(e) => setValue(e.target.value)} maxLength={32} autoFocus />
      </label>
      {hint && <small className="muted">{hint}</small>}
      {error && <p className="error">{error}</p>}
      <div className="row-buttons">
        <button type="button" className="link" onClick={onDone}>Cancelar</button>
        <button className="primary">Salvar</button>
      </div>
    </form>
  );
}

function PasswordForm({ onDone }: { onDone: () => void }) {
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [ok, setOk] = useState(false);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password.length < 6) return setError('A senha nova precisa de pelo menos 6 caracteres.');
    if (password !== confirm) return setError('As duas senhas novas não são iguais.');
    try {
      await api('POST', '/users/@me/password', { current, password });
      setOk(true);
      setTimeout(onDone, 1500);
    } catch (err) {
      setError(friendly((err as Error).message));
    }
  };
  return (
    <form className="edit-box" onSubmit={save}>
      <label className="field"><span>Senha atual</span><input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoFocus /></label>
      <label className="field"><span>Senha nova</span><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
      <label className="field"><span>Confirmar senha nova</span><input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} /></label>
      {error && <p className="error">{error}</p>}
      {ok && <p className="ok">Senha trocada.</p>}
      <div className="row-buttons">
        <button type="button" className="link" onClick={onDone}>Cancelar</button>
        <button className="primary">Mudar senha</button>
      </div>
    </form>
  );
}

/** Erros de validação do servidor vêm em JSON (zod); mostra algo legível. */
function friendly(msg: string) {
  if (msg.startsWith('[')) {
    try {
      const issues = JSON.parse(msg) as { message: string }[];
      return issues.map((i) => i.message).join(' ');
    } catch {
      /* não era JSON */
    }
  }
  return msg;
}

// ---------------------------------------------------------------- Perfil
const BANNER_COLORS = ['#7c5cff', '#4f8cff', '#2dd4a4', '#f5b84b', '#f04d5e', '#ec4899', '#14b8a6', '#64748b'];

export function ProfileSettings({ user, status }: { user: User; status: UserStatus }) {
  const [draft, setDraft] = useState({ display_name: user.display_name, pronouns: user.pronouns ?? '', bio: user.bio ?? '', banner_color: user.banner_color ?? '', avatar: user.avatar ?? null, custom_status: user.custom_status ?? '' });
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  useEffect(() => setMsg(''), [draft]);
  const changed =
    draft.display_name !== user.display_name || draft.pronouns !== (user.pronouns ?? '') || draft.bio !== (user.bio ?? '') ||
    draft.banner_color !== (user.banner_color ?? '') || draft.avatar !== (user.avatar ?? null) || draft.custom_status !== (user.custom_status ?? '');
  const save = async () => {
    setSaving(true);
    try {
      await api('PATCH', '/users/@me', {
        display_name: draft.display_name.trim() || user.display_name,
        pronouns: draft.pronouns.trim() || null,
        bio: draft.bio.trim() || null,
        banner_color: draft.banner_color || null,
        avatar: draft.avatar,
        custom_status: draft.custom_status.trim() || null,
      });
      setMsg('Perfil salvo.');
    } catch (e) {
      setMsg(friendly((e as Error).message));
    } finally {
      setSaving(false);
    }
  };
  const preview: User = { ...user, ...draft, pronouns: draft.pronouns || null, bio: draft.bio || null, banner_color: draft.banner_color || null, custom_status: draft.custom_status || null };
  return (
    <>
      <h2>Perfis</h2>
      <div className="profile-editor">
        <div className="profile-fields">
          <label className="field">
            <span>Nome de exibição</span>
            <input value={draft.display_name} maxLength={32} onChange={(e) => setDraft({ ...draft, display_name: e.target.value })} />
          </label>
          <label className="field">
            <span>Pronomes</span>
            <input value={draft.pronouns} maxLength={40} placeholder="ex.: ele/dele" onChange={(e) => setDraft({ ...draft, pronouns: e.target.value })} />
          </label>
          <div className="field">
            <span>Foto de perfil</span>
            <div className="row-buttons left">
              <button className="primary" onClick={async () => { const img = await pickImage(128).catch(() => null); if (img) setDraft({ ...draft, avatar: img }); }}>Trocar foto</button>
              {draft.avatar && <button className="link" onClick={() => setDraft({ ...draft, avatar: null })}>Tirar foto</button>}
            </div>
          </div>
          <div className="field">
            <span>Cor do banner</span>
            <div className="swatches">
              {BANNER_COLORS.map((c) => (
                <button key={c} className={`swatch ${draft.banner_color === c ? 'selected' : ''}`} style={{ background: c }} title={c} onClick={() => setDraft({ ...draft, banner_color: c })} />
              ))}
              <input type="color" value={draft.banner_color || '#7c5cff'} onChange={(e) => setDraft({ ...draft, banner_color: e.target.value })} title="Outra cor" />
              {draft.banner_color && <button className="link" onClick={() => setDraft({ ...draft, banner_color: '' })}>Padrão</button>}
            </div>
          </div>
          <label className="field">
            <span>Status personalizado</span>
            <input value={draft.custom_status} maxLength={128} placeholder="ex.: jogando até tarde 🎮" onChange={(e) => setDraft({ ...draft, custom_status: e.target.value })} />
          </label>
          <label className="field">
            <span>Sobre mim · {190 - draft.bio.length}</span>
            <textarea value={draft.bio} maxLength={190} rows={4} placeholder="Conte um pouco sobre você" onChange={(e) => setDraft({ ...draft, bio: e.target.value })} />
          </label>
        </div>
        <div className="profile-preview">
          <small className="muted">PRÉVIA</small>
          <div className="profile-card static"><ProfileBody user={preview} status={myPresence(status)} /></div>
        </div>
      </div>
      {(changed || msg) && (
        <div className="save-bar">
          <span>{msg || 'Cuidado: você tem alterações que não foram salvas.'}</span>
          {changed && (
            <>
              <button className="link" onClick={() => setDraft({ display_name: user.display_name, pronouns: user.pronouns ?? '', bio: user.bio ?? '', banner_color: user.banner_color ?? '', avatar: user.avatar ?? null, custom_status: user.custom_status ?? '' })}>Redefinir</button>
              <button className="primary" disabled={saving} onClick={save}>{saving ? 'Salvando…' : 'Salvar alterações'}</button>
            </>
          )}
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------- Aparência
export function AppearanceSettings() {
  const s = useSettings();
  return (
    <>
      <h2>Aparência</h2>
      <h3>Tema</h3>
      <div className="theme-picker">
        {([['dark', 'Escuro'], ['midnight', 'Meia-noite'], ['light', 'Claro'], ['system', 'Igual ao sistema']] as [Settings['theme'], string][]).map(([v, label]) => (
          <button key={v} className={`theme-swatch t-${v} ${s.theme === v ? 'selected' : ''}`} onClick={() => set({ theme: v })}>
            <span className="theme-sample" />
            {label}
          </button>
        ))}
      </div>
      <h3>Exibição das mensagens</h3>
      <Options value={s.messageDisplay} options={[['cozy', 'Confortável'], ['compact', 'Compacto']]} onChange={(v) => set({ messageDisplay: v })} />
      <small className="muted">{s.messageDisplay === 'cozy' ? 'Moderno, com foto e nome em cima de cada grupo de mensagens.' : 'Cabe mais mensagem na tela: hora, nome e texto na mesma linha.'}</small>
      {s.messageDisplay === 'compact' && <Toggle label="Mostrar fotos no modo compacto" checked={s.showAvatars} onChange={(v) => set({ showAvatars: v })} />}
      <h3>Tamanho</h3>
      <Range label="Tamanho da fonte do chat" value={s.fontSize} min={12} max={20} unit=" px" onChange={(v) => set({ fontSize: v })} />
      <Range label="Espaço entre grupos de mensagens" value={s.messageGap} min={0} max={24} step={4} unit=" px" onChange={(v) => set({ messageGap: v })} />
      <Range label="Zoom" value={s.zoom} min={70} max={150} step={10} unit="%" onChange={(v) => set({ zoom: v })} />
      <small className="muted">Atalho do zoom no app: Ctrl + e Ctrl − também funcionam.</small>
      <h3>Hora</h3>
      <Toggle label="Formato 24 horas" hint="Desligado mostra 2:30 PM em vez de 14:30." checked={s.use24h} onChange={(v) => set({ use24h: v })} />
      <div className="row-buttons left">
        <button className="link" onClick={() => set({ theme: 'dark', messageDisplay: 'cozy', fontSize: 15, messageGap: 16, zoom: 100, showAvatars: true, use24h: true })}>Voltar ao padrão</button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- Acessibilidade
export function AccessibilitySettings() {
  const s = useSettings();
  return (
    <>
      <h2>Acessibilidade</h2>
      <Range label="Saturação das cores" value={s.saturation} min={0} max={100} step={5} unit="%" onChange={(v) => set({ saturation: v })} />
      <small className="muted">Menos saturação deixa as cores mais suaves (ajuda quem é sensível a cores fortes).</small>
      <Toggle label="Reduzir movimento" hint="Tira animações de mensagens, menus, emojis flutuando e transições." checked={s.reduceMotion} onChange={(v) => set({ reduceMotion: v })} />
      <Toggle label="Mostrar spoilers sempre" hint="||texto escondido|| aparece direto, sem precisar clicar." checked={s.spoilers === 'always'} onChange={(v) => set({ spoilers: v ? 'always' : 'click' })} />
    </>
  );
}

// ---------------------------------------------------------------- Chat
export function ChatSettings() {
  const s = useSettings();
  return (
    <>
      <h2>Chat</h2>
      <h3>Mensagens</h3>
      <Toggle label="Converter emoticons em emoji" hint=":) vira 🙂, <3 vira ❤️ e assim por diante ao enviar." checked={s.convertEmoticons} onChange={(v) => set({ convertEmoticons: v })} />
      <Toggle label="Mostrar reações nas mensagens" checked={s.showReactions} onChange={(v) => set({ showReactions: v })} />
      <Toggle label="Links clicáveis" hint="Desligado mostra o endereço como texto comum." checked={s.showLinks} onChange={(v) => set({ showLinks: v })} />
      <h3>Conteúdo com spoiler</h3>
      <Options value={s.spoilers} options={[['click', 'Ao clicar'], ['always', 'Sempre']]} onChange={(v) => set({ spoilers: v })} />
      <h3>Formatação</h3>
      <p className="muted">**negrito**, *itálico*, `código`, ||spoiler||. Para chamar alguém: @usuário ou @todos.</p>
    </>
  );
}

// ---------------------------------------------------------------- Notificações extras
export function DesktopNotifySettings() {
  const s = useSettings();
  const [perm, setPerm] = useState(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);
  const choose = async (v: Settings['desktopNotify']) => {
    set({ desktopNotify: v });
    if (v !== 'off') setPerm(await requestNotifyPermission());
  };
  return (
    <>
      <h3>Avisos na área de trabalho</h3>
      <Options value={s.desktopNotify} options={[['all', 'Todas as mensagens'], ['mentions', 'Só quando me chamarem'], ['off', 'Nenhum']]} onChange={choose} />
      {perm === 'denied' && s.desktopNotify !== 'off' && <p className="warn-box">O navegador bloqueou os avisos do Nexo. Libere nas permissões do site (cadeado ao lado do endereço).</p>}
      {perm === 'unsupported' && <p className="muted">Este navegador não mostra avisos na área de trabalho.</p>}
      <small className="muted">Os avisos só aparecem com o Nexo fora de foco. No status "Não perturbe" nada aparece nem toca.</small>
      <Toggle label='Ficar "Ausente" sozinho' hint="Depois de 10 minutos sem mexer no computador (não vale durante a call)." checked={s.autoIdle} onChange={(v) => set({ autoIdle: v })} />
    </>
  );
}

// ---------------------------------------------------------------- Atalhos
export function KeybindList({ onEdit }: { onEdit: () => void }) {
  const s = useSettings();
  const rows: [string, string][] = [
    ['Mutar / desmutar', comboName(s.muteKey)],
    ['Ensurdecer', comboName(s.deafenKey)],
    ['Aperte para falar', s.inputMode === 'ptt' ? comboName(s.pttKey) : 'Desligado (modo Detecção de voz)'],
    ['Fechar janela ou configurações', 'Esc'],
    ['Zoom do app (no app de computador)', 'Ctrl + / Ctrl −'],
    ['Enviar mensagem', 'Enter'],
  ];
  return (
    <>
      <h2>Atalhos de teclado</h2>
      <div className="keybind-table">
        {rows.map(([a, k]) => (
          <div key={a} className="keybind-row"><span>{a}</span><kbd>{k}</kbd></div>
        ))}
      </div>
      <button onClick={onEdit}>Mudar atalhos de voz</button>
      <small className="muted">Mutar, ensurdecer e aperte para falar mudam em Voz. No app de computador eles funcionam até com o jogo em foco.</small>
    </>
  );
}

// ---------------------------------------------------------------- Modo streamer
export function StreamerSettings() {
  const s = useSettings();
  return (
    <>
      <h2>Modo streamer</h2>
      <p className="muted">Esconde informações pessoais quando você mostra a tela para os outros (em live ou transmitindo no Nexo).</p>
      <Toggle label="Ligar o modo streamer" checked={s.streamerMode} onChange={(v) => set({ streamerMode: v })} />
      <Toggle label="Ligar sozinho ao transmitir a tela" hint="Fica ativo só enquanto você está transmitindo." checked={s.streamerAuto} onChange={(v) => set({ streamerAuto: v })} />
      <h3>O que esconder</h3>
      <Toggle label="Links de convite" hint='"Convidar pessoas" copia o link sem mostrar na tela.' checked={s.streamerHideInvites} onChange={(v) => set({ streamerHideInvites: v })} />
      <Toggle label="Nomes de usuário" hint="O @usuário some da barra, dos perfis e da conta." checked={s.streamerHideNames} onChange={(v) => set({ streamerHideNames: v })} />
      <small className="muted">Avisos na área de trabalho também escondem o texto das mensagens no modo streamer.</small>
    </>
  );
}

// ---------------------------------------------------------------- App do Windows
export function WindowsSettings() {
  const s = useSettings();
  const ok = hasDesktopAppSettings();
  return (
    <>
      <h2>Configurações do Windows</h2>
      {!ok && (
        <p className="warn-box">
          Estas opções são do app de computador. {/Electron\//.test(navigator.userAgent) ? 'Seu app está numa versão antiga: ele se atualiza sozinho em instantes (ou baixe de novo).' : 'Baixe em github.com/LucasFort/Discord-2.0/releases/latest.'}
        </p>
      )}
      <Toggle label="Abrir o Nexo quando o computador ligar" checked={s.openAtLogin} onChange={(v) => set({ openAtLogin: v })} />
      <Toggle label="Começar minimizado" hint="Ao abrir junto com o Windows, fica só na bandeja (perto do relógio)." checked={s.startMinimized} onChange={(v) => set({ startMinimized: v })} />
      <Toggle label="Fechar para a bandeja" hint="O X esconde o Nexo perto do relógio e você continua na call. Para sair de vez, clique com o botão direito no ícone > Sair." checked={s.minimizeToTray} onChange={(v) => set({ minimizeToTray: v })} />
    </>
  );
}
