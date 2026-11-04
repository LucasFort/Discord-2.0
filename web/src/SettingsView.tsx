import { useEffect, useRef, useState } from 'react';
import {
  Accessibility, Bell, Contact, Keyboard, LogOut, MessageSquare, Mic, Monitor, MonitorUp, Palette, Radio, Settings as Gear, User as UserIcon, Video, Volume2, X,
} from 'lucide-react';
import type { User, UserStatus } from './api';
import {
  AccessibilitySettings, AccountSettings, AppearanceSettings, ChatSettings, DesktopNotifySettings, KeybindList, ProfileSettings, StreamerSettings, WindowsSettings,
} from './UserSettings';
import { MicProcessor, newAudioContext } from './mic';
import { useShortcutStatus } from './shortcuts';
import { comboFromEvent, comboName, keyName, micConstraints, resetVoiceSettings, updateSettings, useSettings, type Settings } from './settings';
import { activeMic, CODECS, FPS_OPTIONS, RESOLUTIONS, shareBitrate, type ShareCodec, type ShareResolution } from './voice';
import { setSoundsEnabled, soundsEnabled, playSound, SOUND_LABELS, type SoundName } from './sounds';

type Tab = 'account' | 'profile' | 'appearance' | 'accessibility' | 'voice' | 'video' | 'stream' | 'chat' | 'notify' | 'keybinds' | 'streamer' | 'windows';

const GROUPS: { title: string; tabs: [Tab, string, JSX.Element][] }[] = [
  { title: 'Configurações de usuário', tabs: [['account', 'Minha conta', <UserIcon size={16} />], ['profile', 'Perfis', <Contact size={16} />]] },
  {
    title: 'Configurações do app',
    tabs: [
      ['appearance', 'Aparência', <Palette size={16} />],
      ['accessibility', 'Acessibilidade', <Accessibility size={16} />],
      ['voice', 'Voz', <Mic size={16} />],
      ['video', 'Vídeo', <Video size={16} />],
      ['stream', 'Transmissão', <MonitorUp size={16} />],
      ['chat', 'Chat', <MessageSquare size={16} />],
      ['notify', 'Notificações', <Bell size={16} />],
      ['keybinds', 'Atalhos', <Keyboard size={16} />],
      ['streamer', 'Modo streamer', <Radio size={16} />],
      ['windows', 'Configurações do Windows', <Monitor size={16} />],
    ],
  },
];

/** Tela de configurações no estilo do Discord: conta e perfil, aparência, voz, vídeo, chat, notificações… */
export function SettingsView({ onClose, tab: initialTab, user, status, onLogout }: {
  onClose: () => void;
  tab?: string;
  user: User;
  status: UserStatus;
  onLogout: () => void;
}) {
  const [tab, setTab] = useState<Tab>(GROUPS.some((g) => g.tabs.some(([t]) => t === initialTab)) ? (initialTab as Tab) : 'account');
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="settings">
      <nav className="settings-nav">
        {GROUPS.map((g) => (
          <div key={g.title} className="settings-group">
            <h3>{g.title}</h3>
            {g.tabs.map(([t, label, icon]) => (
              <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>{icon} {label}</button>
            ))}
          </div>
        ))}
        <div className="settings-group">
          <button className="danger-text" onClick={onLogout}><LogOut size={16} /> Sair da conta</button>
        </div>
      </nav>
      <section className="settings-body">
        {tab === 'account' && <AccountSettings user={user} status={status} onLogout={onLogout} onEditProfile={() => setTab('profile')} />}
        {tab === 'profile' && <ProfileSettings key={user.id} user={user} status={status} />}
        {tab === 'appearance' && <AppearanceSettings />}
        {tab === 'accessibility' && <AccessibilitySettings />}
        {tab === 'voice' && <VoiceSettings />}
        {tab === 'video' && <VideoSettings />}
        {tab === 'stream' && <StreamSettings />}
        {tab === 'chat' && <ChatSettings />}
        {tab === 'notify' && <NotifySettings />}
        {tab === 'keybinds' && <KeybindList onEdit={() => setTab('voice')} />}
        {tab === 'streamer' && <StreamerSettings />}
        {tab === 'windows' && <WindowsSettings />}
      </section>
      <button className="settings-close" title="Fechar (Esc)" onClick={onClose}><X size={20} /><small>ESC</small></button>
    </div>
  );
}

