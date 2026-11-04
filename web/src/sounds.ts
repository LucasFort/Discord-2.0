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

/**
 * Saída dos sons: um compressor suave (nada estoura) e um "eco" curto e abafado que dá a cauda
 * brilhante da assinatura do Nexo. Num contexto offline serve para gerar prévia em arquivo.
 */
type Bus = { c: BaseAudioContext; dry: AudioNode; wet: AudioNode };
const buses = new WeakMap<BaseAudioContext, Bus>();
let offline: BaseAudioContext | null = null;
let offlineAt = 0; // na prévia em arquivo: em que segundo do arquivo o som começa
const now = (c: BaseAudioContext) => (c === offline ? offlineAt : c.currentTime);
function bus(): Bus {
  const c = offline ?? audio();
  let b = buses.get(c);
  if (!b) {
    const comp = c.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    comp.connect(c.destination);
    const delay = c.createDelay(1);
    delay.delayTime.value = 0.13;
    const fb = c.createGain();
    fb.gain.value = 0.3;
    const tone = c.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = 3200;
    const wet = c.createGain();
    wet.gain.value = 0.32;
    wet.connect(delay);
    delay.connect(tone);
    tone.connect(fb);
    fb.connect(delay);
    tone.connect(comp);
    b = { c, dry: comp, wet };
    buses.set(c, b);
  }
  return b;
}

