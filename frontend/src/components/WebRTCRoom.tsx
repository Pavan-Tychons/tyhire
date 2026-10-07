"use client";

import { useEffect, useRef, useState, useMemo } from "react";
import { BASE_URL } from "@/lib/api";
import type { IceServer } from "@/lib/types";
import { LiveKitRoom, RoomAudioRenderer, useTracks, VideoTrack } from "@livekit/components-react";
import { Track, Room, RoomEvent } from "livekit-client";
import EyeTrackingOverlay from "@/components/EyeTrackingOverlay";

export interface WebRTCApi {
  /** Toggles the local mic; returns the new muted state. */
  toggleMic: () => boolean;
  /** Toggles the local camera; returns the new camera-off state. */
  toggleCamera: () => boolean;
  /** Interviewer-only: asks the candidate's page to mute itself. */
  requestPeerMute: () => void;
  /** Tells the other participant's page the call is over from this end. */
  notifyPeerEnded: () => void;
}

interface WebRTCRoomProps {
  sessionId: string;
  token: string;
  role: "candidate" | "interviewer";
  iceServers: IceServer[] | null;
  extraVideoTrack?: MediaStreamTrack | null;
  onApiReady?: (api: WebRTCApi) => void;
  onMuteRequested?: () => void;
  onPeerEnded?: () => void;
  onPeerConnectedChange?: (connected: boolean) => void;
  livekitToken?: string | null;
  livekitUrl?: string | null;
  enableEyeTracking?: boolean;
  onGazeChange?: (isFocused: boolean, isTeleprompter?: boolean) => void;
}

function wsBaseUrl(): string {
  if (BASE_URL.startsWith("http")) return BASE_URL.replace(/^http/, "ws");
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  
  if (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1") {
    return `${proto}//${window.location.hostname}:8000${BASE_URL}`;
  }
  
  return `${proto}//${window.location.host}${BASE_URL}`;
}

const DEFAULT_ICE_SERVERS: IceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

/** Tells the peer which incoming video track is the screen share. Without this the
 * receiving side has to guess from arrival order, and with two video m-lines that order
 * isn't guaranteed — guessing wrong silently swaps the camera and screen panels. */
function announceScreenTrack(ws: WebSocket | null, track: MediaStreamTrack, streamId: string) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: "screen-track", trackId: track.id, streamId }));
}

