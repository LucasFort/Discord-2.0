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

/**
 * "Bolha": seno curto com o tom escorregando (como uma gota), ataque macio e um eco leve uma
 * oitava acima. É a base do estilo clássico, nos moldes dos sons antigos de apps de voz.
 */
function bloop(from: number, to: number, start: number, dur: number, volume = 0.22) {
  volume = Math.max(0.0002, volume * vol);
  const c = audio();
  const t = c.currentTime + start;
  for (const [mult, v] of [[1, volume], [2, volume * 0.18]] as const) {
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(from * mult, t);
    osc.frequency.exponentialRampToValueAtTime(to * mult, t + dur * 0.6);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(v, t + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(gain).connect(c.destination);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }
}

/** Estilo clássico: bolhas suaves. Devolve false para os sons que ele não muda. */
function classic(name: SoundName) {
  switch (name) {
    case 'join': // duas bolhas subindo
      bloop(392, 523.25, 0, 0.16, 0.3);
      bloop(587.33, 783.99, 0.1, 0.32, 0.3);
      return true;
    case 'leave': // duas bolhas descendo
      bloop(783.99, 587.33, 0, 0.16, 0.28);
      bloop(523.25, 349.23, 0.1, 0.34, 0.28);
      return true;
    case 'disconnect':
      bloop(659.25, 440, 0, 0.18, 0.24);
      bloop(392, 261.63, 0.12, 0.38, 0.24);
      return true;
    case 'mute': // "toc" descendo
      bloop(700, 420, 0, 0.11, 0.16);
      return true;
    case 'unmute': // "toc" subindo
      bloop(420, 700, 0, 0.11, 0.16);
      return true;
    case 'deafen':
      bloop(620, 470, 0, 0.09, 0.15);
      bloop(470, 300, 0.07, 0.14, 0.15);
      return true;
    case 'undeafen':
      bloop(300, 470, 0, 0.09, 0.15);
      bloop(470, 620, 0.07, 0.14, 0.15);
      return true;
    case 'message': // pingo duplo
      bloop(1046.5, 1318.5, 0, 0.12, 0.1);
      bloop(1318.5, 1567.98, 0.08, 0.2, 0.09);
      return true;
    case 'reaction':
      bloop(987.77, 1318.5, 0, 0.12, 0.08);
      return true;
    case 'stream_start':
      bloop(440, 587.33, 0, 0.14, 0.2);
      bloop(587.33, 880, 0.1, 0.14, 0.2);
      bloop(880, 1174.66, 0.2, 0.3, 0.18);
      return true;
    case 'stream_end':
      bloop(1174.66, 880, 0, 0.14, 0.18);
      bloop(880, 587.33, 0.1, 0.14, 0.18);
      bloop(587.33, 440, 0.2, 0.3, 0.18);
      return true;
    default:
      return false;
  }
}

/** Três notas em sequência, a última mais longa: o som de alguém entrando ou saindo da call. */
function chime(notes: number[]) {
  notes.forEach((f, i) => {
    const last = i === notes.length - 1;
    tone(f, i * 0.09, last ? 0.42 : 0.16, 0.3);
    tone(f, i * 0.09, last ? 0.35 : 0.14, 0.12, 'triangle');
  });
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
    if (s.soundPack !== 'nexo' && classic(name)) return;
    switch (name) {
      // Entrar e sair: mais altos (cerca de 2,5x) e com três notas, para dar para ouvir mesmo
      // com jogo ou transmissão tocando. O "triangle" por baixo deixa o som mais cheio.
      case 'join':
        chime([523.25, 659.25, 1046.5]); // dó, mi, dó agudo: subindo
        break;
      case 'leave':
        chime([783.99, 587.33, 392]); // sol, ré, sol grave: descendo
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
