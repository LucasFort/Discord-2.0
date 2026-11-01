import { Track, type AudioProcessorOptions, type TrackProcessor } from 'livekit-client';
import { loadRnnoise, RnnoiseWorkletNode } from '@sapphi-red/web-noise-suppressor';
import rnnoiseWorkletPath from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url';
import rnnoiseWasmPath from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url';
import rnnoiseSimdWasmPath from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url';
import { getSettings, isPttDown } from './settings';

/** Contexto de áudio em 48 kHz (o RNNoise só funciona nessa taxa). */
export const newAudioContext = () => {
  try {
    return new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
  } catch {
    return new AudioContext();
  }
};

// RNNoise: baixa o modelo uma vez e registra o worklet uma vez por contexto de áudio.
let rnnoiseWasm: Promise<ArrayBuffer> | null = null;
const workletReady = new WeakMap<AudioContext, Promise<void>>();
async function createRnnoise(ctx: AudioContext): Promise<AudioNode | null> {
  try {
    if (ctx.sampleRate !== 48000 || !ctx.audioWorklet) return null;
    rnnoiseWasm ??= loadRnnoise({ url: rnnoiseWasmPath, simdUrl: rnnoiseSimdWasmPath });
    if (!workletReady.has(ctx)) workletReady.set(ctx, ctx.audioWorklet.addModule(rnnoiseWorkletPath));
    const [wasmBinary] = await Promise.all([rnnoiseWasm, workletReady.get(ctx)]);
    return new RnnoiseWorkletNode(ctx, { wasmBinary, maxChannels: 1 });
  } catch (e) {
    console.warn('Supressão de ruído forte indisponível', e);
    rnnoiseWasm = null;
    return null;
  }
}

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
  private denoise: AudioNode | null = null;
  private pre?: AudioNode; // fim da etapa de filtros (antes do RNNoise)
  private post?: AudioNode; // começo da etapa depois do RNNoise
  private denoiseOn = false;
  /** Se a supressão forte (RNNoise) está realmente rodando. */
  get strongNoiseActive() {
    return this.denoiseOn;
  }

  async init({ track, audioContext }: AudioProcessorOptions) {
    this.ctx = audioContext;
    const src = audioContext.createMediaStreamSource(new MediaStream([track]));
    const gain = audioContext.createGain();
    // Corta o zumbido grave (ventilador, rede elétrica) e o chiado muito agudo, fora da faixa da voz.
    const highpass = audioContext.createBiquadFilter();
    highpass.type = 'highpass';
    highpass.frequency.value = 85;
    const lowpass = audioContext.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.value = 11000;
    const post = audioContext.createGain();
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
    gain.connect(highpass);
    highpass.connect(lowpass);
    post.connect(rawAnalyser);
    post.connect(boost);
    boost.connect(limiter);
    limiter.connect(analyser);
    limiter.connect(gate);
    gate.connect(dest);
    this.nodes = [src, gain, highpass, lowpass, post, rawAnalyser, boost, limiter, analyser, gate, dest];
    this.pre = lowpass;
    this.post = post;
    this.denoise = await createRnnoise(audioContext);
    if (this.denoise) this.nodes.push(this.denoise);
    this.route(getSettings().strongNoiseSuppression);
    this.gain = gain;
    this.boost = boost;
    this.gate = gate;
    this.rawAnalyser = rawAnalyser;
    this.analyser = analyser;
    this.processedTrack = dest.stream.getAudioTracks()[0];
    const buf = new Float32Array(analyser.fftSize);
    this.timer = setInterval(() => this.tick(buf), 20);
  }

  /** Liga ou desliga o RNNoise no caminho do som sem recriar nada. */
  private route(strong: boolean) {
    const on = strong && !!this.denoise;
    if (!this.pre || !this.post) return;
    this.pre.disconnect();
    this.denoise?.disconnect();
    if (on) {
      this.pre.connect(this.denoise!);
      this.denoise!.connect(this.post);
    } else this.pre.connect(this.post);
    this.denoiseOn = on;
    this.wantStrong = strong;
  }
  private wantStrong = false;

  // ---------- Eco ----------
  /** Nível (dB) do som que está saindo das caixas agora: vozes e transmissões dos outros. */
  remoteLevel = -100;
  private remote = new Map<MediaStreamTrack, { src: MediaStreamAudioSourceNode; an: AnalyserNode }>();
  private remoteUntil = 0;
  private remoteBuf = new Float32Array(512);

  /** Áudios que estão tocando na call. O eco do microfone só pode vir deles. */
  setRemoteTracks(tracks: MediaStreamTrack[]) {
    const ctx = this.ctx;
    if (!ctx) return;
    for (const [t, n] of this.remote) {
      if (!tracks.includes(t)) {
        n.src.disconnect();
        this.remote.delete(t);
      }
    }
    for (const t of tracks) {
      if (this.remote.has(t) || t.readyState !== 'live') continue;
      try {
        const src = ctx.createMediaStreamSource(new MediaStream([t]));
        const an = ctx.createAnalyser();
        an.fftSize = 512;
        src.connect(an); // só mede, não toca de novo
        this.remote.set(t, { src, an });
      } catch {
        /* faixa que não dá para medir */
      }
    }
  }

  private measureRemote() {
    let max = -100;
    for (const { an } of this.remote.values()) max = Math.max(max, this.measure(an, this.remoteBuf));
    return max;
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
    if (s.strongNoiseSuppression !== this.wantStrong) this.route(s.strongNoiseSuppression);

    // Nível cru (depois do volume de entrada, antes da amplificação automática).
    const raw = this.measure(this.rawAnalyser!, buf);
    this.rawLevel = raw;

    // Alguém falando (ou transmissão tocando) nas caixas: o que entra no microfone pode ser eco.
    // Segura 350 ms depois que para, que é o tempo do eco do ambiente sumir.
    this.remoteLevel = this.measureRemote();
    if (this.remoteLevel > -55) this.remoteUntil = now + 350;
    const echoRisk = s.echoGate && now < this.remoteUntil;

    // Ruído de fundo: desce rápido até o mínimo e sobe devagar (não sobe com eco, senão aprende o eco).
    this.noiseFloor = raw < this.noiseFloor ? raw : echoRisk ? this.noiseFloor : Math.min(this.noiseFloor + 0.02, -20);
    // Com risco de eco a voz precisa chegar perto do volume normal da sua fala; o eco que sobra
    // depois do cancelamento é bem mais baixo e fica de fora. Falar por cima dos outros continua passando.
    const speaking = raw > this.noiseFloor + 9 && raw > -95 && (!echoRisk || raw > this.speechLevel - 9);
    if (speaking) {
      this.lastSpeech = now;
      this.speechLevel += (raw - this.speechLevel) * 0.03;
      this.speechPeak = Math.max(this.speechPeak, raw);
    } else if (now - this.lastSpeech > 4000) {
      this.speechPeak = Math.max(-100, this.speechPeak - 0.2);
    }

    // Amplificação automática: leva a fala para perto de -24 dB, no máximo +30 dB.
    // Não mexe enquanto os outros falam, para não aumentar o eco junto.
    const wantBoost = s.autoBoost ? Math.max(0, Math.min(30, -24 - this.speechLevel)) : 0;
    if (!echoRisk) this.boostDb += Math.max(-0.5, Math.min(0.5, wantBoost - this.boostDb));
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
    this.remote.forEach((n) => n.src.disconnect());
    this.remote.clear();
    (this.denoise as RnnoiseWorkletNode | null)?.destroy?.();
    this.denoise = null;
    this.pre = this.post = undefined;
    this.nodes.forEach((n) => n.disconnect());
    this.nodes = [];
    this.gain = undefined;
    this.open = false;
    this.level = -100;
    this.rawLevel = -100;
  }
}
