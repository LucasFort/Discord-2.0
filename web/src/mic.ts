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
/** Filtro de teclado e mouse: quanto o som precisa parecer voz para abrir o microfone. */
const KEY_FILTER: Record<string, { share: number; flat: number; ticks: number; bridge: number; hold: number } | null> = {
  off: null,
  // bridge: por quanto tempo depois da última voz qualquer som alto ainda segura o microfone aberto
  // (cobre "s", "f", "t", respiração e pausas curtas no meio da frase, sem cortar a voz).
  // hold: quanto tempo fica aberto depois do último som, para o fim das palavras sair inteiro.
  normal: { share: 0.58, flat: 0.33, ticks: 3, bridge: 700, hold: 350 },
  strong: { share: 0.6, flat: 0.3, ticks: 3, bridge: 450, hold: 300 },
};

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
  private denoise2: AudioNode | null = null; // segunda passada do RNNoise (supressão máxima)
  private openTicks = 0; // ticks seguidos com cara de voz (o portão só abre depois de alguns)
  private lastVoiced = 0; // último instante com som de voz de verdade (mantém o portão aberto)
  private freqBuf?: Float32Array<ArrayBuffer>;
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
    rawAnalyser.smoothingTimeConstant = 0; // espectro do instante (com média, a voz que acabou "vaza" para as teclas logo depois)
    const boost = audioContext.createGain();
    const limiter = audioContext.createDynamicsCompressor();
    // Limitador suave: só segura os picos (grito, risada). Mais forte que isso "bombeia" a voz.
    limiter.threshold.value = -6;
    limiter.knee.value = 6;
    limiter.ratio.value = 8;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.25;
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
    // Atraso de 60 ms antes do portão: dá tempo de confirmar que é voz (e não tecla) sem cortar
    // o começo da primeira palavra.
    const delay = audioContext.createDelay(0.2);
    delay.delayTime.value = 0.06;
    limiter.connect(delay);
    delay.connect(gate);
    gate.connect(dest);
    this.nodes = [src, gain, highpass, lowpass, post, rawAnalyser, boost, limiter, analyser, delay, gate, dest];
    this.pre = lowpass;
    this.post = post;
    this.denoise = await createRnnoise(audioContext);
    if (this.denoise) this.nodes.push(this.denoise);
    this.denoise2 = this.denoise ? await createRnnoise(audioContext) : null;
    if (this.denoise2) this.nodes.push(this.denoise2);
    this.route(getSettings().strongNoiseSuppression, getSettings().maxNoiseSuppression);
    this.gain = gain;
    this.boost = boost;
    this.gate = gate;
    this.rawAnalyser = rawAnalyser;
    this.analyser = analyser;
    this.processedTrack = dest.stream.getAudioTracks()[0];
    const buf = new Float32Array(analyser.fftSize);
    this.timer = setInterval(() => this.tick(buf), 20);
  }

  /**
   * Liga ou desliga o RNNoise no caminho do som sem recriar nada.
   * Na supressão máxima o som passa duas vezes pelo RNNoise: o que sobra de barulho
   * da primeira passada (teclado, gente falando longe, TV) é cortado na segunda.
   */
  private route(strong: boolean, max: boolean) {
    const on = strong && !!this.denoise;
    const twice = on && max && !!this.denoise2;
    if (!this.pre || !this.post) return;
    this.pre.disconnect();
    this.denoise?.disconnect();
    this.denoise2?.disconnect();
    if (twice) {
      this.pre.connect(this.denoise!);
      this.denoise!.connect(this.denoise2!);
      this.denoise2!.connect(this.post);
    } else if (on) {
      this.pre.connect(this.denoise!);
      this.denoise!.connect(this.post);
    } else this.pre.connect(this.post);
    this.denoiseOn = on;
    this.wantStrong = strong;
    this.wantMax = max;
  }
  private wantStrong = false;
  private wantMax = false;

  /**
   * Como é o som agora, pelo espectro:
   * - share: parte da energia na faixa da voz (150 a 3.400 Hz). Fala fica acima de 0,6; clique,
   *   batida e chiado espalham energia pelos agudos.
   * - flat: "planura" do espectro entre 100 e 2.000 Hz (0 = só picos, 1 = ruído chiado). A voz é
   *   feita de harmônicos (picos bem marcados) e fica baixa; tecla, mouse e batida são estalos
   *   sem tom e ficam altos, mesmo quando caem na mesma faixa da voz.
   */
  private spectrum() {
    const a = this.rawAnalyser!;
    this.freqBuf ??= new Float32Array(a.frequencyBinCount);
    a.getFloatFrequencyData(this.freqBuf);
    const hz = this.ctx!.sampleRate / a.fftSize;
    let voice = 0;
    let total = 0;
    let logSum = 0;
    let linSum = 0;
    let n = 0;
    for (let i = Math.max(1, Math.floor(100 / hz)); i < this.freqBuf.length && i * hz < 11000; i++) {
      const db = Math.max(-160, this.freqBuf[i]);
      const e = 10 ** (db / 10);
      if (i * hz >= 150) {
        total += e;
        if (i * hz <= 3400) voice += e;
      }
      if (i * hz <= 2000) {
        logSum += (db / 10) * Math.LN10;
        linSum += e;
        n++;
      }
    }
    return { share: total > 0 ? voice / total : 0, flat: n && linSum > 0 ? Math.exp(logSum / n) / (linSum / n) : 1 };
  }

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
    if (s.strongNoiseSuppression !== this.wantStrong || s.maxNoiseSuppression !== this.wantMax) this.route(s.strongNoiseSuppression, s.maxNoiseSuppression);

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
    // Quanto mais forte a proteção, mais perto do volume normal da sua fala o som precisa chegar
    // enquanto toca som da call (voz dos outros, vídeo, transmissão). O retorno pelo microfone fica de fora.
    const margin = s.echoStrength === 'max' ? 2 : s.echoStrength === 'normal' ? 9 : 5;
    const speaking = raw > this.noiseFloor + 10 && raw > -95 && (!echoRisk || raw > this.speechLevel - margin);
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
    // Muda devagar (até 5 dB por segundo): mudar rápido no meio da frase soa como volume "respirando".
    if (!echoRisk) this.boostDb += Math.max(-0.1, Math.min(0.1, wantBoost - this.boostDb));
    this.boost!.gain.setTargetAtTime(10 ** (this.boostDb / 20), ctx.currentTime, 0.05);

    this.level = this.measure(this.analyser!, buf);

    let open: boolean;
    if (s.inputMode === 'ptt') {
      if (isPttDown()) this.lastPtt = now;
      open = now - this.lastPtt <= s.pttReleaseDelay;
    } else {
      const loud = s.autoSensitivity ? speaking : this.level > s.sensitivity;
      // Filtro de teclado e mouse: o portão só abre com som que parece voz (harmônicos na faixa
      // da voz) por alguns ticks seguidos, e só continua aberto enquanto a voz continua. Teclas
      // apertadas no meio da fala não seguram o microfone aberto depois que você para de falar.
      const f = s.keyboardFilter in KEY_FILTER ? KEY_FILTER[s.keyboardFilter] : KEY_FILTER.normal;
      let voiced = loud;
      if (loud && f) {
        const sp = this.spectrum();
        voiced = sp.share > f.share && sp.flat < f.flat;
      }
      this.openTicks = voiced ? this.openTicks + 1 : 0;
      const bridge = f?.bridge ?? Infinity;
      const wasOpen = now - this.lastVoiced < bridge;
      // Para continuar aberto também precisa de voz em 2 ticks seguidos: uma tecla isolada que por
      // acaso pareça voz não emenda o portão aberto.
      if (voiced && this.openTicks >= (f ? (wasOpen ? 2 : f.ticks) : 1)) this.lastVoiced = now;
      // Com o portão aberto, qualquer som alto segura enquanto a voz foi recente (a frase sai inteira,
      // sem cortes). Teclas digitadas depois que você para de falar só passam até o "bridge" acabar.
      if (loud && now - this.lastVoiced < bridge) this.lastLoud = now;
      open = now - Math.max(this.lastLoud, this.lastVoiced) < (f?.hold ?? 400);
    }
    if (open !== this.open) this.gate!.gain.setTargetAtTime(open ? 1 : 0, ctx.currentTime, open ? 0.012 : 0.08);
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
    (this.denoise2 as RnnoiseWorkletNode | null)?.destroy?.();
    this.denoise = this.denoise2 = null;
    this.pre = this.post = undefined;
    this.nodes.forEach((n) => n.disconnect());
    this.nodes = [];
    this.gain = undefined;
    this.open = false;
    this.level = -100;
    this.rawLevel = -100;
  }
}
