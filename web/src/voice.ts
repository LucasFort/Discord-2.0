import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DisconnectReason,
  Room,
  RoomEvent,
  Track,
  type Participant,
  type RemoteParticipant,
  type RemoteTrackPublication,
  type RemoteTrack,
  RemoteAudioTrack,
  type LocalAudioTrack,
  type AudioCaptureOptions,
} from 'livekit-client';
import { MicProcessor, newAudioContext } from './mic';
import { getSettings, micConstraints, onSettings, type Settings } from './settings';
import { api } from './api';
import { playSound } from './sounds';
import { toast } from './toast';
import { setInCall } from './activity';
import { nativeSystemAudioAvailable, startNativeSystemAudio, type NativeSystemAudio } from './systemAudio';

/** Emoji que alguém mandou na call e que sobe flutuando por cima da tela. */
export type FloatingReaction = { id: number; emoji: string; name: string; left: number };
const CALL_EMOJIS = ['👍', '😂', '❤️', '🔥', '🎉', '👏', '😮', '💀'];
export { CALL_EMOJIS };
let floatId = 1;

/** Processador do microfone em uso na call (o medidor das configurações lê o nível daqui). */
export let activeMic: MicProcessor | null = null;
let micCtx: AudioContext | null = null;

/** Passa para o processador do microfone os áudios que tocam na call (para reconhecer o eco). */
function feedRemoteAudio(room: Room) {
  const tracks: MediaStreamTrack[] = [];
  room.remoteParticipants.forEach((p) =>
    p.audioTrackPublications.forEach((pub) => pub.track?.mediaStreamTrack && tracks.push(pub.track.mediaStreamTrack)),
  );
  activeMic?.setRemoteTracks(tracks);
}

/** O microfone só passa pelo processamento quando alguma opção precisa dele. */
const needsMicProcessor = (s: Settings) => s.echoGate || s.keyboardFilter !== 'off' || s.autoBoost || s.strongNoiseSuppression || s.inputMode === 'ptt' || !s.autoSensitivity || s.inputVolume !== 100;

/**
 * Volume final de cada áudio: volume geral × volume da pessoa (voz) ou da transmissão dela
 * (áudio da tela), no máximo 100%. Assim dá para baixar o jogo/vídeo sem baixar a voz.
 */
function volumeFor(identity: string, source: Track.Source, deaf: boolean, room?: Room | null, s: Settings = getSettings()) {
  if (deaf) return 0;
  const stream = source === Track.Source.ScreenShareAudio;
  const own = stream ? (s.streamVolumes[identity] ?? 100) : (s.userVolumes[identity] ?? 100);
  // Atenuação (como no Discord): o áudio das transmissões abaixa enquanto alguém fala.
  let atten = 1;
  if (stream && s.attenuation > 0 && room) {
    const others = s.attenuateOthers && room.activeSpeakers.some((p) => p !== room.localParticipant);
    const me = s.attenuateMe && room.localParticipant.isSpeaking;
    if (others || me) atten = 1 - s.attenuation / 100;
  }
  return Math.min(1, (s.outputVolume / 100) * (own / 100) * atten);
}
import type { Gateway } from './store';

const isDesktopApp = () => /Electron\//.test(navigator.userAgent); // app de computador (qualquer versão)
function shareAudioOptions(): AudioCaptureOptions {
  const removeCall = getSettings().streamRemoveCall;
  return {
    echoCancellation: removeCall && isDesktopApp(),
    noiseSuppression: false,
    autoGainControl: false,
    channelCount: 2,
    restrictOwnAudio: removeCall,
    suppressLocalAudioPlayback: false,
  } as AudioCaptureOptions;
}

export type ShareResolution = '720' | '1080' | '1440' | 'native';
export type ShareFps = 15 | 30 | 60;
export type ShareCodec = 'h264' | 'vp9' | 'av1';
export type ShareOptions = {
  resolution: ShareResolution;
  fps: ShareFps;
  audio: boolean;
  optimizeFor: 'detail' | 'motion';
  codec: ShareCodec;
};

