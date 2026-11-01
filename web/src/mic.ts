import { Track, type AudioProcessorOptions, type TrackProcessor } from 'livekit-client';
import { getSettings, isPttDown } from './settings';

/**
 * Processamento do microfone antes de enviar para a call (Web Audio):
 * volume de entrada -> medidor -> "portão" que só abre com voz acima da sensibilidade
 * (ou com a tecla de aperte para falar pressionada).
 */
export class MicProcessor implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
  name = 'nexo-mic';
  processedTrack?: MediaStreamTrack;
  /** Nível atual em dB (-100 a 0) e se o portão está aberto, para os medidores da tela. */
  level = -100;
  open = false;
  private nodes: AudioNode[] = [];
  private gate?: GainNode;
  private gain?: GainNode;
  private analyser?: AnalyserNode;
  private ctx?: AudioContext;
  private timer?: ReturnType<typeof setInterval>;
  private lastLoud = 0;
  private lastPtt = 0;

  async init({ track, audioContext }: AudioProcessorOptions) {
    this.ctx = audioContext;
    const src = audioContext.createMediaStreamSource(new MediaStream([track]));
    const gain = audioContext.createGain();
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 1024;
    const gate = audioContext.createGain();
    gate.gain.value = 0;
    const dest = audioContext.createMediaStreamDestination();
    src.connect(gain);
    gain.connect(analyser);
    gain.connect(gate);
    gate.connect(dest);
    this.nodes = [src, gain, analyser, gate, dest];
    this.gain = gain;
    this.gate = gate;
    this.analyser = analyser;
    this.processedTrack = dest.stream.getAudioTracks()[0];
    const buf = new Float32Array(analyser.fftSize);
    this.timer = setInterval(() => this.tick(buf), 20);
  }

  private tick(buf: Float32Array<ArrayBuffer>) {
    const s = getSettings();
    const ctx = this.ctx!;
    this.gain!.gain.setTargetAtTime(s.inputVolume / 100, ctx.currentTime, 0.02);
    this.analyser!.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / buf.length);
    this.level = Math.max(-100, Math.min(0, 20 * Math.log10(rms || 1e-10)));
    const now = performance.now();
    let open: boolean;
    if (s.inputMode === 'ptt') {
      if (isPttDown()) this.lastPtt = now;
      open = now - this.lastPtt <= s.pttReleaseDelay;
    } else {
      const threshold = s.autoSensitivity ? -60 : s.sensitivity;
      if (this.level > threshold) this.lastLoud = now;
      open = now - this.lastLoud < 350; // segura um pouco para não cortar o fim das palavras
    }
    if (open !== this.open) this.gate!.gain.setTargetAtTime(open ? 1 : 0, ctx.currentTime, open ? 0.005 : 0.05);
    this.open = open;
  }

  /** Microfone trocado (outro aparelho ou outro filtro): só troca a entrada e mantém a mesma saída. */
  async restart(opts: AudioProcessorOptions) {
    if (!this.gain || opts.audioContext !== this.ctx) {
      await this.destroy();
      return this.init(opts);
    }
    this.nodes[0]?.disconnect();
    const src = opts.audioContext.createMediaStreamSource(new MediaStream([opts.track]));
    src.connect(this.gain);
    this.nodes[0] = src;
  }

  async destroy() {
    clearInterval(this.timer);
    this.nodes.forEach((n) => n.disconnect());
    this.nodes = [];
    this.gain = undefined;
    this.open = false;
    this.level = -100;
  }
}
