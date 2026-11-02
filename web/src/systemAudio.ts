/**
 * Som do computador para a transmissão vindo do app de computador (Windows 11), já SEM o som do
 * próprio Nexo: quem assiste não ouve a própria voz nem as outras vozes da call de volta.
 *
 * O app entrega PCM 16 bits estéreo 48 kHz em pedaços; um AudioWorklet guarda num buffer
 * circular e toca numa faixa de áudio comum, que é publicada como o áudio da transmissão.
 */

type SystemAudioBridge = {
  available: () => Promise<boolean>;
  start: () => Promise<boolean>;
  stop: () => Promise<void>;
  onChunk: (cb: (chunk: Uint8Array) => void) => () => void;
};
const bridge = (window as unknown as { nexoDesktop?: { systemAudio?: SystemAudioBridge } }).nexoDesktop?.systemAudio;

/** O app instalado tem a captura que tira o som do Nexo (versão 0.1.3+ no Windows 11). */
export async function nativeSystemAudioAvailable() {
  try {
    return !!bridge && (await bridge.available());
  } catch {
    return false;
  }
}

const WORKLET = `
class NexoPcm extends AudioWorkletProcessor {
  constructor() {
    super();
    this.cap = 48000; // 1 s de folga (quadros estéreo)
    this.l = new Float32Array(this.cap);
    this.r = new Float32Array(this.cap);
    this.w = 0; this.rd = 0; this.n = 0;
    this.playing = false;
    this.port.onmessage = (e) => this.push(e.data);
  }
  push(pcm) {
    const frames = pcm.length >> 1;
    for (let i = 0; i < frames; i++) {
      this.l[this.w] = pcm[2 * i] / 32768;
      this.r[this.w] = pcm[2 * i + 1] / 32768;
      this.w = (this.w + 1) % this.cap;
    }
    this.n += frames;
    if (this.n > this.cap) { this.rd = (this.rd + this.n - this.cap) % this.cap; this.n = this.cap; }
    // Atraso acumulado (relógios diferentes): volta para ~40 ms em vez de atrasar cada vez mais.
    if (this.n > 9600) { this.rd = (this.rd + this.n - 1920) % this.cap; this.n = 1920; }
  }
  process(_in, outputs) {
    const out = outputs[0];
    const L = out[0], R = out[1] || out[0];
    const len = L.length;
    if (!this.playing && this.n >= 1920) this.playing = true;
    if (!this.playing || this.n < len) { this.playing = false; L.fill(0); if (R !== L) R.fill(0); return true; }
    for (let i = 0; i < len; i++) {
      L[i] = this.l[this.rd];
      if (R !== L) R[i] = this.r[this.rd];
      this.rd = (this.rd + 1) % this.cap;
    }
    this.n -= len;
    return true;
  }
}
registerProcessor('nexo-pcm', NexoPcm);
`;

export type NativeSystemAudio = { track: MediaStreamTrack; stop: () => void };

/** Começa a captura no app e devolve a faixa de áudio. null = não deu (usa a captura normal). */
export async function startNativeSystemAudio(): Promise<NativeSystemAudio | null> {
  if (!bridge) return null;
  const ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
  const dest = ctx.createMediaStreamDestination();
  let off: (() => void) | null = null;
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    off?.();
    void bridge.stop().catch(() => {});
    dest.stream.getTracks().forEach((t) => t.stop());
    void ctx.close().catch(() => {});
  };
  try {
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    const node = new AudioWorkletNode(ctx, 'nexo-pcm', { numberOfInputs: 0, outputChannelCount: [2] });
    dest.channelCount = 2;
    node.connect(dest);
    off = bridge.onChunk((chunk) => {
      // Copia para um buffer alinhado (o pedaço pode começar num byte ímpar) e manda sem copiar de novo.
      const pcm = new Int16Array(chunk.byteLength >> 1);
      new Uint8Array(pcm.buffer).set(chunk.subarray(0, pcm.length * 2));
      node.port.postMessage(pcm, [pcm.buffer]);
    });
    await ctx.resume().catch(() => {});
    if (!(await bridge.start())) {
      stop();
      return null;
    }
  } catch (e) {
    console.warn('Captura de som do app falhou, usando a normal', e);
    stop();
    return null;
  }
  const track = dest.stream.getAudioTracks()[0];
  return { track, stop };
}
