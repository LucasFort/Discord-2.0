import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AtSign, Ban, Users, CornerUpLeft, File as FileIcon, Hash, Phone, Music, Pencil, Pin, PinOff, PlusCircle, Search, Smile, SmilePlus, Trash2, X } from 'lucide-react';
import { can, nameColor, P } from './permissions';
import { InviteEmbed } from './servers';

/** Códigos de convite do Nexo citados numa mensagem (no máximo 3 cartões). */
const inviteCodes = (text: string) => [...new Set([...text.matchAll(/https?:\/\/[^\s/]+\/convite\/([A-Za-z0-9]{4,32})/g)].map((m) => m[1]))].slice(0, 3);
import { api, fileUrl, type Attachment, type Channel, type Guild, type Message, type User } from './api';
import { ask } from './ask';
import { playSound } from './sounds';
import { getSettings, useSettings } from './settings';
import type { Gateway, State } from './store';
import { Avatar, openProfile } from './profile';
import { mentionsMe } from './notify';
import { lastRead, markRead, setActiveChannel } from './unread';
import { MUSIC_COMMANDS, runMusicCommand } from './music';

const MAX_FILE = 8 * 1024 * 1024;
const MAX_FILES = 4;
const IMAGE_URL = /^https?:\/\/\S+\.(png|jpe?g|gif|webp)(\?\S*)?$/i;