let vol = 1; // volume dos sons (configurações)
function tone(freq: number, start: number, dur: number, volume = 0.12, type: OscillatorType = 'sine') {
  volume = Math.max(0.0002, volume * vol);
  const { c, dry } = bus();
  const t = now(c) + start;
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(volume, t + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(gain).connect(dry);
  osc.start(t);
  osc.stop(t + dur + 0.05);
}

/**
 * "Bolha": seno curto com o tom escorregando (como uma gota), ataque macio e um eco leve uma
 * oitava acima. É a base do estilo clássico, nos moldes dos sons antigos de apps de voz.
 */
function bloop(from: number, to: number, start: number, dur: number, volume = 0.22) {
  volume = Math.max(0.0002, volume * vol);
  const { c, dry } = bus();
  const t = now(c) + start;
  for (const [mult, v] of [[1, volume], [2, volume * 0.18]] as const) {
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(from * mult, t);
    osc.frequency.exponentialRampToValueAtTime(to * mult, t + dur * 0.6);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(v, t + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(gain).connect(dry);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }
}

/**
 * Assinatura do Nexo: "sino de vidro" feito com FM (um seno modulando outro). O ataque é
 * brilhante e logo fica redondo, com um grave bem leve embaixo e o eco curto do bus.
 * Os sons seguem o logo: um ponto (a nota) e as ondas (o eco).
 */
function glass(freq: number, start: number, dur = 0.5, volume = 0.2, echo = true) {
  volume = Math.max(0.0002, volume * vol);
  const { c, dry, wet } = bus();
  const t = now(c) + start;
  const car = c.createOscillator();
  const mod = c.createOscillator();
  const modGain = c.createGain();
  const amp = c.createGain();
  car.frequency.value = freq;
  mod.frequency.value = freq * 2.01; // razão quase inteira: brilho de vidro, não de metal
  modGain.gain.setValueAtTime(freq * 2.4, t);
  modGain.gain.exponentialRampToValueAtTime(freq * 0.05, t + dur * 0.5);
  amp.gain.setValueAtTime(0.0001, t);
  amp.gain.exponentialRampToValueAtTime(volume, t + 0.006);
  amp.gain.exponentialRampToValueAtTime(volume * 0.35, t + 0.09);
  amp.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  mod.connect(modGain).connect(car.frequency);
  car.connect(amp);
  amp.connect(dry);
  if (echo) amp.connect(wet);
  // Corpo: uma oitava abaixo, bem baixinho.
  const sub = c.createOscillator();
  const subAmp = c.createGain();
  sub.frequency.value = freq / 2;
  subAmp.gain.setValueAtTime(0.0001, t);
  subAmp.gain.exponentialRampToValueAtTime(volume * 0.3, t + 0.012);
  subAmp.gain.exponentialRampToValueAtTime(0.0001, t + dur * 0.6);
  sub.connect(subAmp).connect(dry);
  for (const o of [car, mod, sub]) {
    o.start(t);
    o.stop(t + dur + 0.05);
  }
}

/** Toque abafado (mutar, ensurdecer): seno curto com o tom caindo, sem eco. */
function tap(from: number, to: number, start: number, volume = 0.18) {
  volume = Math.max(0.0002, volume * vol);
  const { c, dry } = bus();
  const t = now(c) + start;
  const o = c.createOscillator();
  const g = c.createGain();
  const lp = c.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 2400;
  o.type = 'triangle';
  o.frequency.setValueAtTime(from, t);
  o.frequency.exponentialRampToValueAtTime(to, t + 0.06);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(volume, t + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
  o.connect(lp).connect(g).connect(dry);
  o.start(t);
  o.stop(t + 0.15);
}

// Notas da assinatura (mi maior com nona: aberto e "tecnológico", sem soar como alarme).
const E5 = 659.25, Gs5 = 830.61, B5 = 987.77, Cs6 = 1108.73, E6 = 1318.51, Fs6 = 1479.98, B4 = 493.88;

/** Sons "Nexo" (a assinatura). Devolve false para os que ele não muda. */
function signature(name: SoundName) {
  switch (name) {
    case 'join': // ponto + onda subindo: mi, si, mi agudo
      glass(E5, 0, 0.45, 0.2);
      glass(B5, 0.07, 0.45, 0.18);
      glass(E6, 0.14, 0.7, 0.16);
      return true;
    case 'leave': // a mesma onda voltando
      glass(E6, 0, 0.4, 0.15);
      glass(B5, 0.07, 0.4, 0.17);
      glass(E5, 0.14, 0.65, 0.19);
      return true;
    case 'disconnect':
      glass(B5, 0, 0.35, 0.16);
      glass(E5, 0.08, 0.4, 0.18);
      glass(B4, 0.16, 0.7, 0.2);
      return true;
    case 'mute':
      tap(900, 520, 0);
      return true;
    case 'unmute':
      tap(520, 900, 0);
      return true;
    case 'deafen':
      tap(760, 460, 0);
      tap(460, 280, 0.07);
      return true;
    case 'undeafen':
      tap(280, 460, 0);
      tap(460, 760, 0.07);
      return true;
    case 'message': // o "ping" do logo
      glass(Cs6, 0, 0.35, 0.1);
      glass(Fs6, 0.06, 0.45, 0.08);
      return true;
    case 'reaction':
      glass(E6, 0, 0.25, 0.07, false);
      return true;
    case 'stream_start': // quatro notas subindo, mais "ao vivo"
      glass(E5, 0, 0.3, 0.16);
      glass(Gs5, 0.07, 0.3, 0.16);
      glass(B5, 0.14, 0.3, 0.16);
      glass(E6, 0.21, 0.7, 0.15);
      return true;
    case 'stream_end':
      glass(E6, 0, 0.3, 0.14);
      glass(B5, 0.07, 0.3, 0.15);
      glass(Gs5, 0.14, 0.3, 0.16);
      glass(E5, 0.21, 0.6, 0.16);
      return true;
    case 'ptt_on':
      tap(1200, 1500, 0, 0.1);
      return true;
    case 'ptt_off':
      tap(1500, 1200, 0, 0.08);
      return true;
    default:
      return false;
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
    if (s.soundPack === 'signature' && signature(name)) return;
    if (s.soundPack === 'classic' && classic(name)) return;
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

/** Gera um som num arquivo de áudio (prévia, sem tocar). Usado para ouvir o som fora do app. */
export async function renderSound(names: SoundName[], gap = 0.5): Promise<AudioBuffer> {
  const c = new OfflineAudioContext(1, 48000 * (names.length * (1.2 + gap)), 48000);
  offline = c;
  try {
    vol = 1;
    const pack = getSettings().soundPack;
    names.forEach((n, i) => {
      offlineAt = i * (1.2 + gap);
      if (pack === 'signature') signature(n);
      else if (pack === 'classic') classic(n);
    });
  } finally {
    offline = null;
  }
  return c.startRendering();
}
