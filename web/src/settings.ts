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
  maxNoiseSuppression: boolean; // RNNoise duas vezes (corta até teclado e gente falando longe)
  keyboardFilter: 'off' | 'normal' | 'strong'; // não deixa tecla, mouse e batida abrirem o microfone
  echoGate: boolean; // segura o microfone enquanto os outros falam e o seu som é só eco
  echoStrength: 'normal' | 'strong' | 'max'; // quão rígido o microfone fica enquanto toca som da call (voz, vídeo, transmissão)
  inputMode: 'voice' | 'ptt';
  pttKey: string; // KeyboardEvent.code, ex.: 'KeyV'
  pttReleaseDelay: number; // ms
  muteKey: string; // atalho para mutar/desmutar, ex.: 'Ctrl+Shift+KeyM' ('' = nenhum)
  deafenKey: string; // atalho para ensurdecer, ex.: 'Ctrl+Shift+KeyD'
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
  streamRemoveCall: boolean; // tira a voz da call do som da transmissão (eco de quem assiste)
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
  maxNoiseSuppression: true,
  keyboardFilter: 'strong',
  echoGate: true,
  echoStrength: 'strong',
  inputMode: 'voice',
  pttKey: '',
  pttReleaseDelay: 200,
  muteKey: 'Ctrl+Shift+KeyM',
  deafenKey: 'Ctrl+Shift+KeyD',
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
  streamRemoveCall: true,
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
  const keep: (keyof Settings)[] = ['userVolumes', 'streamVolumes', 'soundVolume', 'soundsOff', 'streamResolution', 'streamFps', 'streamOptimize', 'streamAudio', 'streamCodec', 'autoWatchStreams', 'streamRemoveCall'];
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

// ---------- Atalhos (combinação de teclas) ----------
const MODS = ['Ctrl', 'Alt', 'Shift', 'Meta'] as const;
const MOD_CODES = /^(Control|Shift|Alt|Meta|OS)(Left|Right)?$/;

/** Combinação apertada, como 'Ctrl+Shift+KeyM'. null enquanto só um modificador está apertado. */
export function comboFromEvent(e: KeyboardEvent): string | null {
  if (MOD_CODES.test(e.code)) return null;
  const mods = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Meta'].filter(Boolean);
  return [...mods, e.code].join('+');
}

/** Nome legível: 'Ctrl+Shift+KeyM' -> 'Ctrl + Shift + M'. */
export function comboName(combo: string) {
  if (!combo) return 'Nenhum';
  return combo
    .split('+')
    .map((p) => ((MODS as readonly string[]).includes(p) ? p : keyName(p)))
    .join(' + ');
}

/**
 * Converte para o formato de atalho global do app de computador (Electron), ex.: 'CommandOrControl+Shift+M'.
 * Devolve '' para teclas que o Electron não aceita como atalho global.
 */
export function comboToAccelerator(combo: string) {
  if (!combo) return '';
  const parts = combo.split('+');
  const code = parts.pop()!;
  const mods = parts.map((m) => (m === 'Ctrl' ? 'CommandOrControl' : m === 'Meta' ? 'Super' : m));
  let key = '';
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
  else if (/^Digit\d$/.test(code)) key = code.slice(5);
  else if (/^F\d{1,2}$/.test(code)) key = code;
  else if (/^Numpad\d$/.test(code)) key = 'num' + code.slice(6);
  else {
    const map: Record<string, string> = {
      Space: 'Space', Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
      Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Insert: 'Insert', Delete: 'Delete', Home: 'Home',
      End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
      Pause: 'Pause', ScrollLock: 'Scrolllock', NumpadAdd: 'numadd', NumpadSubtract: 'numsub', NumpadMultiply: 'nummult', NumpadDivide: 'numdiv',
    };
    key = map[code] ?? '';
  }
  return key ? [...mods, key].join('+') : '';
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