export const RESOLUTIONS: Record<ShareResolution, { label: string; width: number; height: number }> = {
  '720': { label: '720p', width: 1280, height: 720 },
  '1080': { label: '1080p', width: 1920, height: 1080 },
  '1440': { label: '1440p', width: 2560, height: 1440 },
  native: { label: 'Nativa', width: 0, height: 0 }, // 0 = sem teto: a tela no tamanho real
};
export const FPS_OPTIONS: ShareFps[] = [15, 30, 60];
export const CODECS: Record<ShareCodec, { label: string; hint: string }> = {
  h264: { label: 'H.264', hint: 'Usa a placa de vídeo na maioria dos PCs. Mais leve.' },
  vp9: { label: 'VP9', hint: 'Imagem melhor com a mesma internet, mas pesa mais no processador.' },
  av1: { label: 'AV1', hint: 'O mais eficiente. Só vale em PC novo; se não tiver suporte, volta para H.264.' },
};

/** Taxa de bits para a resolução e o fps escolhidos (a nativa conta como 1440p). */
export function shareBitrate(res: ShareResolution, fps: ShareFps) {
  const r = RESOLUTIONS[res];
  const px = r.width ? r.width * r.height : 2560 * 1440;
  return Math.round(Math.max(1_500_000, Math.min(12_000_000, px * fps * 0.055)));
}

export type VoiceUser = {
  identity: string;
  name: string;
  isLocal: boolean;
  speaking: boolean;
  micMuted: boolean;
  camera?: Track;
  screen?: Track; // presente quando o usuário está assistindo (ou é a própria transmissão)
  isSharing: boolean;
  watching: boolean;
};

/**
 * Voice channel connection on top of LiveKit.
 * Rule copied from the Go Live behaviour: mic and camera are received automatically,
 * screen shares only after the user clicks "Assistir" (saves bandwidth).
 */
