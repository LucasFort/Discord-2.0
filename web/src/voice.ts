import { useCallback, useEffect, useRef, useState } from 'react';
import {
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
const needsMicProcessor = (s: Settings) => s.echoGate || s.autoBoost || s.strongNoiseSuppression || s.inputMode === 'ptt' || !s.autoSensitivity || s.inputVolume !== 100;

/**
 * Volume final de cada áudio: volume geral × volume da pessoa (voz) ou da transmissão dela
 * (áudio da tela), no máximo 100%. Assim dá para baixar o jogo/vídeo sem baixar a voz.
 */
function volumeFor(identity: string, source: Track.Source, deaf: boolean, s: Settings = getSettings()) {
  if (deaf) return 0;
  const own = source === Track.Source.ScreenShareAudio ? (s.streamVolumes[identity] ?? 100) : (s.userVolumes[identity] ?? 100);
  return Math.min(1, (s.outputVolume / 100) * (own / 100));
}
import type { Gateway } from './store';

export type ShareQuality = '720p30' | '1080p30' | '1080p60' | 'source60';
export type ShareOptions = { quality: ShareQuality; audio: boolean; optimizeFor: 'detail' | 'motion' };

/** Resolução, fps e taxa de bits de cada opção de qualidade da transmissão. */
export const QUALITY: Record<ShareQuality, { label: string; width?: number; height?: number; fps: number; bitrate: number }> = {
  '720p30': { label: '720p · 30 fps', width: 1280, height: 720, fps: 30, bitrate: 2_000_000 },
  '1080p30': { label: '1080p · 30 fps', width: 1920, height: 1080, fps: 30, bitrate: 3_500_000 },
  '1080p60': { label: '1080p · 60 fps', width: 1920, height: 1080, fps: 60, bitrate: 6_000_000 },
  source60: { label: 'Nativa · 60 fps', fps: 60, bitrate: 10_000_000 },
};

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
  const audioBox = useRef<HTMLDivElement | null>(null);
  const [channelId, setChannelId] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const leavingRef = useRef(false); // true quando a pessoa clicou em sair (não reconectar)
  const rejoinTries = useRef(0);
  const [muted, setMuted] = useState(false);
  const [deafened, setDeafened] = useState(false);
  const deafRef = useRef(false);
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

  const autoSubscribe = (pub: RemoteTrackPublication) => {
    if (pub.source === Track.Source.Microphone || pub.source === Track.Source.Camera) pub.setSubscribed(true);
  };

  const leave = useCallback(async () => {
    leavingRef.current = true;
    const room = roomRef.current;
    roomRef.current = null;
    await room?.disconnect();
    activeMic = null;
    if (room) playSound('leave');
    if (audioBox.current) audioBox.current.innerHTML = '';
    setFloating([]);
    setChannelId(null);
    setWatching({});
    setReconnecting(false);
    gateway.send({ op: 'voice_state', channel_id: null });
  }, [gateway]);

  const join = useCallback(
    async (id: string) => {
      if (roomRef.current) await leave();
      leavingRef.current = false;
      setConnecting(true);
      // Cria o áudio ainda dentro do clique (o navegador só libera som que começa num clique).
      if (needsMicProcessor(getSettings())) {
        micCtx ??= newAudioContext();
        void micCtx.resume().catch(() => {});
      }
      try {
        const { url, token } = await api<{ url: string; token: string }>('POST', `/channels/${id}/voice-token`);
        const room = new Room({
          adaptiveStream: true,
          dynacast: true,
          // Voz: Opus com DTX (não manda nada no silêncio) e RED (redundância contra perda de pacotes).
          publishDefaults: { dtx: true, red: true },
          audioCaptureDefaults: micConstraints(),
          audioOutput: getSettings().outputDeviceId ? { deviceId: getSettings().outputDeviceId } : undefined,
          videoCaptureDefaults: getSettings().videoDeviceId ? { deviceId: getSettings().videoDeviceId } : undefined,
        });
        roomRef.current = room;

        room
          .on(RoomEvent.TrackPublished, (pub, _p) => {
            autoSubscribe(pub);
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
              (track as RemoteAudioTrack).setVolume(volumeFor(p.identity, pub.source, deafRef.current));
            }
            rerender();
          })
          .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
            track.detach().forEach((el) => el.remove());
            feedRemoteAudio(room);
            rerender();
          })
          .on(RoomEvent.TrackUnpublished, (pub, p) => {
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
          .on(RoomEvent.ActiveSpeakersChanged, rerender)
          .on(RoomEvent.LocalTrackPublished, rerender)
          .on(RoomEvent.LocalTrackUnpublished, rerender)
          .on(RoomEvent.Reconnecting, () => setReconnecting(true))
          .on(RoomEvent.Reconnected, () => setReconnecting(false))
          .on(RoomEvent.Disconnected, () => {
            if (roomRef.current !== room) return;
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
        room.remoteParticipants.forEach((p) => p.trackPublications.forEach(autoSubscribe));
        // Sem microfone (permissão negada ou nenhum dispositivo) a pessoa ainda entra, só que mutada.
        try {
          await room.localParticipant.setMicrophoneEnabled(!muted && !deafRef.current, micConstraints());
          await attachMicProcessor(room);
        } catch (e) {
          setMuted(true);
          alert(`Entrou na call sem microfone: ${(e as Error).message}. Libere o microfone no cadeado da barra de endereço.`);
        }
        await room.startAudio().catch(() => {});
        setChannelId(id);
        setReconnecting(false);
        if (rejoinTries.current === 0) playSound('join'); // reconexão automática não toca de novo
        rejoinTries.current = 0;
        gateway.send({ op: 'voice_state', channel_id: id });
      } catch (e) {
        await roomRef.current?.disconnect();
        roomRef.current = null;
        alert(`Não foi possível entrar na voz: ${(e as Error).message}`);
      } finally {
        setConnecting(false);
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
        console.warn('Áudio do navegador parado: microfone vai sem processamento');
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
      p.audioTrackPublications.forEach((pub) => (pub.track as RemoteAudioTrack | undefined)?.setVolume(volumeFor(p.identity, pub.source, deafRef.current))),
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
      } catch (e) {
        console.warn('Não deu para trocar o dispositivo', e);
      }
    });
  }, [applyVolumes]);

  // Sai da sala ao fechar a aba
  useEffect(() => () => void roomRef.current?.disconnect(), []);

  const toggleMute = async () => {
    const next = !muted;
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
    deafRef.current = next;
    playSound(next ? 'mute' : 'unmute');
    setDeafened(next);
    applyVolumes();
    const room = roomRef.current;
    if (room)
      void room.localParticipant
        .setMicrophoneEnabled(!next && !muted, micConstraints())
        .then(() => (!next && !muted ? attachMicProcessor(room) : undefined))
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

  const startShare = async (opts: ShareOptions) => {
    const lp = roomRef.current?.localParticipant;
    if (!lp) return;
    const q = QUALITY[opts.quality];
    await lp.setScreenShareEnabled(
      true,
      {
        // Áudio da transmissão: sem os filtros de voz (estragam música e jogo) e, onde o navegador
        // deixa, sem o som do próprio Nexo. Senão quem assiste ouve a própria voz de volta (eco).
        audio: opts.audio
          ? ({ echoCancellation: false, noiseSuppression: false, autoGainControl: false, restrictOwnAudio: true, suppressLocalAudioPlayback: false } as AudioCaptureOptions)
          : false,
        systemAudio: opts.audio ? 'include' : 'exclude',
        // Nativa: sem limite de tamanho (largura 0 = sem teto), só o fps.
        resolution: { width: q.width ?? 0, height: q.height ?? 0, frameRate: q.fps },
        // Sempre "motion": com "detail" o Chrome trata como apresentação e, quando falta CPU ou
        // internet, pula quadros em vez de baixar a resolução, o que dá a sensação de travada.
        contentHint: 'motion',
        selfBrowserSurface: 'exclude',
        surfaceSwitching: 'include',
      },
      {
        // H.264 tem codificação por hardware na maioria dos PCs; VP9 em software travava o fps e a voz.
        videoCodec: 'h264',
        backupCodec: false,
        // Uma única camada em qualidade cheia: quem assiste não cai para uma versão borrada.
        simulcast: false,
        screenShareEncoding: { maxBitrate: q.bitrate, maxFramerate: q.fps, priority: 'high' },
        // Equilibrado: divide a perda entre resolução e fps.
        // Jogo/vídeo: segura o fps e reduz a resolução quando a internet ou a CPU não dão conta.
        degradationPreference: opts.optimizeFor === 'detail' ? 'balanced' : 'maintain-framerate',
      },
    );
    // O Chrome captura a tela a 30 fps se ninguém pedir mais. Pede os 60 fps direto na captura
    // (vale também para a qualidade nativa, em que a resolução fica livre).
    const screen = lp.getTrackPublication(Track.Source.ScreenShare)?.track?.mediaStreamTrack;
    if (screen && q.fps >= 60) await screen.applyConstraints({ frameRate: { ideal: 60, min: 30 } }).catch(() => {});
    rerender();
  };

  const stopShare = async () => {
    await roomRef.current?.localParticipant.setScreenShareEnabled(false);
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
    camera: !!local?.camera,
    sharing: !!local?.isSharing,
    join,
    leave,
    toggleMute,
    toggleDeafen,
    toggleCamera,
    startShare,
    stopShare,
    setWatch,
    floating,
    sendReaction,
  };
}

export type Voice = ReturnType<typeof useVoice>;
