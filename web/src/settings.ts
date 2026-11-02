import { useEffect, useState } from 'react';
import type { AudioCaptureOptions } from 'livekit-client';

/** Configurações de voz e vídeo, salvas no navegador (cada pessoa tem as suas). */
export type Settings = {
  inputDeviceId: string; // '' = padrão do sistema
  outputDeviceId: string;
  videoDeviceId: string;
  inputVolume: number; // 0–200 (%)
  outputVolume: number; // 0–100 (%)
  noiseSuppression: boolean;
  echoCancellation: boolean;
  autoGainControl: boolean;
  autoBoost: boolean; // amplifica sozinho microfone baixo
  strongNoiseSuppression: boolean; // RNNoise (tira chiado e barulho de fundo)
  echoGate: boolean; // segura o microfone enquanto os outros falam e o seu som é só eco
  inputMode: 'voice' | 'ptt';
  pttKey: string; // KeyboardEvent.code, ex.: 'KeyV'
  pttReleaseDelay: number; // ms
  autoSensitivity: boolean;
  sensitivity: number; // dB, -100 a 0
  userVolumes: Record<string, number>; // id do usuário -> 0–200 (%)
  voiceBitrate: number; // kbps da sua voz (Opus)
  attenuation: number; // 0–100 (%): quanto o áudio das transmissões abaixa quando alguém fala
  attenuateOthers: boolean; // abaixa quando outras pessoas falam
  attenuateMe: boolean; // abaixa quando você fala
  soundVolume: number; // 0–100 (%) dos sons do app
  soundsOff: Partial<Record<string, boolean>>; // sons desligados um por um
  // Transmissão: o que vem marcado quando você abre "Transmitir tela" (salva a última escolha).
  streamResolution: '720' | '1080' | '1440' | 'native';
  streamFps: 15 | 30 | 60;
  streamOptimize: 'detail' | 'motion';
  streamAudio: boolean;
  streamCodec: 'h264' | 'vp9' | 'av1';
  autoWatchStreams: boolean; // começa a assistir sozinho quando alguém transmite
  streamVolumes: Record<string, number>; // id de quem transmite -> 0–100 (%) do áudio da transmissão
};

const DEFAULTS: Settings = {
  inputDeviceId: '',
  outputDeviceId: '',
  videoDeviceId: '',
  inputVolume: 100,
  outputVolume: 100,
  noiseSuppression: true,
  echoCancellation: true,
  autoGainControl: true,
  autoBoost: true,
  strongNoiseSuppression: true,
  echoGate: true,
  inputMode: 'voice',
  pttKey: '',
  pttReleaseDelay: 200,
  autoSensitivity: true,
  sensitivity: -50,
  userVolumes: {},
  voiceBitrate: 64,
  attenuation: 0,
  attenuateOthers: true,
  attenuateMe: false,
  soundVolume: 100,
  soundsOff: {},
  streamResolution: 'native',
  streamFps: 60,
  streamOptimize: 'motion',
  streamAudio: true,
  streamCodec: 'h264',
  autoWatchStreams: false,
  streamVolumes: {},
};

const KEY = 'nexo.settings';

function load(): Settings {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

let current = load();
const listeners = new Set<(s: Settings) => void>();

export const getSettings = () => current;

/** Volta as opções de voz para o padrão, sem mexer em volumes de pessoas, transmissão e sons. */
export function resetVoiceSettings() {
  const keep: (keyof Settings)[] = ['userVolumes', 'streamVolumes', 'soundVolume', 'soundsOff', 'streamResolution', 'streamFps', 'streamOptimize', 'streamAudio', 'streamCodec', 'autoWatchStreams'];
  const next = { ...DEFAULTS } as Record<string, unknown>;
  for (const k of keep) next[k] = current[k];
  updateSettings(next as Partial<Settings>);
}

export function updateSettings(patch: Partial<Settings>) {
  current = { ...current, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    /* modo anônimo sem armazenamento: vale só nesta aba */
  }
  listeners.forEach((l) => l(current));
}

export function onSettings(fn: (s: Settings) => void) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

export function useSettings() {
  const [s, setS] = useState(current);
  useEffect(() => onSettings(setS), []);
  return s;
}

/** Restrições do microfone a partir das configurações. */
export function micConstraints(s: Settings = current): AudioCaptureOptions {
  return {
    deviceId: s.inputDeviceId ? { ideal: s.inputDeviceId } : undefined, // 'ideal': se o aparelho sumiu, usa o padrão em vez de falhar
    noiseSuppression: s.noiseSuppression,
    echoCancellation: s.echoCancellation,
    autoGainControl: s.autoGainControl,
    // Pede o cancelamento de eco do sistema (melhor que o do navegador quando existe) e mono.
    ...(s.echoCancellation ? ({ echoCancellationType: 'system' } as object) : {}),
    channelCount: 1,
  };
}

/** Nome legível de uma tecla (KeyboardEvent.code). */
export function keyName(code: string) {
  if (!code) return 'Nenhuma';
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  const names: Record<string, string> = {
    Space: 'Espaço', CapsLock: 'Caps Lock', Backquote: '`', ControlLeft: 'Ctrl esq.', ControlRight: 'Ctrl dir.',
    ShiftLeft: 'Shift esq.', ShiftRight: 'Shift dir.', AltLeft: 'Alt', AltRight: 'AltGr', Tab: 'Tab',
  };
  return names[code] ?? code;
}

// ---------- Aperte para falar ----------
let pttDown = false;
export const isPttDown = () => pttDown;
if (typeof window !== 'undefined') {
  window.addEventListener('keydown', (e) => {
    if (current.inputMode === 'ptt' && current.pttKey && e.code === current.pttKey) pttDown = true;
  });
  window.addEventListener('keyup', (e) => {
    if (e.code === current.pttKey) pttDown = false;
  });
  window.addEventListener('blur', () => (pttDown = false));
}