export function useVoice(gateway: Gateway) {
  const roomRef = useRef<Room | null>(null);
  /** Som do computador vindo do app (sem o som do Nexo), quando está em uso na transmissão. */
  const nativeAudio = useRef<NativeSystemAudio | null>(null);
  const audioBox = useRef<HTMLDivElement | null>(null);
  const [channelId, setChannelId] = useState<string | null>(null);
  useEffect(() => setInCall(!!channelId), [channelId]);
  const [connecting, setConnecting] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const leavingRef = useRef(false); // true quando a pessoa clicou em sair (não reconectar)
  const connectingTo = useRef<string | null>(null); // canal que está conectando agora
  const rejoinTries = useRef(0);
  const [muted, setMuted] = useState(false);
  const [deafened, setDeafened] = useState(false);
  const deafRef = useRef(false);
  // Silenciado/ensurdecido pelo dono do servidor: vale por cima do que a pessoa escolheu.
  const serverRef = useRef({ mute: false, deaf: false });
  const [server, setServer] = useState({ mute: false, deaf: false });
  const isDeaf = () => deafRef.current || serverRef.current.deaf;
  const micBlocked = () => serverRef.current.mute || serverRef.current.deaf;
  const [watching, setWatching] = useState<Record<string, true>>({});
  const [floating, setFloating] = useState<FloatingReaction[]>([]);
  const addFloating = useCallback((emoji: string, name: string) => {
    const f = { id: floatId++, emoji, name, left: 10 + Math.random() * 80 };
    setFloating((list) => [...list.slice(-20), f]);
    setTimeout(() => setFloating((list) => list.filter((x) => x.id !== f.id)), 3000);
  }, []);
  const [, setTick] = useState(0);
  const rerender = useCallback(() => setTick((t) => t + 1), []);

  if (!audioBox.current && typeof document !== 'undefined') {
    audioBox.current = document.createElement('div');
    audioBox.current.style.display = 'none';
    document.body.appendChild(audioBox.current);
  }

  const autoSubscribe = (pub: RemoteTrackPublication, identity?: string) => {
    if (pub.source === Track.Source.Microphone || pub.source === Track.Source.Camera) pub.setSubscribed(true);
    // "Assistir transmissões automaticamente" nas configurações.
    else if (identity && getSettings().autoWatchStreams && (pub.source === Track.Source.ScreenShare || pub.source === Track.Source.ScreenShareAudio)) {
      pub.setSubscribed(true);
      setWatching((w) => ({ ...w, [identity]: true }));
    }
  };

  const leave = useCallback(async () => {
    leavingRef.current = true;
    connectingTo.current = null;
    nativeAudio.current?.stop();
    nativeAudio.current = null;
    const room = roomRef.current;
    roomRef.current = null;
    await room?.disconnect();
    activeMic = null;
    if (room) playSound('disconnect');
    if (audioBox.current) audioBox.current.innerHTML = '';
    setFloating([]);
    setChannelId(null);
    setWatching({});
    setReconnecting(false);
    serverRef.current = { mute: false, deaf: false };
    setServer(serverRef.current);
    gateway.send({ op: 'voice_state', channel_id: null });
  }, [gateway]);

  const join = useCallback(
    async (id: string) => {
      // Já entrando nesse canal (clique duplo, ou a volta automática junto com um clique): ignora.
      // Antes o segundo clique derrubava a conexão em andamento e aparecia "Client initiated disconnect".
      if (connectingTo.current === id) return;
      if (roomRef.current) await leave();
      connectingTo.current = id;
      leavingRef.current = false;
      setConnecting(true);
      let started: Room | null = null; // a sala desta tentativa (para o erro não derrubar outra)
      // Cria o áudio ainda dentro do clique (o navegador só libera som que começa num clique).
      if (needsMicProcessor(getSettings())) {
        micCtx ??= newAudioContext();
        void micCtx.resume().catch(() => {});
      }
      try {
        const { url, token, server_mute, server_deaf } = await api<{ url: string; token: string; server_mute?: boolean; server_deaf?: boolean }>(
          'POST',
          `/channels/${id}/voice-token`,
        );
        serverRef.current = { mute: !!server_mute, deaf: !!server_deaf };
        setServer(serverRef.current);
        const room = new Room({
          adaptiveStream: true,
          dynacast: true,
          // Voz: Opus com DTX (não manda nada no silêncio) e RED (redundância contra perda de pacotes).
          publishDefaults: { dtx: true, red: true, audioPreset: { maxBitrate: getSettings().voiceBitrate * 1000 } },
          audioCaptureDefaults: micConstraints(),
          audioOutput: getSettings().outputDeviceId ? { deviceId: getSettings().outputDeviceId } : undefined,
          videoCaptureDefaults: getSettings().videoDeviceId ? { deviceId: getSettings().videoDeviceId } : undefined,
        });
        roomRef.current = room;
        started = room;

        room
          .on(RoomEvent.TrackPublished, (pub, participant) => {
            if (pub.source === Track.Source.ScreenShare) playSound('stream_start');
            autoSubscribe(pub, participant.identity);
            rerender();
          })
          .on(RoomEvent.TrackSubscribed, (track: RemoteTrack, pub, p) => {
            // Transmissão: guarda um pouco mais de vídeo antes de mostrar (~150 ms). Absorve as
            // oscilações da internet de quem assiste, e a imagem não fica dando trancos.
            if (pub.source === Track.Source.ScreenShare || pub.source === Track.Source.ScreenShareAudio) {
              const r = track.receiver as (RTCRtpReceiver & { jitterBufferTarget?: number | null }) | undefined;
              try { if (r && 'jitterBufferTarget' in r) r.jitterBufferTarget = 150; } catch { /* navegador sem suporte */ }
            }
            if (track.kind === Track.Kind.Audio) {
              audioBox.current?.appendChild(track.attach());
              feedRemoteAudio(room);
              (track as RemoteAudioTrack).setVolume(volumeFor(p.identity, pub.source, isDeaf(), room));
            }
            rerender();
          })
          .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
            track.detach().forEach((el) => el.remove());
            feedRemoteAudio(room);
            rerender();
          })
          .on(RoomEvent.TrackUnpublished, (pub, p) => {
            if (pub.source === Track.Source.ScreenShare) playSound('stream_end');
            if (pub.source === Track.Source.ScreenShare) setWatching(({ [p.identity]: _, ...rest }) => rest);
            rerender();
          })
          .on(RoomEvent.ParticipantConnected, (p) => {
            playSound('join');
            toast(`${p.name || 'Alguém'} entrou na call`, 'join');
            rerender();
          })
          .on(RoomEvent.ParticipantDisconnected, (p) => {
            playSound('leave');
            toast(`${p.name || 'Alguém'} saiu da call`, 'leave');
            setWatching(({ [p.identity]: _, ...rest }) => rest);
            rerender();
          })
          .on(RoomEvent.DataReceived, (payload, p, _kind, topic) => {
            if (topic !== 'reaction') return;
            try {
              const { emoji } = JSON.parse(new TextDecoder().decode(payload));
              if (CALL_EMOJIS.includes(emoji)) addFloating(emoji, p?.name || '');
            } catch {
              /* ignora */
            }
          })
          .on(RoomEvent.TrackMuted, rerender)
          .on(RoomEvent.TrackUnmuted, rerender)
          .on(RoomEvent.ActiveSpeakersChanged, () => {
            applyVolumes(); // atenuação das transmissões depende de quem está falando
            rerender();
          })
          .on(RoomEvent.LocalTrackPublished, rerender)
          .on(RoomEvent.LocalTrackUnpublished, (pub) => {
            // Transmissão parou (botão, janela fechada etc.): para também a captura do som no app.
            if (pub.source === Track.Source.ScreenShare || pub.source === Track.Source.ScreenShareAudio) stopNativeAudio();
            rerender();
          })
          .on(RoomEvent.Reconnecting, () => setReconnecting(true))
          .on(RoomEvent.Reconnected, () => setReconnecting(false))
          .on(RoomEvent.Disconnected, (reason?: DisconnectReason) => {
            if (roomRef.current !== room) return;
            // Tirado da call pelo dono do servidor: não volta sozinho.
            if (reason === DisconnectReason.PARTICIPANT_REMOVED) leavingRef.current = true;
            // Queda que o próprio LiveKit não conseguiu recuperar: entra de novo sozinho (até 3 vezes seguidas).
            if (!leavingRef.current && rejoinTries.current < 3) {
              rejoinTries.current++;
              roomRef.current = null;
              setReconnecting(true);
              setTimeout(() => join(id), 1000 * rejoinTries.current);
              return;
            }
            leave();
          });

        try {
          await room.connect(url, token, { autoSubscribe: false });
        } catch (e) {
          throw new Error(`não conectou ao servidor de voz (${url}). ${(e as Error).message}`);
        }
        room.remoteParticipants.forEach((p) => p.trackPublications.forEach((pub) => autoSubscribe(pub, p.identity)));
        // Sem microfone (permissão negada ou nenhum dispositivo) a pessoa ainda entra, só que mutada.
        try {
          await room.localParticipant.setMicrophoneEnabled(!muted && !deafRef.current && !micBlocked(), micConstraints());
          await attachMicProcessor(room);
        } catch (e) {
          setMuted(true);
          alert(`Entrou na call sem microfone: ${(e as Error).message}. Libere o microfone no cadeado da barra de endereço.`);
        }
        await room.startAudio().catch(() => {});
        // Entrou sem clique (ex.: voltou sozinho depois de uma atualização): o navegador pode
        // segurar o som até o primeiro clique na página.
        if (!room.canPlaybackAudio) {
          toast('Clique em qualquer lugar para ouvir a call');
          window.addEventListener('pointerdown', () => void room.startAudio().catch(() => {}), { once: true });
        }
        setChannelId(id);
        setReconnecting(false);
        if (rejoinTries.current === 0) playSound('join'); // reconexão automática não toca de novo
        rejoinTries.current = 0;
        gateway.send({ op: 'voice_state', channel_id: id });
      } catch (e) {
        // Outra entrada (outro canal, sair) começou no meio desta: ela já cuida de tudo, sem aviso.
        // Só desconecta se a sala ainda é esta, senão derrubava a conexão nova.
        if (connectingTo.current !== id || (roomRef.current && roomRef.current !== started)) return;
        await started?.disconnect().catch(() => {});
        if (roomRef.current === started) roomRef.current = null;
        alert(`Não foi possível entrar na voz: ${(e as Error).message}`);
      } finally {
        // Só a tentativa mais recente mexe no "conectando" (ou nenhuma, se a pessoa saiu no meio).
        if (connectingTo.current === id || connectingTo.current === null) {
          connectingTo.current = null;
          setConnecting(false);
        }
      }
    },
    [gateway, leave, muted, rerender, addFloating],
  );

  /**
   * Processamento do microfone (volume de entrada, sensibilidade manual, aperte para falar).
   * Só entra quando alguma dessas opções está ligada: no padrão o microfone vai direto,
   * do jeito que funcionava antes das configurações. Se o áudio do navegador não estiver
   * rodando, desiste e deixa o microfone direto em vez de mandar silêncio.
   */
  const attachMicProcessor = async (room: Room) => {
    const track = room.localParticipant.getTrackPublication(Track.Source.Microphone)?.audioTrack as LocalAudioTrack | undefined;
    if (!track) return;
    const wanted = needsMicProcessor(getSettings());
    const current = track.getProcessor();
    try {
      if (!wanted) {
        if (current) await track.stopProcessor();
        activeMic = null;
        return;
      }
      if (current) return;
      micCtx ??= newAudioContext();
      if (micCtx.state !== 'running') await Promise.race([micCtx.resume(), new Promise((r) => setTimeout(r, 1500))]).catch(() => {});
      if (micCtx.state !== 'running') {
        // Entrou sem clique (ex.: voltou sozinho depois de uma atualização): o navegador segura o
        // áudio até a pessoa interagir. Enquanto isso o microfone vai direto, e no primeiro clique
        // ou tecla a supressão de ruído entra de novo (antes ficava sem ela até sair da call).
        console.warn('Áudio do navegador parado: microfone vai sem processamento até o primeiro clique');
        const retry = () => {
          window.removeEventListener('pointerdown', retry, true);
          window.removeEventListener('keydown', retry, true);
          void micCtx?.resume().then(() => (roomRef.current === room ? attachMicProcessor(room) : undefined)).catch(() => {});
        };
        window.addEventListener('pointerdown', retry, true);
        window.addEventListener('keydown', retry, true);
        return;
      }
      await track.setAudioContext(micCtx);
      const proc = new MicProcessor();
      await track.setProcessor(proc);
      activeMic = proc;
      feedRemoteAudio(room);
    } catch (e) {
      console.warn('Processamento do microfone indisponível, usando o microfone direto', e);
      activeMic = null;
      await track.stopProcessor().catch(() => {});
    }
  };

  const applyVolumes = useCallback(() => {
    roomRef.current?.remoteParticipants.forEach((p) =>
      p.audioTrackPublications.forEach((pub) => (pub.track as RemoteAudioTrack | undefined)?.setVolume(volumeFor(p.identity, pub.source, isDeaf(), roomRef.current))),
    );
  }, []);

  // Aplica na call as mudanças feitas nas configurações.
  useEffect(() => {
    let prev = getSettings();
    return onSettings(async (s) => {
      const room = roomRef.current;
      const before = prev;
      prev = s;
      applyVolumes();
      if (!room) return;
      try {
        if (s.outputDeviceId !== before.outputDeviceId) await room.switchActiveDevice('audiooutput', s.outputDeviceId || 'default');
        if (s.videoDeviceId !== before.videoDeviceId && s.videoDeviceId) await room.switchActiveDevice('videoinput', s.videoDeviceId);
        const micChanged =
          s.inputDeviceId !== before.inputDeviceId ||
          s.noiseSuppression !== before.noiseSuppression ||
          s.echoCancellation !== before.echoCancellation ||
          s.autoGainControl !== before.autoGainControl;
        if (micChanged) {
          const track = room.localParticipant.getTrackPublication(Track.Source.Microphone)?.audioTrack as LocalAudioTrack | undefined;
          await track?.restartTrack(micConstraints(s));
        }
        if (needsMicProcessor(s) !== needsMicProcessor(before)) await attachMicProcessor(room);
        if (s.voiceBitrate !== before.voiceBitrate) {
          const sender = room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track?.sender;
          if (sender) {
            const params = sender.getParameters();
            for (const e of params.encodings ?? []) e.maxBitrate = s.voiceBitrate * 1000;
            await sender.setParameters(params);
          }
        }
      } catch (e) {
        console.warn('Não deu para trocar o dispositivo', e);
      }
    });
  }, [applyVolumes]);

  // Som de "aperte para falar" ativado/desativado, só dentro da call.
  useEffect(() => {
    if (!channelId) return;
    const isKey = (e: KeyboardEvent) => getSettings().inputMode === 'ptt' && !!getSettings().pttKey && e.code === getSettings().pttKey;
    const down = (e: KeyboardEvent) => isKey(e) && !e.repeat && !muted && !deafRef.current && playSound('ptt_on');
    const up = (e: KeyboardEvent) => isKey(e) && !muted && !deafRef.current && playSound('ptt_off');
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, [channelId, muted]);

  // Sai da sala ao fechar a aba
  useEffect(() => () => void roomRef.current?.disconnect(), []);

  const toggleMute = async () => {
    const next = !muted;
    if (!next && micBlocked()) {
      toast(serverRef.current.deaf ? 'Você foi ensurdecido no servidor' : 'Você foi silenciado no servidor');
      return;
    }
    setMuted(next);
    playSound(next ? 'mute' : 'unmute');
    if (!next && deafened) toggleDeafen();
    const room = roomRef.current;
    if (room) {
      await room.localParticipant.setMicrophoneEnabled(!next, micConstraints()).catch(() => {});
      if (!next) await attachMicProcessor(room);
    }
  };

  const toggleDeafen = () => {
    const next = !deafRef.current;
    if (!next && serverRef.current.deaf) {
      toast('Você foi ensurdecido no servidor');
      return;
    }
    deafRef.current = next;
    playSound(next ? 'deafen' : 'undeafen');
    setDeafened(next);
    applyVolumes();
    const room = roomRef.current;
    if (room)
      void room.localParticipant
        .setMicrophoneEnabled(!next && !muted && !micBlocked(), micConstraints())
        .then(() => (!next && !muted && !micBlocked() ? attachMicProcessor(room) : undefined))
        .catch(() => {});
  };

  /** O dono do servidor silenciou ou ensurdeceu (ou liberou) esta pessoa. */
  const setServerState = (mute: boolean, deaf: boolean) => {
    const prev = serverRef.current;
    if (prev.mute === mute && prev.deaf === deaf) return;
    const wasBlocked = micBlocked();
    serverRef.current = { mute, deaf };
    setServer(serverRef.current);
    applyVolumes();
    const room = roomRef.current;
    if (!room) return;
    if (micBlocked()) void room.localParticipant.setMicrophoneEnabled(false).catch(() => {});
    else if (wasBlocked && !muted && !deafRef.current)
      void room.localParticipant
        .setMicrophoneEnabled(true, micConstraints())
        .then(() => attachMicProcessor(room))
        .catch(() => {});
  };

  const toggleCamera = async () => {
    const lp = roomRef.current?.localParticipant;
    if (lp) await lp.setCameraEnabled(!lp.isCameraEnabled, {
      resolution: { width: 1280, height: 720, frameRate: 30 },
      deviceId: getSettings().videoDeviceId || undefined,
    });
    rerender();
  };

  const stopNativeAudio = () => {
    const n = nativeAudio.current;
    if (!n) return;
    nativeAudio.current = null;
    n.stop();
    const lp = roomRef.current?.localParticipant;
    const pub = lp?.getTrackPublication(Track.Source.ScreenShareAudio);
    if (lp && pub?.track?.mediaStreamTrack === n.track) void lp.unpublishTrack(pub.track).catch(() => {});
  };

  const startShare = async (opts: ShareOptions) => {
    const lp = roomRef.current?.localParticipant;
    if (!lp) return;
    const r = RESOLUTIONS[opts.resolution];
    const bitrate = shareBitrate(opts.resolution, opts.fps);
    // App de computador novo no Windows 11: o som vem por fora, já sem as vozes da call.
    const useNative = opts.audio && getSettings().streamRemoveCall && (await nativeSystemAudioAvailable());
    await lp.setScreenShareEnabled(
      true,
      {
        // Áudio da transmissão: sem os filtros de voz (estragam música e jogo) e sem o som do próprio
        // Nexo, senão quem assiste ouve a própria voz de volta (retorno).
        // - Navegador: restrictOwnAudio tira o som da aba do Nexo do áudio do sistema.
        // - App de computador: o Electron captura o som do Windows inteiro, com as vozes da call.
        //   O cancelamento de eco do Chromium usa como referência exatamente o som que o Nexo está
        //   tocando, e como a captura é digital (sem caixa de som no meio) ele consegue apagar as vozes.
        audio: opts.audio && !useNative ? shareAudioOptions() : false,
        systemAudio: opts.audio && !useNative ? 'include' : 'exclude',
        // Nativa: sem limite de tamanho (largura 0 = sem teto), só o fps.
        resolution: { width: r.width, height: r.height, frameRate: opts.fps },
        // Sempre "motion": com "detail" o Chrome trata como apresentação e, quando falta CPU ou
        // internet, pula quadros em vez de baixar a resolução, o que dá a sensação de travada.
        contentHint: 'motion',
        selfBrowserSurface: 'exclude',
        surfaceSwitching: 'include',
      },
      {
        // H.264 tem codificação por hardware na maioria dos PCs; VP9 e AV1 pesam mais.
        // Com VP9/AV1 vai uma cópia em H.264 junto para quem não consegue decodificar.
        videoCodec: opts.codec,
        backupCodec: opts.codec !== 'h264' ? { codec: 'h264' } : false,
        // Uma única camada em qualidade cheia: quem assiste não cai para uma versão borrada.
        simulcast: false,
        screenShareEncoding: { maxBitrate: bitrate, maxFramerate: opts.fps, priority: 'high' },
        // Som da transmissão (navegador e app sem a captura nativa): sem estas opções ele herdava as
        // da voz (mono, 64 kbps e DTX cortando o "silêncio"), o que deixava música e jogo abafados
        // e picotados. Agora vai como música: estéreo, 128 kbps, sem DTX nem RED.
        dtx: false,
        red: false,
        forceStereo: true,
        audioPreset: { maxBitrate: 128_000 },
        // Equilibrado: divide a perda entre resolução e fps.
        // Jogo/vídeo: segura o fps e reduz a resolução quando a internet ou a CPU não dão conta.
        degradationPreference: opts.optimizeFor === 'detail' ? 'balanced' : 'maintain-framerate',
      },
    );
    // O Chrome captura a tela a 30 fps se ninguém pedir mais. Pede o fps direto na captura
    // (vale também para a qualidade nativa, em que a resolução fica livre).
    const screen = lp.getTrackPublication(Track.Source.ScreenShare)?.track?.mediaStreamTrack;
    if (screen && opts.fps >= 60) await screen.applyConstraints({ frameRate: { ideal: 60, min: 30 } }).catch(() => {});
    if (useNative && screen) {
      stopNativeAudio();
      const native = await startNativeSystemAudio();
      if (native && lp.getTrackPublication(Track.Source.ScreenShare)) {
        nativeAudio.current = native;
        await lp
          .publishTrack(native.track, {
            source: Track.Source.ScreenShareAudio,
            name: 'screen_share_audio',
            // Música e jogo: sem cortar silêncio, estéreo e com bitrate de música.
            dtx: false,
            red: false,
            forceStereo: true,
            audioPreset: { maxBitrate: 128_000 },
          })
          .catch((e) => {
            console.warn('Não deu para publicar o som da transmissão', e);
            stopNativeAudio();
          });
      } else native?.stop();
    }
    shareOpts.current = opts;
    rerender();
  };

  const shareOpts = useRef<ShareOptions | null>(null);

  /** Muda resolução, fps e otimização no meio da transmissão, sem escolher a tela de novo. */
  const updateShare = async (opts: ShareOptions) => {
    const pub = roomRef.current?.localParticipant.getTrackPublication(Track.Source.ScreenShare);
    const track = pub?.track;
    if (!track) return;
    const r = RESOLUTIONS[opts.resolution];
    await track.mediaStreamTrack
      .applyConstraints({
        ...(r.width ? { width: { ideal: r.width }, height: { ideal: r.height } } : { width: { ideal: 7680 }, height: { ideal: 4320 } }),
        frameRate: { ideal: opts.fps },
      })
      .catch(() => {});
    const sender = track.sender;
    if (sender) {
      const params = sender.getParameters();
      for (const e of params.encodings ?? []) {
        e.maxBitrate = shareBitrate(opts.resolution, opts.fps);
        e.maxFramerate = opts.fps;
      }
      (params as RTCRtpSendParameters & { degradationPreference?: string }).degradationPreference =
        opts.optimizeFor === 'detail' ? 'balanced' : 'maintain-framerate';
      await sender.setParameters(params).catch(() => {});
    }
    shareOpts.current = { ...opts, codec: shareOpts.current?.codec ?? opts.codec, audio: shareOpts.current?.audio ?? opts.audio };
    rerender();
  };

  /** Troca a tela ou janela transmitida (o navegador pergunta de novo) mantendo a qualidade. */
  const switchShare = async () => {
    const opts = shareOpts.current;
    if (!opts) return;
    stopNativeAudio();
    await roomRef.current?.localParticipant.setScreenShareEnabled(false);
    await startShare(opts);
  };

  const stopShare = async () => {
    stopNativeAudio();
    await roomRef.current?.localParticipant.setScreenShareEnabled(false);
    shareOpts.current = null;
    rerender();
  };

  const setWatch = (identity: string, on: boolean) => {
    const p = roomRef.current?.remoteParticipants.get(identity);
    if (!p) return;
    for (const pub of p.trackPublications.values()) {
      if (pub.source === Track.Source.ScreenShare || pub.source === Track.Source.ScreenShareAudio) pub.setSubscribed(on);
    }
    setWatching(({ [identity]: _, ...rest }) => (on ? { ...rest, [identity]: true } : rest));
  };

  /** Manda um emoji para todo mundo da call (canal de dados do LiveKit, sem passar pelo nosso servidor). */
  const sendReaction = (emoji: string) => {
    const lp = roomRef.current?.localParticipant;
    if (!lp) return;
    addFloating(emoji, lp.name || '');
    void lp.publishData(new TextEncoder().encode(JSON.stringify({ emoji })), { reliable: true, topic: 'reaction' }).catch(() => {});
  };

  const room = roomRef.current;
  const toUser = (p: Participant, isLocal: boolean): VoiceUser => {
    const screenPub = p.getTrackPublication(Track.Source.ScreenShare);
    const camPub = p.getTrackPublication(Track.Source.Camera);
    const micPub = p.getTrackPublication(Track.Source.Microphone);
    return {
      identity: p.identity,
      name: p.name || p.identity,
      isLocal,
      speaking: p.isSpeaking,
      micMuted: !micPub || micPub.isMuted,
      camera: camPub && !camPub.isMuted ? camPub.track : undefined,
      screen: screenPub?.track,
      isSharing: !!screenPub,
      watching: isLocal || !!watching[p.identity],
    };
  };
  const users: VoiceUser[] = room
    ? [toUser(room.localParticipant, true), ...[...room.remoteParticipants.values()].map((p: RemoteParticipant) => toUser(p, false))]
    : [];
  const local = users[0];

  return {
    channelId,
    connecting,
    reconnecting,
    users,
    muted,
    deafened,
    serverMuted: server.mute,
    serverDeafened: server.deaf,
    setServerState,
    camera: !!local?.camera,
    sharing: !!local?.isSharing,
    join,
    leave,
    toggleMute,
    toggleDeafen,
    toggleCamera,
    startShare,
    stopShare,
    updateShare,
    switchShare,
    shareOptions: shareOpts.current,
    setWatch,
    floating,
    sendReaction,
  };
}

export type Voice = ReturnType<typeof useVoice>;
