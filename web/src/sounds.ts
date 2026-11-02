import { getSettings } from './settings';

/**
 * Sons curtos da call, gerados na hora com Web Audio (sem arquivos de áudio).
 * Entrar: duas notas subindo. Sair: duas notas descendo. Mutar/desmutar: um clique.
 */
let ctx: AudioContext | null = null;

let sink = '';
function audio() {
  if (!ctx) ctx = new AudioContext();
  // Toca os sons no mesmo dispositivo de saída escolhido nas configurações.
  const wanted = getSettings().outputDeviceId;
  const c = ctx as AudioContext & { setSinkId?: (id: string) => Promise<void> };
  if (wanted !== sink && c.setSinkId) {
    sink = wanted;
    void c.setSinkId(wanted).catch(() => {});
  }
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

let vol = 1; // volume dos sons (configurações)
function tone(freq: number, start: number, dur: number, volume = 0.12, type: OscillatorType = 'sine') {
  volume = Math.max(0.0002, volume * vol);
  const c = audio();
  const t = c.currentTime + start;
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(volume, t + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(gain).connect(c.destination);
  osc.start(t);
  osc.stop(t + dur + 0.05);
}

export type SoundName =
  | 'join' | 'leave' | 'disconnect' | 'mute' | 'unmute' | 'deafen' | 'undeafen'
  | 'ptt_on' | 'ptt_off' | 'stream_start' | 'stream_end' | 'message' | 'reaction';

/** Sons que dá para desligar um por um nas configurações (os nomes seguem os do Discord). */
export const SOUND_LABELS: Record<SoundName, string> = {
  message: 'Mensagem',
  reaction: 'Reação',
  mute: 'Microfone silenciado',
  unmute: 'Microfone ativado',
  deafen: 'Ensurdecido',
  undeafen: 'Desensurdecido',
  join: 'Usuário entrou',
  leave: 'Usuário saiu',
  disconnect: 'Voz desconectada',
  ptt_on: 'Aperte para falar: ativado',
  ptt_off: 'Aperte para falar: desativado',
  stream_start: 'Transmissão iniciada',
  stream_end: 'Transmissão encerrada',
};

export function playSound(name: SoundName) {
  try {
    if (localStorage.getItem('sounds') === 'off') return;
    const s = getSettings();
    if (s.soundsOff[name]) return;
    vol = Math.max(0, Math.min(1, s.soundVolume / 100));
    if (vol === 0) return;
    switch (name) {
      case 'join':
        tone(523.25, 0, 0.18); // dó
        tone(783.99, 0.1, 0.28); // sol
        break;
      case 'leave':
        tone(783.99, 0, 0.18);
        tone(392, 0.1, 0.3);
        break;
      case 'mute':
        tone(440, 0, 0.09, 0.08, 'triangle');
        break;
      case 'unmute':
        tone(660, 0, 0.09, 0.08, 'triangle');
        break;
      case 'message':
        tone(880, 0, 0.12, 0.06);
        tone(1174.66, 0.06, 0.16, 0.05);
        break;
      case 'reaction':
        tone(1046.5, 0, 0.1, 0.05);
        break;
      case 'disconnect':
        tone(659.25, 0, 0.14);
        tone(493.88, 0.09, 0.16);
        tone(329.63, 0.18, 0.3);
        break;
      case 'deafen':
        tone(392, 0, 0.09, 0.08, 'triangle');
        tone(293.66, 0.07, 0.12, 0.08, 'triangle');
        break;
      case 'undeafen':
        tone(587.33, 0, 0.09, 0.08, 'triangle');
        tone(783.99, 0.07, 0.12, 0.08, 'triangle');
        break;
      case 'ptt_on':
        tone(880, 0, 0.05, 0.05, 'square');
        break;
      case 'ptt_off':
        tone(660, 0, 0.05, 0.04, 'square');
        break;
      case 'stream_start':
        tone(523.25, 0, 0.12, 0.09);
        tone(659.25, 0.08, 0.12, 0.09);
        tone(1046.5, 0.16, 0.25, 0.08);
        break;
      case 'stream_end':
        tone(1046.5, 0, 0.12, 0.08);
        tone(659.25, 0.08, 0.12, 0.08);
        tone(523.25, 0.16, 0.25, 0.08);
        break;
    }
  } catch {
    /* navegador sem Web Audio: segue sem som */
  }
}

export const soundsEnabled = () => {
  try {
    return localStorage.getItem('sounds') !== 'off';
  } catch {
    return true;
  }
};
export const setSoundsEnabled = (on: boolean) => {
  try {
    localStorage.setItem('sounds', on ? 'on' : 'off');
  } catch {
    /* ignora */
  }
};