function useDevices(kind: MediaDeviceKind) {
  const [list, setList] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    const load = () => navigator.mediaDevices?.enumerateDevices().then((d) => setList(d.filter((x) => x.kind === kind && x.deviceId !== 'default' && x.deviceId !== 'communications')));
    load();
    navigator.mediaDevices?.addEventListener('devicechange', load);
    return () => navigator.mediaDevices?.removeEventListener('devicechange', load);
  }, [kind]);
  return [list, () => navigator.mediaDevices?.enumerateDevices().then((d) => setList(d.filter((x) => x.kind === kind && x.deviceId !== 'default' && x.deviceId !== 'communications')))] as const;
}

function DeviceSelect({ kind, value, onChange, label }: { kind: MediaDeviceKind; value: string; onChange: (id: string) => void; label: string }) {
  const [devices] = useDevices(kind);
  return (
    <label className="field">
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Padrão do sistema</option>
        {devices.map((d, i) => (
          <option key={d.deviceId} value={d.deviceId}>{d.label || `Dispositivo ${i + 1}`}</option>
        ))}
      </select>
    </label>
  );
}

function Toggle({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
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

/** Teste de microfone: abre o microfone com as mesmas configurações da call e mede o nível. */
function useMicTest(on: boolean, loopback: boolean, s: Settings) {
  const proc = useRef<MicProcessor | null>(null);
  const [error, setError] = useState('');
  const constraintsKey = JSON.stringify(micConstraints(s));
  useEffect(() => {
    if (!on) return;
    let stream: MediaStream | null = null;
    let ctx: AudioContext | null = null;
    let audio: HTMLAudioElement | null = null;
    let cancelled = false;
    const p = new MicProcessor();
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: micConstraints(s) as MediaTrackConstraints });
        if (cancelled) return stream.getTracks().forEach((t) => t.stop());
        ctx = newAudioContext();
        await p.init({ kind: 'audio' as never, track: stream.getAudioTracks()[0], audioContext: ctx });
        proc.current = p;
        setError('');
        if (loopback && p.processedTrack) {
          audio = new Audio();
          audio.srcObject = new MediaStream([p.processedTrack]);
          const el = audio as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
          if (s.outputDeviceId && el.setSinkId) await el.setSinkId(s.outputDeviceId).catch(() => {});
          audio.volume = Math.min(1, s.outputVolume / 100);
          await audio.play().catch(() => {});
        }
      } catch (e) {
        setError(`Não deu para abrir o microfone: ${(e as Error).message}`);
      }
    })();
    return () => {
      cancelled = true;
      proc.current = null;
      void p.destroy();
      audio?.pause();
      stream?.getTracks().forEach((t) => t.stop());
      void ctx?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, loopback, constraintsKey, s.outputDeviceId]);
  return { proc, error };
}

