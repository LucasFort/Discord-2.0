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

function tone(freq: number, start: number, dur: number, volume = 0.12, type: OscillatorType = 'sine') {
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

export type SoundName = 'join' | 'leave' | 'mute' | 'unmute' | 'message' | 'reaction';

export function playSound(name: SoundName) {
  try {
    if (localStorage.getItem('sounds') === 'off') return;
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
