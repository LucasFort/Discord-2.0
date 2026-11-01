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
} from 'livekit-client';
import { api } from './api';
import type { Gateway } from './store';

export type ShareQuality = '720p30' | '1080p30' | '1080p60' | 'source60';
export type ShareOptions = { quality: ShareQuality; audio: boolean; optimizeFor: 'detail' | 'motion' };

/** Resolução, fps e taxa de bits de cada opção de qualidade da transmissão. */
export const QUALITY: Record<ShareQuality, { label: string; width?: number; height?: number; fps: number; bitrate: number }> = {
  '720p30': { label: '720p · 30 fps', width: 1280, height: 720, fps: 30, bitrate: 2_000_000 },
  '1080p30': { label: '1080p · 30 fps', width: 1920, height: 1080, fps: 30, bitrate: 3_500_000 },
  '1080p60': { label: '1080p · 60 fps', width: 1920, height: 1080, fps: 60, bitrate: 6_000_000 },
  source60: { label: 'Original · 60 fps', fps: 60, bitrate: 10_000_000 },
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
  const [muted, setMuted] = useState(false);
  const [deafened, setDeafened] = useState(false);
  const deafRef = useRef(false);
  const [watching, setWatching] = useState<Record<string, true>>({});
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
    const room = roomRef.current;
    roomRef.current = null;
    await room?.disconnect();
    if (audioBox.current) audioBox.current.innerHTML = '';
    setChannelId(null);
    setWatching({});
    gateway.send({ op: 'voice_state', channel_id: null });
  }, [gateway]);

  const join = useCallback(
    async (id: string) => {
      if (roomRef.current) await leave();
      setConnecting(true);
      try {
        const { url, token } = await api<{ url: string; token: string }>('POST', `/channels/${id}/voice-token`);
        const room = new Room({ adaptiveStream: true, dynacast: true });
        roomRef.current = room;

        room
          .on(RoomEvent.TrackPublished, (pub, _p) => {
            autoSubscribe(pub);
            rerender();
          })
          .on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
            if (track.kind === Track.Kind.Audio) {
              audioBox.current?.appendChild(track.attach());
              if (deafRef.current) (track as RemoteAudioTrack).setVolume(0);
            }
            rerender();
          })
          .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
            track.detach().forEach((el) => el.remove());
            rerender();
          })
          .on(RoomEvent.TrackUnpublished, (pub, p) => {
            if (pub.source === Track.Source.ScreenShare) setWatching(({ [p.identity]: _, ...rest }) => rest);
            rerender();
          })
          .on(RoomEvent.ParticipantConnected, rerender)
          .on(RoomEvent.ParticipantDisconnected, rerender)
          .on(RoomEvent.TrackMuted, rerender)
          .on(RoomEvent.TrackUnmuted, rerender)
          .on(RoomEvent.ActiveSpeakersChanged, rerender)
          .on(RoomEvent.LocalTrackPublished, rerender)
          .on(RoomEvent.LocalTrackUnpublished, rerender)
          .on(RoomEvent.Disconnected, () => {
            if (roomRef.current === room) leave();
          });

        await room.connect(url, token, { autoSubscribe: false });
        room.remoteParticipants.forEach((p) => p.trackPublications.forEach(autoSubscribe));
        await room.localParticipant.setMicrophoneEnabled(!muted && !deafRef.current, {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        });
        await room.startAudio().catch(() => {});
        setChannelId(id);
        gateway.send({ op: 'voice_state', channel_id: id });
      } catch (e) {
        roomRef.current = null;
        alert(`Não foi possível entrar na voz: ${(e as Error).message}`);
      } finally {
        setConnecting(false);
      }
    },
    [gateway, leave, muted, rerender],
  );

  // Sai da sala ao fechar a aba
  useEffect(() => () => void roomRef.current?.disconnect(), []);

  const toggleMute = async () => {
    const next = !muted;
    setMuted(next);
    if (!next && deafened) toggleDeafen();
    await roomRef.current?.localParticipant.setMicrophoneEnabled(!next);
  };

  const toggleDeafen = () => {
    const next = !deafRef.current;
    deafRef.current = next;
    setDeafened(next);
    roomRef.current?.remoteParticipants.forEach((p) =>
      p.audioTrackPublications.forEach((pub) => (pub.track as RemoteAudioTrack | undefined)?.setVolume(next ? 0 : 1)),
    );
    roomRef.current?.localParticipant.setMicrophoneEnabled(!next && !muted);
  };

  const toggleCamera = async () => {
    const lp = roomRef.current?.localParticipant;
    if (lp) await lp.setCameraEnabled(!lp.isCameraEnabled, { resolution: { width: 1280, height: 720, frameRate: 30 } });
    rerender();
  };

  const startShare = async (opts: ShareOptions) => {
    const lp = roomRef.current?.localParticipant;
    if (!lp) return;
    const q = QUALITY[opts.quality];
    await lp.setScreenShareEnabled(
      true,
      {
        audio: opts.audio,
        systemAudio: opts.audio ? 'include' : 'exclude',
        resolution: q.width ? { width: q.width, height: q.height!, frameRate: q.fps } : undefined,
        contentHint: opts.optimizeFor,
        selfBrowserSurface: 'exclude',
        surfaceSwitching: 'include',
      },
      {
        videoCodec: 'vp9',
        backupCodec: true,
        screenShareEncoding: { maxBitrate: q.bitrate, maxFramerate: q.fps },
      },
    );
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
  };
}

export type Voice = ReturnType<typeof useVoice>;