/** Emojis do seletor (reações e mensagem), por grupo. */
export const EMOJI_GROUPS: [string, string[]][] = [
  ['Rostos', ['😀', '😄', '😁', '😆', '😅', '😂', '🤣', '🙂', '😉', '😊', '😇', '🥰', '😍', '🤩', '😘', '😋', '😛', '😜', '🤪', '🤔', '🤨', '😐', '😑', '🙄', '😏', '😬', '😮‍💨', '😌', '😴', '🤤', '😷', '🤒', '🥵', '🥶', '😵', '🤯', '🤠', '🥳', '😎', '🤓', '😕', '😟', '🙁', '😮', '😲', '😳', '🥺', '😢', '😭', '😱', '😤', '😡', '🤬', '💀', '🤡', '👻', '👽', '🤖', '💩']],
  ['Gestos', ['👍', '👎', '👌', '✌️', '🤞', '🤟', '🤘', '🤙', '👋', '👏', '🙌', '🙏', '💪', '🫡', '🫶', '👀', '🧠', '🤝']],
  ['Coisas', ['❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '💔', '💯', '🔥', '✨', '⭐', '🎉', '🎊', '🎁', '🏆', '🎮', '🎧', '🎵', '📢', '💡', '💰', '⚽', '🍕', '🍔', '🍺', '☕', '🚀', '⚡', '🌈', '☀️', '🌙', '✅', '❌', '⚠️', '❓', '❗', '💤']],
];
const ALL_EMOJIS = EMOJI_GROUPS.flatMap(([, e]) => e);

/** Converte os emoticons mais comuns em emoji ao enviar, como o Discord. */
const EMOTICONS: [RegExp, string][] = [
  [/(^|\s):\)(?=\s|$)/g, '$1🙂'], [/(^|\s):D(?=\s|$)/g, '$1😄'], [/(^|\s):\((?=\s|$)/g, '$1🙁'], [/(^|\s);\)(?=\s|$)/g, '$1😉'],
  [/(^|\s):P(?=\s|$)/gi, '$1😛'], [/(^|\s):O(?=\s|$)/g, '$1😮'], [/(^|\s)<3(?=\s|$)/g, '$1❤️'], [/(^|\s):'\((?=\s|$)/g, '$1😢'],
  [/(^|\s)xD(?=\s|$)/g, '$1😆'],
];
export const convertEmoticons = (t: string) => EMOTICONS.reduce((acc, [re, out]) => acc.replace(re, out), t);

const fmtSize = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/** Mensagem para rolar até quando o canal abrir (vindo da busca ou dos fixados). */
let pendingJump: string | null = null;
function jumpTo(id: string) {
  const el = document.getElementById(`msg-${id}`);
  if (!el) return false;
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
  return true;
}

type Pending = { key: string; name: string; type: string; size: number; data: string; preview?: string };

// ---------------------------------------------------------------- Chat
export function Chat(props: {
  channel: Channel;
  guild: Guild;
  state: State;
  dispatch: (a: any) => void;
  gateway: Gateway;
  onOpenChannel: (id: string) => void;
  dm?: User; // conversa direta: a outra pessoa (o topo e os textos mostram o nome dela)
  group?: string; // grupo: o nome dele
  onCall?: () => void;
}) {
  const { channel, guild, state, dispatch, gateway, onOpenChannel, dm, group, onCall } = props;
  const messages = state.messages[channel.id];
  const me = state.user!;
  const [shownBlocked, setShownBlocked] = useState<Set<string>>(new Set());
  const members = guild.members;
  const canSend = can(guild, me.id, P.SEND_MESSAGES, channel.id);
  const canAttach = canSend && can(guild, me.id, P.ATTACH_FILES, channel.id);
  const [hasMore, setHasMore] = useState(true);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [panel, setPanel] = useState<null | 'pins' | 'search'>(null);
  const [dragging, setDragging] = useState(false);
  const composer = useRef<ComposerApi | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  // "Novas mensagens": o que ainda não tinha lido quando abriu o canal.
  const readAtOpen = useMemo(() => lastRead(channel.id), [channel.id]);

  useEffect(() => {
    setActiveChannel(channel.id);
    return () => setActiveChannel(null);
  }, [channel.id]);

  useEffect(() => {
    api<Message[]>('GET', `/channels/${channel.id}/messages?limit=50`).then((m) => {
      dispatch({ t: 'MESSAGES_LOADED', d: { channel_id: channel.id, messages: m, older: false } });
      setHasMore(m.length === 50);
    });
  }, [channel.id, dispatch]);

  // Marca como lido o que está na tela (e de novo quando a janela volta ao foco).
  const lastId = messages?.[messages.length - 1]?.id;
  useEffect(() => {
    const read = () => document.hasFocus() && !document.hidden && markRead(channel.id, lastId ?? channel.last_message_id);
    read();
    window.addEventListener('focus', read);
    return () => window.removeEventListener('focus', read);
  }, [channel.id, lastId, channel.last_message_id]);

  useLayoutEffect(() => {
    const el = listRef.current;
    if (pendingJump && jumpTo(pendingJump)) {
      pendingJump = null;
      stick.current = false;
      return;
    }
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

  const jump = (m: Message) => {
    setPanel(null);
    if (m.channel_id !== channel.id) {
      pendingJump = m.id;
      onOpenChannel(m.channel_id);
    } else if (!jumpTo(m.id)) toast('Essa mensagem é antiga: role para cima para carregar.');
  };

  const editLast = () => {
    const mine = [...(messages ?? [])].reverse().find((m) => m.author.id === me.id);
    if (mine) void editMessage(mine);
  };

  const typingNames = Object.keys(state.typing[channel.id] ?? {})
    .map((id) => members.find((m) => m.id === id)?.display_name)
    .filter(Boolean);
  const firstNew = messages?.find((m) => m.id > readAtOpen && m.author.id !== me.id)?.id;

  return (
    <div
      className="chat"
      onDragOver={(e) => {
        if (!canAttach || ![...e.dataTransfer.types].includes('Files')) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        composer.current?.addFiles([...e.dataTransfer.files]);
      }}
    >
      <header className="topbar">
        {group ? (
          <>
            <span className="hash"><Users size={20} /></span>
            <span className="dm-title">{group}</span>
            <span className="topic">{guild.members.length} pessoas</span>
          </>
        ) : dm ? (
          <>
            <span className="hash"><AtSign size={20} /></span>
            <span className="dm-title" onClick={(e) => openProfile(dm, e)}>{dm.display_name}</span>
            {dm.custom_status && <span className="topic" title={dm.custom_status}>{dm.custom_status}</span>}
          </>
        ) : (
          <>
            <span className="hash"><Hash size={20} /></span> {channel.name}
            {channel.topic && <span className="topic" title={channel.topic}>{channel.topic}</span>}
          </>
        )}
        <div className="topbar-end">
          {onCall && <button className="icon small" title={group ? 'Começar chamada do grupo' : `Ligar para ${dm?.display_name ?? ''}`} onClick={onCall}><Phone size={18} /></button>}
          <button className={`icon small ${panel === 'pins' ? 'on' : ''}`} title="Mensagens fixadas" onClick={() => setPanel((p) => (p === 'pins' ? null : 'pins'))}><Pin size={18} /></button>
          <SearchBox guild={guild} label={dm || group ? 'Buscar na conversa' : undefined} onResults={() => setPanel('search')} />
        </div>
      </header>
      <div className="chat-main">
        <div className="chat-column">
          <div className="messages" ref={listRef} onScroll={onScroll}>
            {!hasMore &&
              (group ? (
                <div className="channel-start dm-start">
                  <span className="group-icon placeholder" style={{ width: 72, height: 72 }}><Users size={40} /></span>
                  <h2>{group}</h2>
                  <p>Este é o começo do grupo. Chame mais amigos pelo botão Adicionar ao lado.</p>
                </div>
              ) : dm ? (
                <div className="channel-start dm-start">
                  <Avatar user={dm} size={72} />
                  <h2>{dm.display_name}</h2>
                  <p>Este é o começo da sua conversa direta com <strong>@{dm.username}</strong>.</p>
                </div>
              ) : (
                <div className="channel-start"><h2>Bem-vindo a #{channel.name}!</h2><p>Este é o começo do canal.</p></div>
              ))}
            {messages?.map((m, i) => {
              const prev = messages[i - 1];
              const grouped = !m.reply && prev && prev.author.id === m.author.id && m.created_at - prev.created_at < 5 * 60_000 && m.id !== firstNew;
              return (
                <div key={m.id}>
                  {m.id === firstNew && <div className="new-divider"><span>NOVAS</span></div>}
                  {state.relationships[m.author.id]?.type === 'blocked' && !shownBlocked.has(m.id) ? (
                    prev && state.relationships[prev.author.id]?.type === 'blocked' && !shownBlocked.has(prev.id) ? null : (
                      <div className="blocked-msg">
                        <Ban size={14} /> Mensagem de alguém que você bloqueou.
                        <button className="link" onClick={() => setShownBlocked((x) => new Set([...x, ...blockedRun(messages, i, state)]))}>Mostrar</button>
                      </div>
                    )
                  ) : <MessageRow
                    msg={m}
                    grouped={!!grouped}
                    mine={m.author.id === me.id}
                    me={me}
                    members={members}
                    canManage={can(guild, me.id, P.MANAGE_MESSAGES, channel.id)}
                    color={nameColor(guild, m.author.id)}
                    onReply={() => (setReplyTo(m), composer.current?.focus())}
                    onJump={jump}
                  />}
                </div>
              );
            })}
          </div>
          {!canSend ? (
            <div className="composer-locked">Você não tem permissão para mandar mensagens neste canal.</div>
          ) : <Composer
            apiRef={composer}
            channel={channel}
            canAttach={canAttach}
            placeholder={group ? `Conversar em ${group}` : dm ? `Conversar com @${dm.display_name}` : undefined}
            members={members}
            me={me}
            replyTo={replyTo}
            onCancelReply={() => setReplyTo(null)}
            onSent={() => ((stick.current = true), setReplyTo(null))}
            onTyping={() => gateway.send({ op: 'typing', channel_id: channel.id })}
            onEditLast={editLast}
            onCommand={(raw) => runMusicCommand(raw, gateway, !!state.voice[me.id])}
          />}
          <div className="typing">{typingNames.length > 0 && `${typingNames.join(', ')} ${typingNames.length > 1 ? 'estão' : 'está'} digitando…`}</div>
        </div>
        {panel === 'pins' && <PinsPanel channel={channel} members={members} me={me} onJump={jump} onClose={() => setPanel(null)} pinnedVersion={messages?.filter((m) => m.pinned).map((m) => m.id).join()} />}
        {panel === 'search' && <SearchPanel guild={guild} members={members} me={me} onJump={jump} onClose={() => setPanel(null)} />}
      </div>
      {dragging && (
        <div className="drop-overlay">
          <div><PlusCircle size={40} /><h3>Enviar para {dm ? dm.display_name : `#${channel.name}`}</h3><p>Até {MAX_FILES} arquivos de 8 MB.</p></div>
        </div>
      )}
    </div>
  );
}

function toast(text: string) {
  void import('./toast').then((t) => t.toast(text));
}

async function editMessage(msg: Message) {
  const content = await ask('Editar mensagem', { value: msg.content, okText: 'Salvar' });
  if (content && content !== msg.content) await api('PATCH', `/messages/${msg.id}`, { content }).catch((e) => alert(e.message));
}

// ---------------------------------------------------------------- Caixa de mensagem
type ComposerApi = { focus: () => void; addFiles: (files: File[]) => void };

function Composer({ apiRef, channel, canAttach, placeholder, members, me, replyTo, onCancelReply, onSent, onTyping, onEditLast, onCommand }: {
  apiRef: React.MutableRefObject<ComposerApi | null>;
  channel: Channel;
  canAttach: boolean;
  placeholder?: string;
  members: User[];
  me: User;
  replyTo: Message | null;
  onCancelReply: () => void;
  onSent: () => void;
  onTyping: () => void;
  onEditLast: () => void;
  onCommand: (raw: string) => boolean; // comandos de música (/play…): true = tratado, não vira mensagem
}) {
  const s = useSettings();
  const [cmdSel, setCmdSel] = useState(0);
  const [text, setText] = useState('');
  const [files, setFiles] = useState<Pending[]>([]);
  const [sending, setSending] = useState(false);
  const [emoji, setEmoji] = useState(false);
  const [mention, setMention] = useState<{ q: string; start: number; sel: number } | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const lastTyping = useRef(0);
  const caret = useRef<number | null>(null); // onde pôr o cursor depois de inserir algo

  // Rascunho por canal, como no Discord.
  useEffect(() => {
    setText(drafts.get(channel.id) ?? '');
    setFiles([]);
  }, [channel.id]);
  useEffect(() => void drafts.set(channel.id, text), [channel.id, text]);

  // Altura cresce com o texto (até um limite).
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
    if (caret.current !== null) {
      el.focus();
      el.setSelectionRange(caret.current, caret.current);
      caret.current = null;
    }
  }, [text]);

  const addFiles = async (list: File[]) => {
    if (!canAttach) return toast('Você não tem permissão para mandar arquivos neste canal.');
    const room = MAX_FILES - files.length;
    if (list.length > room) toast(`Dá para mandar até ${MAX_FILES} arquivos por mensagem.`);
    const ok: Pending[] = [];
    for (const f of list.slice(0, Math.max(0, room))) {
      if (f.size > MAX_FILE) {
        toast(`${f.name} passa de 8 MB.`);
        continue;
      }
      const data = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
        r.onerror = () => reject(r.error);
        r.readAsDataURL(f);
      });
      ok.push({ key: Math.random().toString(36).slice(2), name: f.name || 'arquivo', type: f.type || 'application/octet-stream', size: f.size, data, preview: f.type.startsWith('image/') ? URL.createObjectURL(f) : undefined });
    }
    setFiles((cur) => [...cur, ...ok].slice(0, MAX_FILES));
    area.current?.focus();
  };

  apiRef.current = { focus: () => area.current?.focus(), addFiles: (f) => void addFiles(f) };

  const candidates = useMemo(() => {
    if (!mention) return [];
    const q = mention.q.toLowerCase();
    const people = members
      .filter((m) => m.id !== me.id && (`${m.username} ${m.display_name}`.toLowerCase().includes(q)))
      .slice(0, 8)
      .map((m) => ({ key: m.id, insert: `@${m.username} `, user: m as User | null, label: m.display_name, sub: `@${m.username}` }));
    if ('todos'.startsWith(q)) people.push({ key: 'todos', insert: '@todos ', user: null, label: '@todos', sub: 'Avisa todo mundo do servidor' });
    return people;
  }, [mention, members, me.id]);

  const updateMention = (value: string, at: number) => {
    const m = /(^|\s)@([\p{L}\p{N}_.]*)$/u.exec(value.slice(0, at));
    setMention(m ? { q: m[2], start: at - m[2].length - 1, sel: 0 } : null);
  };

  const pick = (i: number) => {
    const c = candidates[i];
    const el = area.current;
    if (!c || !mention || !el) return;
    const next = text.slice(0, mention.start) + c.insert + text.slice(el.selectionStart);
    caret.current = mention.start + c.insert.length;
    setText(next);
    setMention(null);
  };

  const insert = (str: string) => {
    const el = area.current;
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? text.length;
    caret.current = start + str.length;
    setText(text.slice(0, start) + str + text.slice(end));
  };

  // Digitando "/" no começo: sugere os comandos de música, como os bots do Discord.
  const cmdQuery = /^\/(\w*)$/.exec(text)?.[1]?.toLowerCase();
  const commands = cmdQuery === undefined ? [] : MUSIC_COMMANDS.filter((c) => c.name.startsWith(cmdQuery));
  const pickCommand = (i: number) => {
    const c = commands[i];
    if (!c) return;
    caret.current = c.name.length + 2;
    setText(`/${c.name} `);
    setCmdSel(0);
  };

  const send = async () => {
    const raw = text.trim();
    if ((!raw && !files.length) || sending) return;
    if (raw.startsWith('/') && !files.length && onCommand(raw)) {
      setText('');
      return;
    }
    const content = getSettings().convertEmoticons ? convertEmoticons(raw) : raw;
    setSending(true);
    try {
      await api('POST', `/channels/${channel.id}/messages`, {
        content,
        reply_to: replyTo?.id ?? null,
        attachments: files.map(({ name, type, data }) => ({ name, type, data })),
      });
      files.forEach((f) => f.preview && URL.revokeObjectURL(f.preview));
      setText('');
      setFiles([]);
      onSent();
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (commands.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const d = e.key === 'ArrowDown' ? 1 : -1;
        setCmdSel((cmdSel + d + commands.length) % commands.length);
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !commands.some((c) => c.name === cmdQuery && !c.args))) {
        e.preventDefault();
        return pickCommand(Math.min(cmdSel, commands.length - 1));
      }
    }
    if (mention && candidates.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const d = e.key === 'ArrowDown' ? 1 : -1;
        setMention({ ...mention, sel: (mention.sel + d + candidates.length) % candidates.length });
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        return pick(mention.sel);
      }
      if (e.key === 'Escape') return setMention(null);
    }
    if (e.key === 'Escape' && replyTo) return onCancelReply();
    if (e.key === 'ArrowUp' && !text) {
      e.preventDefault();
      return onEditLast();
    }
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      const wantsSend = s.sendOnEnter ? !e.shiftKey : e.ctrlKey || e.metaKey;
      if (wantsSend) {
        e.preventDefault();
        void send();
      }
    }
  };

  const replyAuthor = replyTo && (members.find((m) => m.id === replyTo.author.id) ?? replyTo.author);

  return (
    <div className="composer">
      {replyTo && replyAuthor && (
        <div className="reply-bar">
          <span>Respondendo a <strong>{replyAuthor.display_name}</strong></span>
          <button className="icon small" title="Cancelar (Esc)" onClick={onCancelReply}><X size={16} /></button>
        </div>
      )}
      {files.length > 0 && (
        <div className="pending-files">
          {files.map((f) => (
            <div key={f.key} className="pending-file">
              {f.preview ? <img src={f.preview} alt="" /> : <FileIcon size={40} />}
              <span title={f.name}>{f.name}</span>
              <small className="muted">{fmtSize(f.size)}</small>
              <button className="icon small danger" title="Tirar" onClick={() => setFiles((cur) => cur.filter((x) => x.key !== f.key))}><Trash2 size={14} /></button>
            </div>
          ))}
        </div>
      )}
      {commands.length > 0 && (
        <div className="mention-popup">
          <small className="muted">Comandos de música</small>
          {commands.map((c, i) => (
            <button key={c.name} className={i === Math.min(cmdSel, commands.length - 1) ? 'active' : ''} onMouseDown={(e) => (e.preventDefault(), pickCommand(i))} onMouseEnter={() => setCmdSel(i)}>
              <span className="mention-all"><Music size={14} /></span>
              <strong>/{c.name}</strong> {c.args && <small className="muted">{c.args}</small>}
              <small className="muted cmd-desc">{c.desc}</small>
            </button>
          ))}
        </div>
      )}
      {mention && candidates.length > 0 && (
        <div className="mention-popup">
          <small className="muted">Membros</small>
          {candidates.map((c, i) => (
            <button key={c.key} className={i === mention.sel ? 'active' : ''} onMouseDown={(e) => (e.preventDefault(), pick(i))} onMouseEnter={() => setMention({ ...mention, sel: i })}>
              {c.user ? <Avatar user={c.user} size={24} /> : <span className="mention-all">@</span>}
              <strong>{c.label}</strong> <small className="muted">{c.sub}</small>
            </button>
          ))}
        </div>
      )}
      {emoji && (
        <div className="composer-emoji">
          <EmojiPicker onPick={(e) => insert(e)} onClose={() => setEmoji(false)} />
        </div>
      )}
      <div className={`composer-box ${replyTo ? 'replying' : ''}`}>
        {canAttach && <button className="icon composer-btn" title="Mandar arquivo" onClick={() => fileInput.current?.click()}><PlusCircle size={22} /></button>}
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            void addFiles([...(e.target.files ?? [])]);
            e.target.value = '';
          }}
        />
        <textarea
          ref={area}
          rows={1}
          value={text}
          maxLength={4000}
          placeholder={placeholder ?? `Conversar em #${channel.name}`}
          onChange={(e) => {
            setText(e.target.value);
            updateMention(e.target.value, e.target.selectionStart);
            if (e.target.value && Date.now() - lastTyping.current > 6000) {
              lastTyping.current = Date.now();
              onTyping();
            }
          }}
          onKeyDown={onKeyDown}
          onBlur={() => setTimeout(() => setMention(null), 100)}
          onPaste={(e) => {
            const pasted = [...e.clipboardData.files];
            if (pasted.length) {
              e.preventDefault();
              void addFiles(pasted);
            }
          }}
        />
        <button className="icon composer-btn" title="Emoji" onClick={() => setEmoji((v) => !v)}><Smile size={22} /></button>
      </div>
    </div>
  );
}
const drafts = new Map<string, string>();