export default function WebRTCRoom({
  sessionId,
  token,
  role,
  iceServers,
  extraVideoTrack,
  onApiReady,
  onMuteRequested,
  onPeerEnded,
  onPeerConnectedChange,
  livekitToken,
  livekitUrl,
  enableEyeTracking = false,
  onGazeChange,
}: WebRTCRoomProps) {
  if (livekitToken && livekitUrl) {
    return (
      <LiveKitRoomRenderer
        sessionId={sessionId}
        token={livekitToken}
        role={role}
        url={livekitUrl}
        extraVideoTrack={extraVideoTrack}
        onApiReady={onApiReady}
        onMuteRequested={onMuteRequested}
        onPeerEnded={onPeerEnded}
        onPeerConnectedChange={onPeerConnectedChange}
        enableEyeTracking={enableEyeTracking}
        onGazeChange={onGazeChange}
      />
    );
  }

  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const remoteScreenRef = useRef<HTMLVideoElement>(null);
  const remoteAudioRef = useRef<HTMLAudioElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [hasRemoteScreen, setHasRemoteScreen] = useState(false);
  const [peerPresent, setPeerPresent] = useState(false);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const extraVideoTrackRef = useRef<MediaStreamTrack | null | undefined>(extraVideoTrack);
  const tracksAddedRef = useRef(false);
  // What was announced to the peer for the local screen-share track, kept so it can be
  // re-sent verbatim if the peer joins later (an announcement made to an empty room is
  // simply dropped by the relay).
  const announcedScreenRef = useRef<{ trackId: string; streamId: string } | null>(null);

  // Stashed streams in case ref is not immediately bound
  const remoteCameraStreamRef = useRef<MediaStream | null>(null);
  const remoteScreenStreamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    extraVideoTrackRef.current = extraVideoTrack;
    if (extraVideoTrack && pcRef.current && tracksAddedRef.current) {
      const senders = pcRef.current.getSenders();
      const alreadyAdded = senders.some((s) => s.track === extraVideoTrack);
      if (!alreadyAdded) {
        const screenStream = new MediaStream([extraVideoTrack]);
        pcRef.current.addTrack(extraVideoTrack, screenStream);
        announceScreenTrack(wsRef.current, extraVideoTrack, screenStream.id);
        announcedScreenRef.current = { trackId: extraVideoTrack.id, streamId: screenStream.id };
      }
    }
    // Only after having actually announced one — otherwise the interviewer side (whose
    // extraVideoTrack is always null) would fire this on mount and blank the candidate's
    // panel for a screen share that was never claimed in the first place.
    if (!extraVideoTrack && announcedScreenRef.current) {
      announcedScreenRef.current = null;
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "screen-track-ended" }));
      }
    }
  }, [extraVideoTrack]);

  // Keep video elements synced whenever hasRemoteScreen updates
  useEffect(() => {
    if (remoteScreenRef.current && remoteScreenStreamRef.current) {
      remoteScreenRef.current.srcObject = remoteScreenStreamRef.current;
      remoteScreenRef.current.play().catch(() => {});
    }
    if (remoteVideoRef.current && remoteCameraStreamRef.current) {
      remoteVideoRef.current.srcObject = remoteCameraStreamRef.current;
      remoteVideoRef.current.play().catch(() => {});
    }
  }, [hasRemoteScreen]);

  useEffect(() => {
    let cancelled = false;
    let pc: RTCPeerConnection | null = null;
    let ws: WebSocket | null = null;
    let localStream: MediaStream | null = null;
    let remoteCameraTrackId: string | null = null;

    // Queue for ICE candidates arriving before setRemoteDescription
    const pendingIceCandidates: RTCIceCandidateInit[] = [];

    // Which remote video track is the screen share, per the peer's own "screen-track"
    // message (see announceScreenTrack). The announcement and the track itself race each
    // other over two different channels, so every video track seen is remembered and
    // re-classified if the announcement lands second.
    const announcedScreenIds = new Set<string>();
    const seenVideo = new Map<string, MediaStream>();

    function isScreenTrack(trackId: string, stream: MediaStream): boolean {
      return announcedScreenIds.has(trackId) || announcedScreenIds.has(stream.id);
    }

    function attachScreen(stream: MediaStream) {
      remoteScreenStreamRef.current = stream;
      if (remoteScreenRef.current) {
        remoteScreenRef.current.srcObject = stream;
        remoteScreenRef.current.play().catch(() => {});
      }
      setHasRemoteScreen(true);
    }

    function detachScreen() {
      remoteScreenStreamRef.current = null;
      if (remoteScreenRef.current) remoteScreenRef.current.srcObject = null;
      setHasRemoteScreen(false);
    }

    function attachCamera(trackId: string, stream: MediaStream) {
      remoteCameraTrackId = trackId;
      remoteCameraStreamRef.current = stream;
      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = stream;
        remoteVideoRef.current.play().catch(() => {});
      }
    }

    function classifyVideoTrack(trackId: string, stream: MediaStream) {
      if (isScreenTrack(trackId, stream)) {
        attachScreen(stream);
      } else if (!remoteCameraTrackId) {
        attachCamera(trackId, stream);
      } else if (trackId !== remoteCameraTrackId) {
        // Unannounced second video track — the peer is on an older build or the message
        // was lost; arrival order is the only thing left to go on.
        attachScreen(stream);
      }
    }

    /** Re-runs classification once a late "screen-track" announcement identifies a track
     * that was already filed (possibly as the camera). */
    function reclassifyAnnouncedScreen() {
      for (const [trackId, stream] of seenVideo) {
        if (!isScreenTrack(trackId, stream)) continue;
        if (remoteCameraTrackId === trackId) {
          remoteCameraTrackId = null;
          remoteCameraStreamRef.current = null;
          if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
          for (const [otherId, otherStream] of seenVideo) {
            if (otherId !== trackId && !isScreenTrack(otherId, otherStream)) {
              attachCamera(otherId, otherStream);
              break;
            }
          }
        }
        attachScreen(stream);
      }
    }

    const polite = role === "candidate";
    let makingOffer = false;
    let ignoreOffer = false;

    function send(message: Record<string, unknown>) {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
    }

    async function start() {
      try {
        localStream = await navigator.mediaDevices.getUserMedia({
          video: {
            width: { ideal: 640, max: 1280 },
            height: { ideal: 480, max: 720 },
            frameRate: { ideal: 15, max: 24 }
          },
          audio: true
        });
      } catch (e) {
        console.warn("Could not acquire local camera/mic", e);
      }

      if (cancelled) {
        localStream?.getTracks().forEach((t) => t.stop());
        return;
      }
      if (localVideoRef.current && localStream) localVideoRef.current.srcObject = localStream;

      pc = new RTCPeerConnection({
        iceServers: (iceServers && iceServers.length > 0 ? iceServers : DEFAULT_ICE_SERVERS).map(
          (s) => ({ urls: s.urls, username: s.username, credential: s.credential })
        ),
      });
      pcRef.current = pc;

      function addLocalTracks() {
        if (tracksAddedRef.current || !pc) return;
        tracksAddedRef.current = true;
        if (localStream) {
          localStream.getTracks().forEach((track) => pc!.addTrack(track, localStream!));
        }
        if (extraVideoTrackRef.current) {
          const screenStream = new MediaStream([extraVideoTrackRef.current]);
          pc.addTrack(extraVideoTrackRef.current, screenStream);
          announceScreenTrack(ws, extraVideoTrackRef.current, screenStream.id);
          announcedScreenRef.current = {
            trackId: extraVideoTrackRef.current.id,
            streamId: screenStream.id,
          };
        }
      }

      pc.onnegotiationneeded = async () => {
        try {
          makingOffer = true;
          await pc!.setLocalDescription();
          send({ type: pc!.localDescription!.type, sdp: pc!.localDescription!.sdp });
        } catch (err) {
          console.error("negotiation failed", err);
        } finally {
          makingOffer = false;
        }
      };

      pc.onicecandidate = ({ candidate }) => {
        if (candidate) send({ type: "ice-candidate", candidate: candidate.toJSON() });
      };

      pc.onconnectionstatechange = () => {
        onPeerConnectedChange?.(pc?.connectionState === "connected");
      };

      pc.ontrack = (event) => {
        const track = event.track;
        if (track.kind === "audio") {
          if (remoteAudioRef.current) {
            const stream = event.streams[0] || new MediaStream([track]);
            remoteAudioRef.current.srcObject = stream;
            remoteAudioRef.current.play().catch(() => {});
          }
        } else if (track.kind === "video") {
          const stream = event.streams[0] || new MediaStream([track]);
          seenVideo.set(track.id, stream);
          classifyVideoTrack(track.id, stream);

          track.onunmute = () => {
            // Re-attach on unmute rather than re-deciding: a track's role doesn't change,
            // and re-running the guess here is what previously let a screen share land in
            // the camera panel after a brief mute.
            if (isScreenTrack(track.id, stream)) {
              attachScreen(stream);
            } else if (remoteVideoRef.current) {
              remoteVideoRef.current.srcObject = stream;
              remoteVideoRef.current.play().catch(() => {});
            }
          };

          track.onended = () => {
            if (isScreenTrack(track.id, stream)) detachScreen();
          };
        }
      };

      onApiReady?.({
        toggleMic: () => {
          const track = localStream?.getAudioTracks()[0];
          if (!track) return false;
          track.enabled = !track.enabled;
          return !track.enabled;
        },
        toggleCamera: () => {
          const track = localStream?.getVideoTracks()[0];
          if (!track) return false;
          track.enabled = !track.enabled;
          return !track.enabled;
        },
        requestPeerMute: () => send({ type: "mute-request" }),
        notifyPeerEnded: () => send({ type: "call-ended" }),
      });

      const wsUrl = `${wsBaseUrl()}/interviews/${sessionId}/ws/signal?token=${encodeURIComponent(
        token
      )}&role=${role}`;
      ws = new WebSocket(wsUrl);
      wsRef.current = ws;
      ws.onmessage = async (event) => {
        const message = JSON.parse(event.data);
        if (message.type === "peer-joined") {
          setPeerPresent(true);
          // Only the candidate initiates. The relay delivers "peer-joined" to both
          // browsers at the same instant, so when both sides addTrack here they both fire
          // onnegotiationneeded and offer simultaneously — glare on every single call. The
          // impolite side (interviewer) then drops the candidate's offer, and that offer is
          // the only one carrying the screen-share m-line, so the screen share ended up
          // never negotiated at all. The interviewer adds its own tracks when the offer
          // arrives (below), so both directions still come up in one exchange.
          if (role === "candidate") {
            if (tracksAddedRef.current) {
              // Peer reconnected (remount/refresh) with a brand-new RTCPeerConnection, so
              // it needs a fresh offer — but addLocalTracks() won't produce one, having
              // already run for the previous peer. restartIce() re-raises
              // onnegotiationneeded (with new ICE credentials, which the new peer needs
              // anyway) rather than duplicating the offer logic here.
              pc?.restartIce();
            } else {
              addLocalTracks();
            }
            // Re-sent here as well as at addTrack time: if the candidate started sharing
            // before the interviewer joined, the original announcement went to an empty
            // room and the relay dropped it.
            const announced = announcedScreenRef.current;
            if (announced && ws && ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: "screen-track", ...announced }));
            }
          }
        } else if (message.type === "screen-track") {
          if (message.trackId) announcedScreenIds.add(message.trackId);
          if (message.streamId) announcedScreenIds.add(message.streamId);
          reclassifyAnnouncedScreen();
        } else if (message.type === "screen-track-ended") {
          detachScreen();
        } else if (message.type === "peer-left") {
          setPeerPresent(false);
          onPeerConnectedChange?.(false);
          if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
          if (remoteScreenRef.current) remoteScreenRef.current.srcObject = null;
          remoteCameraTrackId = null;
          remoteCameraStreamRef.current = null;
          remoteScreenStreamRef.current = null;
          // Cleared too, so a rejoin re-classifies from scratch instead of matching this
          // call's stale track ids.
          seenVideo.clear();
          announcedScreenIds.clear();
          setHasRemoteScreen(false);
          onPeerEnded?.();
        } else if (message.type === "call-ended") {
          onPeerEnded?.();
        } else if (message.type === "offer" || message.type === "answer") {
          const description = { type: message.type, sdp: message.sdp } as RTCSessionDescriptionInit;
          const offerCollision =
            message.type === "offer" && (makingOffer || pc!.signalingState !== "stable");
          ignoreOffer = !polite && offerCollision;
          if (ignoreOffer) return;
          
          await pc!.setRemoteDescription(description);

          // Drain queued ICE candidates now that remote description is set
          while (pendingIceCandidates.length > 0) {
            const candidate = pendingIceCandidates.shift();
            if (candidate) {
              try {
                await pc!.addIceCandidate(candidate);
              } catch (e) {
                console.warn("Error adding queued ICE candidate", e);
              }
            }
          }

          if (message.type === "offer") {
            addLocalTracks();
            await pc!.setLocalDescription();
            send({ type: pc!.localDescription!.type, sdp: pc!.localDescription!.sdp });
          }
        } else if (message.type === "ice-candidate" && message.candidate) {
          // If remote description is not set yet, buffer candidate to avoid InvalidStateError
          if (!pc || !pc.remoteDescription || !pc.remoteDescription.type) {
            pendingIceCandidates.push(message.candidate);
          } else {
            try {
              await pc.addIceCandidate(message.candidate);
            } catch (err) {
              if (!ignoreOffer) console.warn("failed to add ICE candidate", err);
            }
          }
        } else if (message.type === "mute-request") {
          onMuteRequested?.();
        }
      };
    }

    start().catch((err) => console.error("Couldn't start the call", err));

    return () => {
      cancelled = true;
      tracksAddedRef.current = false;
      announcedScreenRef.current = null;
      wsRef.current = null;
      ws?.close();
      pc?.close();
      localStream?.getTracks().forEach((t) => t.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, token, role]);

  const [isGazeFocused, setIsGazeFocused] = useState(true);
  const [isTeleprompter, setIsTeleprompter] = useState(false);

  const handleGaze = (focused: boolean, teleprompter?: boolean) => {
    setIsGazeFocused(focused);
    if (teleprompter !== undefined) setIsTeleprompter(teleprompter);
    onGazeChange?.(focused, teleprompter);
  };

  // Interviewer Dynamic Gaze Border Class
  const gazeBorderClass = isTeleprompter
    ? "border-purple-500 ring-4 ring-purple-500/40 shadow-[0_0_20px_rgba(168,85,247,0.5)]"
    : isGazeFocused
    ? "border-emerald-500 ring-2 ring-emerald-500/30 shadow-[0_0_12px_rgba(16,185,129,0.3)]"
    : "border-red-500 ring-4 ring-red-500/40 shadow-[0_0_20px_rgba(239,68,68,0.5)] animate-pulse";

  if (role === "interviewer") {
    return (
      <div className="relative w-full h-full min-h-[380px] flex flex-col md:flex-row gap-3">
        <audio ref={remoteAudioRef} autoPlay playsInline className="hidden" />

        {/* Candidate Screenshare Viewport (Always in DOM) */}
        <div className="relative flex-1 min-h-[220px] bg-zinc-950 rounded-xl overflow-hidden border border-zinc-200 flex flex-col items-center justify-center">
          <video
            ref={remoteScreenRef}
            autoPlay
            playsInline
            muted
            className={`w-full h-full object-contain bg-zinc-950 ${hasRemoteScreen ? "block" : "hidden"}`}
          />
          {hasRemoteScreen && (
            <div className="absolute top-2 left-2 px-2.5 py-1 rounded-md bg-white/95 shadow text-xs font-semibold text-zinc-800 border border-zinc-200 flex items-center gap-1.5 z-10">
              <span className="w-2 h-2 rounded-full bg-blue-600 animate-pulse" />
              <span>🖥️ Candidate Screenshare (Live)</span>
            </div>
          )}
          {!hasRemoteScreen && (
            <div className="flex flex-col items-center justify-center p-6 text-center text-zinc-400">
              <span className="text-3xl mb-2">🖥️</span>
              <p className="text-xs font-medium text-zinc-300">Candidate Screen Share</p>
              <p className="text-[11px] text-zinc-500 mt-0.5">Waiting for candidate screen share stream…</p>
            </div>
          )}
        </div>

        {/* Candidate Live Camera with Gaze Border */}
        <div
          className={`relative w-full md:w-80 min-h-[220px] bg-zinc-900 rounded-xl overflow-hidden border-2 transition-all duration-300 ${gazeBorderClass}`}
        >
          {!peerPresent && (
            <p className="absolute inset-0 flex items-center justify-center text-xs text-white/60">
              Waiting for candidate to join…
            </p>
          )}
          <video
            ref={remoteVideoRef}
            autoPlay
            playsInline
            muted
            className="w-full h-full object-cover"
          />
          {enableEyeTracking && (
            <EyeTrackingOverlay videoRef={remoteVideoRef} onGazeChange={handleGaze} />
          )}

          {/* Gaze Status HUD Badge on Camera */}
          <div className="absolute top-2 left-2 px-2.5 py-1 rounded-full text-xs font-bold bg-white/95 shadow-md border border-zinc-200 flex items-center gap-1.5 z-10">
            <span
              className={`w-2 h-2 rounded-full ${
                isTeleprompter
                  ? "bg-purple-600 animate-pulse"
                  : isGazeFocused
                  ? "bg-emerald-500"
                  : "bg-red-500 animate-pulse"
              }`}
            />
            <span
              className={
                isTeleprompter
                  ? "text-purple-700 font-bold"
                  : isGazeFocused
                  ? "text-emerald-700"
                  : "text-red-600 font-bold"
              }
            >
              {isTeleprompter
                ? "⚠️ Teleprompter Reading"
                : isGazeFocused
                ? "🟢 Gaze: Focused"
                : "🔴 Gaze: Looking Away"}
            </span>
          </div>

          {/* Interviewer Self-PIP */}
          <div className="absolute bottom-2 right-2 w-24 h-16 rounded-lg overflow-hidden border border-white/40 shadow-md bg-black">
            <video
              ref={localVideoRef}
              autoPlay
              playsInline
              muted
              className="w-full h-full object-cover"
            />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="relative w-full h-full min-h-[360px] rounded-xl bg-black overflow-hidden border border-zinc-200">
      <audio ref={remoteAudioRef} autoPlay playsInline className="hidden" />
      {!peerPresent && (
        <p className="absolute inset-0 flex items-center justify-center text-sm text-white/60">
          Waiting for interviewer to join…
        </p>
      )}
      <video ref={remoteVideoRef} autoPlay playsInline className="w-full h-full object-contain" />
      <video
        ref={remoteScreenRef}
        autoPlay
        playsInline
        className={`absolute inset-0 w-full h-full object-contain bg-black ${hasRemoteScreen ? "block" : "hidden"}`}
      />
      <div className="absolute bottom-2 right-2 w-28 h-20 rounded-lg overflow-hidden border border-white/40 shadow bg-black">
        <video ref={localVideoRef} autoPlay playsInline muted className="w-full h-full object-cover" />
      </div>
    </div>
  );
}

