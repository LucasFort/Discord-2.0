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
  inputMode: 'voice' | 'ptt';
  pttKey: string; // KeyboardEvent.code, ex.: 'KeyV'
  pttReleaseDelay: number; // ms
  autoSensitivity: boolean;
  sensitivity: number; // dB, -100 a 0
  userVolumes: Record<string, number>; // id do usuário -> 0–200 (%)
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
  inputMode: 'voice',
  pttKey: '',
  pttReleaseDelay: 200,
  autoSensitivity: true,
  sensitivity: -50,
  userVolumes: {},
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