// ---------------------------------------------------------------- Seletor de emoji
export function EmojiPicker({ onPick, onClose }: { onPick: (e: string) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [q, setQ] = useState('');
  useEffect(() => {
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)) onClose();
    };
    const t = setTimeout(() => (window.addEventListener('mousedown', close), window.addEventListener('keydown', close)));
    return () => {
      clearTimeout(t);
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', close);
    };
  }, [onClose]);
  const recent = getRecent();
  const shown: [string, string[]][] = q
    ? [['Resultado', ALL_EMOJIS.filter((e) => (EMOJI_NAMES[e] ?? '').includes(q.toLowerCase()))]]
    : [...(recent.length ? [['Usados recentemente', recent] as [string, string[]]] : []), ...EMOJI_GROUPS];
  const choose = (e: string) => {
    pushRecent(e);
    onPick(e);
  };
  return (
    <div className="emoji-panel" ref={ref}>
      <input autoFocus placeholder="Procurar emoji (ex.: riso, fogo, coração)" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="emoji-scroll">
        {shown.map(([title, list]) => (
          <div key={title}>
            <small className="muted">{title}</small>
            <div className="emoji-grid">
              {list.map((e) => <button key={e} onClick={() => choose(e)}>{e}</button>)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
const RECENT_KEY = 'nexo.recentEmoji';
function getRecent(): string[] {
  try {
    return (JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as string[]).slice(0, 16);
  } catch {
    return [];
  }
}
function pushRecent(e: string) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([e, ...getRecent().filter((x) => x !== e)].slice(0, 16)));
  } catch {
    /* ignora */
  }
}
/** Palavras para a busca de emoji (em português). */
const EMOJI_NAMES: Record<string, string> = {
  '😀': 'feliz sorriso', '😄': 'feliz sorriso', '😁': 'sorriso dentes', '😆': 'riso rindo', '😅': 'riso suor', '😂': 'riso chorando rindo kkk', '🤣': 'riso rolando kkk',
  '🙂': 'sorriso', '😉': 'piscada', '😊': 'feliz vergonha', '😇': 'anjo', '🥰': 'amor apaixonado', '😍': 'amor apaixonado olhos coração', '🤩': 'estrela uau',
  '😘': 'beijo', '😋': 'gostoso delicia', '😛': 'lingua', '😜': 'lingua piscada', '🤪': 'doido maluco', '🤔': 'pensando hmm', '🤨': 'desconfiado',
  '😐': 'neutro', '😑': 'sem expressão', '🙄': 'revirando olhos', '😏': 'malicioso', '😬': 'tenso', '😮‍💨': 'alivio suspiro', '😌': 'aliviado', '😴': 'sono dormindo',
  '🤤': 'babando', '😷': 'mascara doente', '🤒': 'doente febre', '🥵': 'calor quente', '🥶': 'frio', '😵': 'tonto', '🤯': 'mente explodindo chocado', '🤠': 'cowboy',
  '🥳': 'festa aniversario', '😎': 'oculos legal', '🤓': 'nerd', '😕': 'confuso', '😟': 'preocupado', '🙁': 'triste', '😮': 'surpreso uau', '😲': 'chocado surpreso',
  '😳': 'vergonha corado', '🥺': 'pidao fofo', '😢': 'triste chorando', '😭': 'chorando choro', '😱': 'medo grito', '😤': 'bravo', '😡': 'raiva bravo', '🤬': 'xingando raiva',
  '💀': 'caveira morri', '🤡': 'palhaço', '👻': 'fantasma', '👽': 'alien', '🤖': 'robo', '💩': 'coco', '👍': 'joia legal sim like', '👎': 'nao deslike',
  '👌': 'ok perfeito', '✌️': 'paz', '🤞': 'sorte dedos cruzados', '🤟': 'amor rock', '🤘': 'rock', '🤙': 'liga', '👋': 'oi tchau aceno', '👏': 'palmas aplauso',
  '🙌': 'comemorar', '🙏': 'obrigado por favor reza', '💪': 'forte musculo', '🫡': 'continencia', '🫶': 'coração mãos amor', '👀': 'olhos vendo', '🧠': 'cerebro', '🤝': 'acordo aperto',
  '❤️': 'coração amor vermelho', '🧡': 'coração laranja', '💛': 'coração amarelo', '💚': 'coração verde', '💙': 'coração azul', '💜': 'coração roxo', '🖤': 'coração preto', '💔': 'coração partido',
  '💯': 'cem', '🔥': 'fogo', '✨': 'brilho', '⭐': 'estrela', '🎉': 'festa confete', '🎊': 'festa', '🎁': 'presente', '🏆': 'trofeu vitoria', '🎮': 'jogo game controle',
  '🎧': 'fone musica', '🎵': 'musica', '📢': 'aviso anuncio', '💡': 'ideia', '💰': 'dinheiro', '⚽': 'futebol bola', '🍕': 'pizza', '🍔': 'hamburguer lanche', '🍺': 'cerveja',
  '☕': 'cafe', '🚀': 'foguete', '⚡': 'raio', '🌈': 'arco iris', '☀️': 'sol', '🌙': 'lua noite', '✅': 'certo feito', '❌': 'errado nao', '⚠️': 'atenção aviso', '❓': 'pergunta',
  '❗': 'exclamação', '💤': 'sono',
};

// ---------------------------------------------------------------- Mensagem
export function MessageRow({ msg, grouped, mine, me, members, canManage, color, onReply, onJump, preview }: {
  msg: Message;
  grouped: boolean;
  mine: boolean;
  me: User;
  members: User[];
  canManage?: boolean;
  color?: string; // cor do cargo mais alto do autor
  onReply?: () => void;
  onJump?: (m: Message) => void;
  preview?: boolean; // dentro dos fixados/busca: sem ações
}) {
  const time = new Date(msg.created_at);
  const s = useSettings();
  const author = members.find((m) => m.id === msg.author.id) ?? msg.author; // perfil atualizado (foto, nome)
  const meUser = members.find((m) => m.id === me.id) ?? me;
  const mention = !mine && !preview && mentionsMe(msg.content, meUser);
  const hhmm = time.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', hour12: !s.use24h });
  const compact = s.messageDisplay === 'compact' && !preview;
  const [picker, setPicker] = useState(false);
  const react = async (emoji: string) => {
    setPicker(false);
    const on = !msg.reactions?.find((r) => r.emoji === emoji)?.user_ids.includes(me.id);
    if (on) playSound('reaction');
    await api('PUT', `/messages/${msg.id}/reactions/${encodeURIComponent(emoji)}`, { on }).catch((e) => alert(e.message));
  };
  const names = (ids: string[]) => ids.map((id) => members.find((m) => m.id === id)?.display_name ?? '?').join(', ');
  const remove = async () => {
    if (confirm('Apagar esta mensagem?')) await api('DELETE', `/messages/${msg.id}`).catch((e) => alert(e.message));
  };
  const pin = async () => {
    await api('PUT', `/messages/${msg.id}/pin`, { pinned: !msg.pinned }).catch((e) => alert(e.message));
  };
  const imageLinks = s.showLinks ? [...new Set(msg.content.match(/https?:\/\/\S+/g) ?? [])].filter((u) => IMAGE_URL.test(u)).slice(0, 4) : [];
  const replyAuthor = msg.reply && (members.find((m) => m.id === msg.reply!.author.id) ?? msg.reply.author);
  return (
    <div id={preview ? undefined : `msg-${msg.id}`} className={`message ${grouped && !compact ? 'grouped' : ''} ${compact ? 'compact' : ''} ${mention ? 'mention' : ''} ${msg.reply_to ? 'has-reply' : ''}`}>
      {msg.reply_to && (
        <div className="reply-ref" onClick={() => msg.reply && onJump?.({ ...msg, id: msg.reply.id } as Message)}>
          <CornerUpLeft size={14} />
          {msg.reply && replyAuthor ? (
            <>
              <Avatar user={replyAuthor} size={16} />
              <strong>{replyAuthor.display_name}</strong>
              <span>{msg.reply.content.replace(/(\*\*|__|~~|\|\||```|[*`])/g, '') || 'Clique para ver o anexo'}</span>
            </>
          ) : (
            <em className="muted">A mensagem original foi apagada.</em>
          )}
        </div>
      )}
      <div className="message-line">
        {compact ? (
          <span className="compact-time">{hhmm}</span>
        ) : grouped ? (
          <span className="gutter-time">{hhmm}</span>
        ) : (
          <span className="msg-avatar" onClick={(e) => openProfile(author, e)}><Avatar user={author} size={40} /></span>
        )}
        <div className="message-body">
          {compact && (
            <strong className="compact-author" onClick={(e) => openProfile(author, e)}>
              {s.showAvatars && <Avatar user={author} size={18} />} {author.display_name}
            </strong>
          )}
          {!grouped && !compact && (
            <div className="message-head">
              <strong className="author" style={{ color }} onClick={(e) => openProfile(author, e)}>{author.display_name}</strong>
              <small>{time.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short', hour12: !s.use24h })}</small>
              {msg.pinned && !preview && <Pin size={12} className="pinned-mark" aria-label="Fixada" />}
            </div>
          )}
          {msg.content && (
            <div className="message-content">
              <Markdown text={msg.content} members={members} meId={me.id} />
              {msg.edited_at && <small className="edited"> (editado)</small>}
            </div>
          )}
          {!preview && inviteCodes(msg.content).map((c) => <InviteEmbed key={c} code={c} />)}
          {!!msg.attachments?.length && (
            <div className="attachments">
              {msg.attachments.map((a) => <AttachmentView key={a.id} a={a} />)}
            </div>
          )}
          {imageLinks.map((u) => (
            <a key={u} className="embed-image" href={u} target="_blank" rel="noreferrer noopener"><img src={u} alt="" loading="lazy" onError={(e) => ((e.currentTarget.parentElement as HTMLElement).style.display = 'none')} /></a>
          ))}
          {s.showReactions && !!msg.reactions?.length && !preview && (
            <div className="reactions">
              {msg.reactions.map((r) => (
                <button key={r.emoji} className={`reaction ${r.user_ids.includes(me.id) ? 'mine' : ''}`} title={`Reagiram com ${r.emoji}: ${names(r.user_ids)}`} onClick={() => react(r.emoji)}>
                  <span className="reaction-emoji">{r.emoji}</span> {r.user_ids.length}
                </button>
              ))}
              <button className="reaction add" title="Adicionar reação" onClick={() => setPicker(true)}><SmilePlus size={14} /></button>
            </div>
          )}
        </div>
      </div>
      {picker && (
        <div className="message-emoji">
          <EmojiPicker onPick={react} onClose={() => setPicker(false)} />
        </div>
      )}
      {!preview && (
        <div className="message-actions">
          {['👍', '😂', '❤️'].map((e) => <button key={e} className="icon small quick-react" title={`Reagir com ${e}`} onClick={() => react(e)}>{e}</button>)}
          <button className="icon small" title="Reagir" onClick={() => setPicker((p) => !p)}><SmilePlus size={16} /></button>
          <button className="icon small" title="Responder" onClick={onReply}><CornerUpLeft size={16} /></button>
          {(mine || canManage) && <button className="icon small" title={msg.pinned ? 'Desafixar' : 'Fixar no canal'} onClick={pin}>{msg.pinned ? <PinOff size={16} /> : <Pin size={16} />}</button>}
          {mine && <button className="icon small" title="Editar" onClick={() => editMessage(msg)}><Pencil size={16} /></button>}
          {(mine || canManage) && <button className="icon small" title="Apagar" onClick={remove}><Trash2 size={16} /></button>}
        </div>
      )}
      {preview && onJump && <button className="jump" onClick={() => onJump(msg)}>Ir</button>}
    </div>
  );
}

function AttachmentView({ a }: { a: Attachment }) {
  const url = fileUrl(a.url);
  const [zoom, setZoom] = useState(false);
  if (/^image\/(png|jpeg|gif|webp)$/.test(a.type))
    return (
      <>
        <img className="attachment-image" src={url} alt={a.name} loading="lazy" onClick={() => setZoom(true)} />
        {zoom && (
          <div className="lightbox" onClick={() => setZoom(false)}>
            <img src={url} alt={a.name} />
            <a href={url} target="_blank" rel="noreferrer noopener" onClick={(e) => e.stopPropagation()}>Abrir original</a>
          </div>
        )}
      </>
    );
  if (/^video\/(mp4|webm)$/.test(a.type)) return <video className="attachment-video" src={url} controls preload="metadata" />;
  if (/^audio\//.test(a.type))
    return (
      <div className="attachment-file">
        <FileIcon size={28} /><div><a href={url} target="_blank" rel="noreferrer noopener">{a.name}</a><small className="muted">{fmtSize(a.size)}</small><audio src={url} controls preload="none" /></div>
      </div>
    );
  return (
    <div className="attachment-file">
      <FileIcon size={28} />
      <div>
        <a href={url} target="_blank" rel="noreferrer noopener" download={a.name}>{a.name}</a>
        <small className="muted">{fmtSize(a.size)}</small>
      </div>
    </div>
  );
}

/** Markdown mínimo: **negrito**, *itálico*, `código`, ||spoiler||, links e @menções. */
export function Markdown({ text, members, meId }: { text: string; members?: User[]; meId?: string }) {
  const s = useSettings();
  const parts = text.split(/(```[\s\S]+?```|\*\*[^*]+\*\*|\*[^*\n]+\*|__[^_]+__|~~[^~]+~~|`[^`]+`|\|\|[^|]+\|\||https?:\/\/\S+|@[\p{L}\p{N}_.]+)/gu);
  return (
    <>
      {parts.map((p, i) => {
        if (p.startsWith('```') && p.endsWith('```') && p.length > 6) return <pre key={i} className="code-block"><code>{p.slice(3, -3).replace(/^\w*\n/, '')}</code></pre>;
        if (p.startsWith('**') && p.endsWith('**') && p.length > 4) return <strong key={i}>{p.slice(2, -2)}</strong>;
        if (p.startsWith('__') && p.endsWith('__') && p.length > 4) return <u key={i}>{p.slice(2, -2)}</u>;
        if (p.startsWith('~~') && p.endsWith('~~') && p.length > 4) return <s key={i}>{p.slice(2, -2)}</s>;
        if (p.startsWith('||') && p.endsWith('||') && p.length > 4) return <Spoiler key={i} text={p.slice(2, -2)} always={s.spoilers === 'always'} />;
        if (p.startsWith('*') && p.endsWith('*') && p.length > 2) return <em key={i}>{p.slice(1, -1)}</em>;
        if (p.startsWith('`') && p.endsWith('`') && p.length > 2) return <code key={i}>{p.slice(1, -1)}</code>;
        if (/^https?:\/\//.test(p) && !s.showLinks) return <span key={i}>{p}</span>;
        if (/^https?:\/\//.test(p)) return <a key={i} href={p} target="_blank" rel="noreferrer noopener">{p}</a>;
        if (p.startsWith('@')) {
          const name = p.slice(1).toLowerCase();
          if (name === 'todos' || name === 'everyone') return <span key={i} className="mention-chip">{p}</span>;
          const u = members?.find((m) => m.username.toLowerCase() === name);
          if (u)
            return (
              <span key={i} className={`mention-chip ${u.id === meId ? 'me' : ''}`} onClick={(e) => openProfile(u, e)}>@{u.display_name}</span>
            );
        }
        return <span key={i}>{p}</span>;
      })}
    </>
  );
}
function Spoiler({ text, always }: { text: string; always?: boolean }) {
  const [open, setOpen] = useState(!!always);
  return <span className={`spoiler ${open ? 'open' : ''}`} onClick={() => setOpen(true)}>{text}</span>;
}

// ---------------------------------------------------------------- Fixadas e busca
function PinsPanel({ channel, members, me, onJump, onClose, pinnedVersion }: { channel: Channel; members: User[]; me: User; onJump: (m: Message) => void; onClose: () => void; pinnedVersion?: string }) {
  const [list, setList] = useState<Message[] | null>(null);
  useEffect(() => {
    api<Message[]>('GET', `/channels/${channel.id}/pins`).then(setList).catch(() => setList([]));
  }, [channel.id, pinnedVersion]);
  return (
    <aside className="side-panel">
      <header><Pin size={16} /> <strong>Mensagens fixadas</strong><button className="icon small" onClick={onClose}><X size={16} /></button></header>
      <div className="side-panel-list">
        {list === null && <p className="muted">Carregando…</p>}
        {list?.length === 0 && <p className="muted empty">Nenhuma mensagem fixada neste canal ainda. Passe o mouse numa mensagem e clique no alfinete.</p>}
        {list?.map((m) => <MessageRow key={m.id} msg={m} grouped={false} mine={m.author.id === me.id} me={me} members={members} preview onJump={onJump} />)}
      </div>
    </aside>
  );
}

let searchHandler: ((q: string) => void) | null = null;
function SearchBox({ guild, label, onResults }: { guild: Guild; label?: string; onResults: () => void }) {
  const [q, setQ] = useState('');
  return (
    <form
      className="search-box"
      onSubmit={(e) => {
        e.preventDefault();
        if (!q.trim()) return;
        onResults();
        setTimeout(() => searchHandler?.(q.trim()));
      }}
    >
      <input placeholder={label ?? `Buscar em ${guild.name}`} value={q} onChange={(e) => setQ(e.target.value)} />
      <Search size={14} />
    </form>
  );
}

function SearchPanel({ guild, members, me, onJump, onClose }: { guild: Guild; members: User[]; me: User; onJump: (m: Message) => void; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [list, setList] = useState<Message[] | null>(null);
  useEffect(() => {
    searchHandler = (query) => {
      setQ(query);
      setList(null);
      api<Message[]>('GET', `/guilds/${guild.id}/search?q=${encodeURIComponent(query)}`).then(setList).catch(() => setList([]));
    };
    return () => void (searchHandler = null);
  }, [guild.id]);
  const chName = (id: string) => guild.channels.find((c) => c.id === id)?.name ?? '?';
  return (
    <aside className="side-panel">
      <header><Search size={16} /> <strong>{list ? `${list.length} resultado${list.length === 1 ? '' : 's'}` : 'Buscando…'}</strong><button className="icon small" onClick={onClose}><X size={16} /></button></header>
      <div className="side-panel-list">
        {list?.length === 0 && <p className="muted empty">Nada encontrado para "{q}".</p>}
        {list?.map((m) => (
          <div key={m.id}>
            <small className="muted search-channel"># {chName(m.channel_id)}</small>
            <MessageRow msg={m} grouped={false} mine={m.author.id === me.id} me={me} members={members} preview onJump={onJump} />
          </div>
        ))}
      </div>
    </aside>
  );
}

/** Mensagens seguidas de pessoas bloqueadas a partir da posição i (o "Mostrar" abre todas juntas). */
function blockedRun(messages: Message[], i: number, state: State) {
  const ids: string[] = [];
  for (let j = i; j < messages.length && state.relationships[messages[j].author.id]?.type === 'blocked'; j++) ids.push(messages[j].id);
  return ids;
}