function LiveKitRoomRenderer({
  sessionId,
  token,
  role,
  url,
  extraVideoTrack,
  onApiReady,
  onMuteRequested,
  onPeerEnded,
  onPeerConnectedChange,
  enableEyeTracking,
  onGazeChange,
}: {
  sessionId: string;
  token: string;
  role: "candidate" | "interviewer";
  url: string;
  extraVideoTrack?: MediaStreamTrack | null;
  onApiReady?: (api: WebRTCApi) => void;
  onMuteRequested?: () => void;
  onPeerEnded?: () => void;
  onPeerConnectedChange?: (connected: boolean) => void;
  enableEyeTracking?: boolean;
  onGazeChange?: (isFocused: boolean, isTeleprompter?: boolean) => void;
}) {
  const room = useMemo(() => new Room(), []);

  const cameraTracks = useTracks([Track.Source.Camera]);
  const screenTracks = useTracks([Track.Source.ScreenShare]);

  const localCamera = cameraTracks.find((t) => t.participant.isLocal);
  const remoteCamera = cameraTracks.find((t) => !t.participant.isLocal);
  const remoteScreen = screenTracks.find((t) => !t.participant.isLocal);

  const peerPresent = cameraTracks.length > 1;

  useEffect(() => {
    onPeerConnectedChange?.(peerPresent);
  }, [peerPresent, onPeerConnectedChange]);

  // Publish screen-share track if available and room is connected
  useEffect(() => {
    if (extraVideoTrack && room.state === "connected") {
      // source matters: without it the track publishes as an unknown/camera source and
      // the other side's useTracks([Track.Source.ScreenShare]) never matches it, so the
      // screen share silently never appears.
      room.localParticipant
        .publishTrack(extraVideoTrack, { source: Track.Source.ScreenShare })
        .catch((err) => {
          console.error("failed to publish extra video track", err);
        });
    }
  }, [extraVideoTrack, room, room.state]);

  useEffect(() => {
    if (onApiReady) {
      onApiReady({
        toggleMic: () => {
          const isEnabled = room.localParticipant.isMicrophoneEnabled;
          room.localParticipant.setMicrophoneEnabled(!isEnabled);
          return isEnabled;
        },
        toggleCamera: () => {
          const isEnabled = room.localParticipant.isCameraEnabled;
          room.localParticipant.setCameraEnabled(!isEnabled);
          return isEnabled;
        },
        requestPeerMute: () => {
          const encoder = new TextEncoder();
          room.localParticipant.publishData(
            encoder.encode(JSON.stringify({ type: "mute-request" })),
            { reliable: true }
          ).catch((err) => console.error("failed to publish data", err));
        },
        notifyPeerEnded: () => {
          const encoder = new TextEncoder();
          room.localParticipant.publishData(
            encoder.encode(JSON.stringify({ type: "call-ended" })),
            { reliable: true }
          ).catch((err) => console.error("failed to publish data", err));
        },
      });
    }
  }, [onApiReady, room]);

  useEffect(() => {
    const handleData = (payload: Uint8Array) => {
      try {
        const decoder = new TextDecoder();
        const msg = JSON.parse(decoder.decode(payload));
        if (msg.type === "mute-request") {
          onMuteRequested?.();
        } else if (msg.type === "call-ended") {
          onPeerEnded?.();
        }
      } catch (err) {
        console.error("failed to parse LiveKit data message", err);
      }
    };

    const handleParticipantDisconnected = () => onPeerEnded?.();

    room.on("dataReceived", handleData);
    room.on(RoomEvent.ParticipantDisconnected, handleParticipantDisconnected);
    return () => {
      room.off("dataReceived", handleData);
      room.off(RoomEvent.ParticipantDisconnected, handleParticipantDisconnected);
    };
  }, [onMuteRequested, onPeerEnded, room]);

  if (role === "interviewer") {
    return (
      <LiveKitRoom
        room={room}
        serverUrl={url}
        token={token}
        connect={true}
        video={true}
        audio={true}
        className="relative w-full h-full min-h-[380px] flex flex-col md:flex-row gap-3"
      >
        <RoomAudioRenderer />
        {/* Candidate Screenshare Viewport */}
        <div className="relative flex-1 min-h-[220px] bg-zinc-950 rounded-xl overflow-hidden border border-zinc-200 flex flex-col items-center justify-center">
          {remoteScreen ? (
            <>
              <VideoTrack
                trackRef={remoteScreen}
                className="w-full h-full object-contain bg-zinc-950"
              />
              <div className="absolute top-2 left-2 px-2.5 py-1 rounded-md bg-white/95 shadow text-xs font-semibold text-zinc-800 border border-zinc-200 flex items-center gap-1.5 z-10">
                <span className="w-2 h-2 rounded-full bg-blue-600 animate-pulse" />
                <span>🖥️ Candidate Screenshare (Live)</span>
              </div>
            </>
          ) : (
            <div className="flex flex-col items-center justify-center p-6 text-center text-zinc-400">
              <span className="text-3xl mb-2">🖥️</span>
              <p className="text-xs font-medium text-zinc-300">Candidate Screen Share</p>
              <p className="text-[11px] text-zinc-500 mt-0.5">Waiting for candidate screen share stream…</p>
            </div>
          )}
        </div>

        {/* Candidate Camera Viewport */}
        <div className="relative w-full md:w-80 min-h-[220px] bg-zinc-900 rounded-xl overflow-hidden border-2 border-emerald-500 ring-2 ring-emerald-500/30">
          {!peerPresent && (
            <p className="absolute inset-0 flex items-center justify-center text-xs text-white/60">
              Waiting for candidate to join…
            </p>
          )}
          {remoteCamera && (
            <VideoTrack
              trackRef={remoteCamera}
              className="w-full h-full object-cover"
            />
          )}
          {localCamera && (
            <VideoTrack
              trackRef={localCamera}
              className="absolute bottom-2 right-2 w-24 h-16 rounded-lg border border-white/40 shadow-md object-cover"
            />
          )}
        </div>
      </LiveKitRoom>
    );
  }

  return (
    <LiveKitRoom
      room={room}
      serverUrl={url}
      token={token}
      connect={true}
      video={true}
      audio={true}
      className="relative w-full h-full min-h-[360px] rounded-xl bg-black overflow-hidden border border-zinc-200"
    >
      <RoomAudioRenderer />
      {!peerPresent && (
        <p className="absolute inset-0 flex items-center justify-center text-sm text-white/60">
          Waiting for interviewer to join…
        </p>
      )}

      {remoteCamera && (
        <VideoTrack
          trackRef={remoteCamera}
          className="w-full h-full object-contain"
        />
      )}

      {remoteScreen && (
        <VideoTrack
          trackRef={remoteScreen}
          className="absolute inset-0 w-full h-full object-contain bg-black"
        />
      )}

      {localCamera && (
        <VideoTrack
          trackRef={localCamera}
          className="absolute bottom-2 right-2 w-28 h-20 rounded-lg border border-white/40 shadow object-cover"
        />
      )}
    </LiveKitRoom>
  );
}
