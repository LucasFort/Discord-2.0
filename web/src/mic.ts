import { Track, type AudioProcessorOptions, type TrackProcessor } from 'livekit-client';
import { getSettings, isPttDown } from './settings';

const dB = (rms: number) => Math.max(-100, Math.min(0, 20 * Math.log10(rms || 1e-10)));

/**
 * Processamento do microfone antes de enviar para a call (Web Audio):
 * volume de entrada -> amplificação automática (microfone baixo) -> limitador -> medidor
 * -> "portão" que só abre com voz (sensibilidade) ou com a tecla de aperte para falar.
 *
 * A sensibilidade automática acompanha o ruído de fundo de cada microfone, então
 * funciona tanto em microfone alto quanto em microfone muito baixo.
 */
export class MicProcessor implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
  name = 'nexo-mic';
  processedTrack?: MediaStreamTrack;
  /** Para os medidores da tela: nível final (dB), nível cru do microfone, ganho automático e portão. */
  level = -100;
  rawLevel = -100;
  boostDb = 0;
  open = false;
  /** Pico da fala crua nos últimos segundos (para o aviso de "sinal muito baixo"). */
  speechPeak = -100;
  private nodes: AudioNode[] = [];
  private gate?: GainNode;
  private gain?: GainNode;
  private boost?: GainNode;
  private rawAnalyser?: AnalyserNode;
  private analyser?: AnalyserNode;
  private ctx?: AudioContext;
  private timer?: ReturnType<typeof setInterval>;
  private lastLoud = 0;
  private lastPtt = 0;
  private noiseFloor = -70; // ruído de fundo estimado (dB, cru)
  private speechLevel = -40; // média do nível da fala (dB, cru)
  private lastSpeech = 0;

  async init({ track, audioContext }: AudioProcessorOptions) {
    this.ctx = audioContext;
    const src = audioContext.createMediaStreamSource(new MediaStream([track]));
    const gain = audioContext.createGain();
    const rawAnalyser = audioContext.createAnalyser();
    rawAnalyser.fftSize = 1024;
    const boost = audioContext.createGain();
    const limiter = audioContext.createDynamicsCompressor();
    limiter.threshold.value = -10;
    limiter.knee.value = 4;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.2;
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 1024;
    const gate = audioContext.createGain();
    gate.gain.value = 0;
    const dest = audioContext.createMediaStreamDestination();
    src.connect(gain);
    gain.connect(rawAnalyser);
    gain.connect(boost);
    boost.connect(limiter);
    limiter.connect(analyser);
    limiter.connect(gate);
    gate.connect(dest);
    this.nodes = [src, gain, rawAnalyser, boost, limiter, analyser, gate, dest];
    this.gain = gain;
    this.boost = boost;
    this.gate = gate;
    this.rawAnalyser = rawAnalyser;
    this.analyser = analyser;
    this.processedTrack = dest.stream.getAudioTracks()[0];
    const buf = new Float32Array(analyser.fftSize);
    this.timer = setInterval(() => this.tick(buf), 20);
  }

  private measure(a: AnalyserNode, buf: Float32Array<ArrayBuffer>) {
    a.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    return dB(Math.sqrt(sum / buf.length));
  }

  private tick(buf: Float32Array<ArrayBuffer>) {
    const s = getSettings();
    const ctx = this.ctx!;
    const now = performance.now();
    this.gain!.gain.setTargetAtTime(s.inputVolume / 100, ctx.currentTime, 0.02);

    // Nível cru (depois do volume de entrada, antes da amplificação automática).
    const raw = this.measure(this.rawAnalyser!, buf);
    this.rawLevel = raw;
    // Ruído de fundo: desce rápido até o mínimo e sobe devagar.
    this.noiseFloor = raw < this.noiseFloor ? raw : Math.min(this.noiseFloor + 0.02, -20);
    const speaking = raw > this.noiseFloor + 9 && raw > -95;
    if (speaking) {
      this.lastSpeech = now;
      this.speechLevel += (raw - this.speechLevel) * 0.03;
      this.speechPeak = Math.max(this.speechPeak, raw);
    } else if (now - this.lastSpeech > 4000) {
      this.speechPeak = Math.max(-100, this.speechPeak - 0.2);
    }

    // Amplificação automática: leva a fala para perto de -24 dB, no máximo +36 dB.
    const wantBoost = s.autoBoost ? Math.max(0, Math.min(36, -24 - this.speechLevel)) : 0;
    this.boostDb += Math.max(-0.5, Math.min(0.5, wantBoost - this.boostDb));
    this.boost!.gain.setTargetAtTime(10 ** (this.boostDb / 20), ctx.currentTime, 0.05);

    this.level = this.measure(this.analyser!, buf);

    let open: boolean;
    if (s.inputMode === 'ptt') {
      if (isPttDown()) this.lastPtt = now;
      open = now - this.lastPtt <= s.pttReleaseDelay;
    } else {
      const loud = s.autoSensitivity ? speaking : this.level > s.sensitivity;
      if (loud) this.lastLoud = now;
      open = now - this.lastLoud < 400; // segura um pouco para não cortar o fim das palavras
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
    this.rawLevel = -100;
  }
}
