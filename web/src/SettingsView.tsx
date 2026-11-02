import { useEffect, useRef, useState } from 'react';
import { Mic, Settings as Gear, Video, Volume2, X, Bell } from 'lucide-react';
import { MicProcessor, newAudioContext } from './mic';
import { keyName, micConstraints, updateSettings, useSettings, type Settings } from './settings';
import { activeMic } from './voice';
import { setSoundsEnabled, soundsEnabled, playSound } from './sounds';

type Tab = 'voice' | 'video' | 'notify';

/** Tela de configurações: voz, vídeo e notificações. */
export function SettingsView({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('voice');
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="settings">
      <nav className="settings-nav">
        <h3>Configurações do app</h3>
        <button className={tab === 'voice' ? 'active' : ''} onClick={() => setTab('voice')}><Mic size={16} /> Voz</button>
        <button className={tab === 'video' ? 'active' : ''} onClick={() => setTab('video')}><Video size={16} /> Vídeo</button>
        <button className={tab === 'notify' ? 'active' : ''} onClick={() => setTab('notify')}><Bell size={16} /> Notificações</button>
      </nav>
      <section className="settings-body">
        {tab === 'voice' && <VoiceSettings />}
        {tab === 'video' && <VideoSettings />}
        {tab === 'notify' && <NotifySettings />}
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
  const [testing, setTesting] = useState(false);
  const [loopback, setLoopback] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const { proc, error } = useMicTest(testing, loopback, s);
  const meterSource = useRef(() => proc.current ?? activeMic).current;

  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
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

      <h3>Processamento de voz</h3>
      <Toggle label="Amplificar microfone baixo automaticamente" hint="Aumenta sozinho o volume de microfones fracos para todo mundo te ouvir." checked={s.autoBoost} onChange={(v) => updateSettings({ autoBoost: v })} />
      <Toggle
        label="Supressão de ruído forte (IA)"
        hint="Tira chiado, ventilador, teclado e barulho de fundo até enquanto você fala (RNNoise)."
        checked={s.strongNoiseSuppression}
        onChange={(v) => updateSettings({ strongNoiseSuppression: v })}
      />
      <Toggle label="Supressão de ruído do navegador" hint="A supressão básica do navegador. Pode deixar ligada junto com a forte." checked={s.noiseSuppression} onChange={(v) => updateSettings({ noiseSuppression: v })} />
      <Toggle label="Cancelamento de eco" hint="Evita que o som das caixas volte pelo microfone." checked={s.echoCancellation} onChange={(v) => updateSettings({ echoCancellation: v })} />
      <Toggle
        label="Supressão de eco extra"
        hint="Enquanto outra pessoa fala, o microfone só abre com a sua voz de verdade. Tira o eco que sobra quando alguém usa caixa de som."
        checked={s.echoGate}
        onChange={(v) => updateSettings({ echoGate: v })}
      />
      <Toggle label="Controle automático de ganho" hint="Ajusta o volume do microfone sozinho." checked={s.autoGainControl} onChange={(v) => updateSettings({ autoGainControl: v })} />
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
  const [sounds, setSounds] = useState(soundsEnabled);
  return (
    <>
      <h2>Notificações</h2>
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
      <p className="muted"><Volume2 size={14} /> O volume dos sons segue o volume do sistema.</p>
      <p className="muted"><Gear size={14} /> As configurações ficam salvas neste computador.</p>
    </>
  );
}