function Meter({ source, s }: { source: () => MicProcessor | null; s: Settings }) {
  const [m, setM] = useState({ level: -100, raw: -100, boost: 0, open: false, peak: -100, active: false });
  const since = useRef(0);
  useEffect(() => {
    let raf = 0;
    let last = 0;
    const loop = (t: number) => {
      raf = requestAnimationFrame(loop);
      if (t - last < 50) return;
      last = t;
      const p = source();
      if (!p) {
        since.current = 0;
        return setM({ level: -100, raw: -100, boost: 0, open: false, peak: -100, active: false });
      }
      since.current ||= t;
      setM({ level: p.level, raw: p.rawLevel, boost: p.boostDb, open: p.open, peak: p.speechPeak, active: t - since.current > 4000 });
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [source]);
  const pct = (db: number) => `${Math.max(0, Math.min(100, db + 100))}%`;
  // Avisos só depois de alguns segundos de teste.
  const silent = m.active && m.raw <= -99;
  const quiet = m.active && !silent && m.peak < -60;
  return (
    <>
      <div className={`meter ${m.open ? 'open' : ''}`}>
        <div className="meter-fill" style={{ width: pct(m.level) }} />
        {s.inputMode === 'voice' && !s.autoSensitivity && <div className="meter-mark" style={{ left: pct(s.sensitivity) }} />}
      </div>
      <small className="muted meter-info">
        {m.raw > -100 ? `Microfone: ${Math.round(m.raw)} dB` : 'Sem sinal'}
        {m.boost >= 1 && ` · amplificando +${Math.round(m.boost)} dB`}
        {m.open ? ' · enviando' : ''}
      </small>
      {silent && <p className="warn-box">Nenhum som está chegando deste microfone. Confira se escolheu o aparelho certo em "Dispositivo de entrada" e se ele não está mutado no Windows.</p>}
      {quiet && (
        <p className="warn-box">
          Seu microfone está muito baixo. O Nexo já está amplificando, mas para ficar melhor: no Windows, abra Configurações &gt; Sistema &gt; Som &gt;
          seu microfone e suba o "Volume de entrada" (ou "Aumento do microfone" nas propriedades).
        </p>
      )}
    </>
  );
}

function VoiceSettings() {
  const s = useSettings();
  const shortcutStatus = useShortcutStatus();
  const [testing, setTesting] = useState(false);
  const [loopback, setLoopback] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const { proc, error } = useMicTest(testing, loopback, s);
  const meterSource = useRef(() => proc.current ?? activeMic).current;

  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      updateSettings({ pttKey: e.code === 'Escape' ? '' : e.code });
      setCapturing(false);
    };
    window.addEventListener('keydown', onKey, { capture: true, once: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [capturing]);

  return (
    <>
      <h2>Voz</h2>
      <div className="field-row">
        <DeviceSelect kind="audioinput" label="Dispositivo de entrada" value={s.inputDeviceId} onChange={(v) => updateSettings({ inputDeviceId: v })} />
        <DeviceSelect kind="audiooutput" label="Dispositivo de saída" value={s.outputDeviceId} onChange={(v) => updateSettings({ outputDeviceId: v })} />
      </div>
      <div className="field-row">
        <label className="field">
          <span>Volume de entrada · {s.inputVolume}%</span>
          <input type="range" min={0} max={200} value={s.inputVolume} onChange={(e) => updateSettings({ inputVolume: +e.target.value })} />
        </label>
        <label className="field">
          <span>Volume de saída · {s.outputVolume}%</span>
          <input type="range" min={0} max={100} value={s.outputVolume} onChange={(e) => updateSettings({ outputVolume: +e.target.value })} />
        </label>
      </div>

      <h3>Teste de microfone</h3>
      <p className="muted">Fale alguma coisa: a barra mostra o volume da sua voz. Fica verde quando o som está sendo enviado.</p>
      <div className="mic-test">
        <button className={testing ? '' : 'primary'} onClick={() => setTesting((t) => !t)}>{testing ? 'Parar teste' : 'Vamos verificar'}</button>
        <label className="check"><input type="checkbox" checked={loopback} onChange={(e) => setLoopback(e.target.checked)} /> Ouvir minha voz (use fone)</label>
      </div>
      <Meter source={meterSource} s={s} />
      {error && <p className="error">{error}</p>}

      <h3>Modo de entrada</h3>
      <div className="options">
        <button className={`option ${s.inputMode === 'voice' ? 'selected' : ''}`} onClick={() => updateSettings({ inputMode: 'voice' })}>Detecção de voz</button>
        <button className={`option ${s.inputMode === 'ptt' ? 'selected' : ''}`} onClick={() => updateSettings({ inputMode: 'ptt' })}>Aperte para falar</button>
      </div>
      {s.inputMode === 'voice' ? (
        <>
          <Toggle label="Determinar sensibilidade automaticamente" checked={s.autoSensitivity} onChange={(v) => updateSettings({ autoSensitivity: v })} />
          {!s.autoSensitivity && (
            <label className="field">
              <span>Sensibilidade de entrada · {s.sensitivity} dB (o que ficar abaixo da marca não é enviado)</span>
              <input type="range" min={-100} max={0} value={s.sensitivity} onChange={(e) => updateSettings({ sensitivity: +e.target.value })} />
            </label>
          )}
        </>
      ) : (
        <div className="field-row">
          <div className="field">
            <span>Tecla de atalho</span>
            <button className={`keybind ${capturing ? 'capturing' : ''}`} onClick={() => setCapturing(true)}>
              {capturing ? 'Aperte uma tecla… (Esc limpa)' : keyName(s.pttKey)}
            </button>
            <small className="muted">Funciona com a janela do Nexo em foco.</small>
          </div>
          <label className="field">
            <span>Atraso ao soltar · {s.pttReleaseDelay} ms</span>
            <input type="range" min={0} max={1000} step={20} value={s.pttReleaseDelay} onChange={(e) => updateSettings({ pttReleaseDelay: +e.target.value })} />
          </label>
        </div>
      )}

      <h3>Atalhos</h3>
      <p className="muted">
        {shortcutStatus
          ? 'No app de computador os atalhos funcionam em qualquer lugar, até com o jogo em foco.'
          : 'No navegador os atalhos só funcionam com a aba do Nexo em foco. Para usar com o jogo aberto, use o app de computador (versão 0.1.2 ou mais nova).'}
      </p>
      <div className="field-row">
        <Keybind label="Mutar / desmutar" value={s.muteKey} global={shortcutStatus?.mute} onChange={(v) => updateSettings({ muteKey: v })} />
        <Keybind label="Ensurdecer / desensurdecer" value={s.deafenKey} global={shortcutStatus?.deafen} onChange={(v) => updateSettings({ deafenKey: v })} />
      </div>

      <h3>Processamento de voz</h3>
      <Toggle label="Amplificar microfone baixo automaticamente" hint="Aumenta sozinho o volume de microfones fracos para todo mundo te ouvir." checked={s.autoBoost} onChange={(v) => updateSettings({ autoBoost: v })} />
      <div className="field">
        <span>Supressão de ruído</span>
        <div className="options">
          <button className={`option ${s.strongNoiseSuppression && s.maxNoiseSuppression ? 'selected' : ''}`} onClick={() => updateSettings({ strongNoiseSuppression: true, maxNoiseSuppression: true, noiseSuppression: true })}>Máxima (IA, pode distorcer)</button>
          <button className={`option ${s.strongNoiseSuppression && !s.maxNoiseSuppression ? 'selected' : ''}`} onClick={() => updateSettings({ strongNoiseSuppression: true, maxNoiseSuppression: false, noiseSuppression: true })}>Forte (IA, recomendada)</button>
          <button className={`option ${!s.strongNoiseSuppression && s.noiseSuppression ? 'selected' : ''}`} onClick={() => updateSettings({ strongNoiseSuppression: false, noiseSuppression: true })}>Padrão</button>
          <button className={`option ${!s.strongNoiseSuppression && !s.noiseSuppression ? 'selected' : ''}`} onClick={() => updateSettings({ strongNoiseSuppression: false, noiseSuppression: false })}>Nenhuma</button>
        </div>
        <small className="muted">
          {s.strongNoiseSuppression && s.maxNoiseSuppression
            ? 'Passa a voz duas vezes pela IA: corta até gente falando longe, mas em muitos microfones deixa a voz metálica ou robótica. Se alguém reclamar de barulho estranho na sua voz, volte para a Forte.'
            : s.strongNoiseSuppression
              ? 'Tira chiado, ventilador, teclado e barulho de fundo até enquanto você fala (RNNoise).'
              : s.noiseSuppression
                ? 'A supressão básica do navegador: tira ruído constante.'
                : 'Sem filtro: bom para música ou microfone de estúdio.'}
        </small>
      </div>
      <Toggle label="Cancelamento de eco" hint="Evita que o som das caixas volte pelo microfone." checked={s.echoCancellation} onChange={(v) => updateSettings({ echoCancellation: v })} />
      <div className="field">
        <span>Filtro de teclado e mouse</span>
        <div className="options">
          {(
            [
              ['off', 'Desligado'],
              ['normal', 'Normal'],
              ['strong', 'Forte'],
            ] as const
          ).map(([v, label]) => (
            <button key={v} className={`option ${s.keyboardFilter === v ? 'selected' : ''}`} onClick={() => updateSettings({ keyboardFilter: v })}>
              {label}
            </button>
          ))}
        </div>
        <small className="muted">
          {s.keyboardFilter === 'off'
            ? 'O microfone abre com qualquer som alto.'
            : s.keyboardFilter === 'strong'
              ? 'Mais rígido: teclas logo depois de você falar são cortadas mais rápido. Use se ainda passar barulho.'
              : 'O microfone só abre com a sua voz: digitar, clicar e mexer no mouse sozinhos não passam, e a sua fala sai inteira, sem cortes.'}
          {' '}Teste em "Vamos verificar": a barra só fica verde quando você fala.
        </small>
      </div>
      <div className="field">
        <span>Proteção contra retorno</span>
        <div className="options">
          {(
            [
              ['off', 'Desligada'],
              ['normal', 'Normal'],
              ['strong', 'Forte'],
              ['max', 'Máxima'],
            ] as const
          ).map(([v, label]) => (
            <button
              key={v}
              className={`option ${(v === 'off' ? !s.echoGate : s.echoGate && s.echoStrength === v) ? 'selected' : ''}`}
              onClick={() => updateSettings(v === 'off' ? { echoGate: false } : { echoGate: true, echoStrength: v })}
            >
              {label}
            </button>
          ))}
        </div>
        <small className="muted">
          {!s.echoGate
            ? 'Sem proteção: use se estiver de fone.'
            : s.echoStrength === 'max'
              ? 'Para caixa de som alta ou vídeo/transmissão no volume alto. Enquanto toca som da call, o microfone só abre quando você fala no seu volume normal.'
              : s.echoStrength === 'strong'
                ? 'Enquanto toca voz, vídeo ou transmissão da call, o som que volta pelo microfone não é enviado. Falar por cima continua passando.'
                : 'Proteção leve: só segura o eco bem baixo.'}
          {' '}O melhor de tudo continua sendo usar fone.
        </small>
      </div>
      <Toggle label="Controle automático de ganho" hint="Ajusta o volume do microfone sozinho." checked={s.autoGainControl} onChange={(v) => updateSettings({ autoGainControl: v })} />

      <h3>Qualidade da voz</h3>
      <div className="options">
        {[32, 64, 96, 128].map((k) => (
          <button key={k} className={`option ${s.voiceBitrate === k ? 'selected' : ''}`} onClick={() => updateSettings({ voiceBitrate: k })}>
            {k} kbps{k === 64 ? ' (padrão)' : ''}
          </button>
        ))}
      </div>
      <small className="muted">Quanto maior, mais fiel a sua voz chega (bom para música), e mais internet usa. 32 kbps ajuda em internet fraca.</small>

      <h3>Atenuação</h3>
      <p className="muted">Abaixa o som das transmissões enquanto alguém fala, para a conversa não sumir no meio do jogo ou do vídeo.</p>
      <label className="field">
        <span>Atenuação · {s.attenuation}%</span>
        <input type="range" min={0} max={100} value={s.attenuation} onChange={(e) => updateSettings({ attenuation: +e.target.value })} />
      </label>
      <Toggle label="Quando outras pessoas estiverem falando" checked={s.attenuateOthers} onChange={(v) => updateSettings({ attenuateOthers: v })} />
      <Toggle label="Quando eu estiver falando" checked={s.attenuateMe} onChange={(v) => updateSettings({ attenuateMe: v })} />

      <h3>Redefinir</h3>
      <button onClick={() => confirm('Voltar todas as configurações de voz para o padrão?') && resetVoiceSettings()}>Redefinir configurações de voz</button>
    </>
  );
}

function StreamSettings() {
  const s = useSettings();
  return (
    <>
      <h2>Transmissão</h2>
      <p className="muted">É o que vem marcado quando você clica em "Transmitir tela". Também muda sozinho para a última escolha que você fizer lá.</p>
      <h3>Resolução</h3>
      <div className="options">
        {(Object.keys(RESOLUTIONS) as ShareResolution[]).map((r) => (
          <button key={r} className={`option ${s.streamResolution === r ? 'selected' : ''}`} onClick={() => updateSettings({ streamResolution: r })}>{RESOLUTIONS[r].label}</button>
        ))}
      </div>
      <h3>Taxa de quadros</h3>
      <div className="options">
        {FPS_OPTIONS.map((f) => (
          <button key={f} className={`option ${s.streamFps === f ? 'selected' : ''}`} onClick={() => updateSettings({ streamFps: f })}>{f} fps</button>
        ))}
      </div>
      <small className="muted">Usa até {(shareBitrate(s.streamResolution, s.streamFps) / 1_000_000).toFixed(1)} Mbps de upload.</small>
      <h3>Otimizar para</h3>
      <div className="options">
        <button className={`option ${s.streamOptimize === 'motion' ? 'selected' : ''}`} onClick={() => updateSettings({ streamOptimize: 'motion' })}>Movimento fluido</button>
        <button className={`option ${s.streamOptimize === 'detail' ? 'selected' : ''}`} onClick={() => updateSettings({ streamOptimize: 'detail' })}>Texto nítido</button>
      </div>
      <h3>Codec de vídeo</h3>
      <div className="options">
        {(Object.keys(CODECS) as ShareCodec[]).map((c) => (
          <button key={c} className={`option ${s.streamCodec === c ? 'selected' : ''}`} onClick={() => updateSettings({ streamCodec: c })}>{CODECS[c].label}</button>
        ))}
      </div>
      <small className="muted">{CODECS[s.streamCodec].hint}</small>
      <h3>Áudio e quem assiste</h3>
      <Toggle label="Transmitir o áudio junto" hint="Som do jogo, vídeo ou aba que você está mostrando." checked={s.streamAudio} onChange={(v) => updateSettings({ streamAudio: v })} />
      <Toggle
        label="Tirar as vozes da call do som da transmissão"
        hint="Quem assiste não ouve a própria voz (nem a sua) de volta pela transmissão. Se o som do jogo ficar estranho, desligue."
        checked={s.streamRemoveCall}
        onChange={(v) => updateSettings({ streamRemoveCall: v })}
      />
      <Toggle
        label="Assistir transmissões automaticamente"
        hint="Começa a ver a tela de quem transmitir sem precisar clicar em Assistir. Usa mais internet."
        checked={s.autoWatchStreams}
        onChange={(v) => updateSettings({ autoWatchStreams: v })}
      />
      <p className="muted">Para baixar o volume de uma transmissão, clique nela com o botão direito. A atenuação fica em Voz.</p>
    </>
  );
}

function VideoSettings() {
  const s = useSettings();
  const [preview, setPreview] = useState(false);
  const [error, setError] = useState('');
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (!preview) return;
    let stream: MediaStream | null = null;
    let cancelled = false;
    navigator.mediaDevices
      .getUserMedia({ video: { deviceId: s.videoDeviceId ? { ideal: s.videoDeviceId } : undefined, width: 1280, height: 720 } })
      .then((st) => {
        if (cancelled) return st.getTracks().forEach((t) => t.stop());
        stream = st;
        if (ref.current) ref.current.srcObject = st;
        setError('');
      })
      .catch((e) => setError(`Não deu para abrir a câmera: ${e.message}`));
    return () => {
      cancelled = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [preview, s.videoDeviceId]);
  return (
    <>
      <h2>Vídeo</h2>
      <div className="camera-preview">
        {preview ? <video ref={ref} autoPlay playsInline muted className="mirror" /> : <div className="camera-off"><Video size={40} /></div>}
      </div>
      <button className={preview ? '' : 'primary'} onClick={() => setPreview((p) => !p)}>{preview ? 'Parar teste' : 'Testar câmera'}</button>
      {error && <p className="error">{error}</p>}
      <DeviceSelect kind="videoinput" label="Câmera" value={s.videoDeviceId} onChange={(v) => updateSettings({ videoDeviceId: v })} />
    </>
  );
}

function NotifySettings() {
  const s = useSettings();
  const [sounds, setSounds] = useState(soundsEnabled);
  return (
    <>
      <h2>Notificações</h2>
      <DesktopNotifySettings />
      <h3>Sons do app</h3>
      <Toggle
        label="Sons"
        hint="Entrar e sair da call, mutar e mensagem nova com a aba em segundo plano."
        checked={sounds}
        onChange={(v) => {
          setSoundsEnabled(v);
          setSounds(v);
          if (v) playSound('join');
        }}
      />
      {sounds && (
        <>
          <label className="field">
            <span><Volume2 size={14} /> Volume dos sons · {s.soundVolume}%</span>
            <input
              type="range"
              min={0}
              max={100}
              value={s.soundVolume}
              onChange={(e) => updateSettings({ soundVolume: +e.target.value })}
              onPointerUp={() => playSound('message')}
            />
          </label>
          <label className="field">
            <span>Estilo dos sons</span>
            <select
              value={s.soundPack}
              onChange={(e) => {
                updateSettings({ soundPack: e.target.value as 'classic' | 'nexo' });
                setTimeout(() => playSound('join'), 0);
              }}
            >
              <option value="classic">Clássico (bolhas suaves)</option>
              <option value="nexo">Nexo (notas)</option>
            </select>
          </label>
          <h3>Sons</h3>
          {(Object.keys(SOUND_LABELS) as SoundName[]).map((name) => (
            <div key={name} className="sound-row">
              <Toggle
                label={SOUND_LABELS[name]}
                checked={!s.soundsOff[name]}
                onChange={(v) => {
                  updateSettings({ soundsOff: { ...s.soundsOff, [name]: !v } });
                  if (v) setTimeout(() => playSound(name), 0);
                }}
              />
              <button className="link" onClick={() => playSound(name)}>Ouvir</button>
            </div>
          ))}
        </>
      )}
      <p className="muted"><Gear size={14} /> As configurações do app ficam salvas neste computador. Conta e perfil valem em todo lugar.</p>
    </>
  );
}

/** Botão que grava uma combinação de teclas (ex.: Ctrl + Shift + M). Esc limpa. */
function Keybind({ label, value, global, onChange }: { label: string; value: string; global?: boolean; onChange: (v: string) => void }) {
  const [capturing, setCapturing] = useState(false);
  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code === 'Escape') {
        onChange('');
        return setCapturing(false);
      }
      const combo = comboFromEvent(e);
      if (!combo) return; // só Ctrl/Shift/Alt até agora: espera a tecla de verdade
      onChange(combo);
      setCapturing(false);
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [capturing, onChange]);
  return (
    <div className="field">
      <span>{label}</span>
      <button className={`keybind ${capturing ? 'capturing' : ''}`} onClick={() => setCapturing((c) => !c)}>
        {capturing ? 'Aperte a combinação… (Esc limpa)' : comboName(value)}
      </button>
      {value && global === true && <small className="ok-text">Funciona com o jogo ou outra janela em foco.</small>}
      {value && global === false && (
        <small className="error">
          Outro programa já usa esse atalho (o Discord usa Ctrl + Shift + M e Ctrl + Shift + D), então ele só funciona com o Nexo em
          foco. Escolha outra combinação, por exemplo Ctrl + Alt + M.
        </small>
      )}
    </div>
  );
}
