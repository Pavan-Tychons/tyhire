"use client";

import { useEffect, useRef, useState, useMemo } from "react";
import { BASE_URL } from "@/lib/api";
import type { IceServer } from "@/lib/types";
import { LiveKitRoom, RoomAudioRenderer, useTracks, VideoTrack } from "@livekit/components-react";
import { Track, Room, RoomEvent } from "livekit-client";
import EyeTrackingOverlay, { GAZE_TONE } from "@/components/EyeTrackingOverlay";
import type { GazeStatus } from "@/lib/eyeGazeTracker";

/** Short forms for the in-video badge, which has far less room than the overlay's own. */
const GAZE_BADGE_LABEL: Record<GazeStatus, string> = {
  focused: "🟢 Gaze: Focused",
  looking_down: "👁️ Eyes Down — Off-Screen",
  looking_up: "Gaze: Upward",
  turned_away: "🔴 Gaze: Looking Away",
  teleprompter_reading: "⚠️ Teleprompter Reading",
  no_face: "Gaze: No Face",
};
import { exitFullscreen, isFullscreenActive, requestFullscreen } from "@/lib/fullscreen";

export interface WebRTCApi {
  /** Toggles the local mic; returns the new muted state. */
  toggleMic: () => boolean;
  /** Toggles the local camera; returns the new camera-off state. */
  toggleCamera: () => boolean;
  /** Toggles fullscreen on just the call+screenshare box (not the whole page) — returns
   * the new fullscreen state. The page's own controls (mute/decision panel/tabs) stay
   * reachable by exiting fullscreen (this again, or Esc) rather than being hidden away. */
  toggleFullscreen: () => boolean;
  /** Interviewer-only: asks the candidate's page to mute itself. */
  requestPeerMute: () => void;
  /** Interviewer-only: asks the candidate's page to start sharing their screen. The
   * candidate's browser will only open the picker from their own click, never from this
   * message — getDisplayMedia requires a user gesture — so this surfaces a prompt on
   * their side rather than starting a share. */
  requestPeerScreenShare: () => void;
  /** Tells the other participant's page the call is over from this end. */
  notifyPeerEnded: () => void;
  /** Releases the camera and microphone immediately — the device light goes out and the
   * OS sees them as free. Unmounting this component does the same thing, but that only
   * happens on a later render; "End call" has to mean the devices are off at the moment
   * it is pressed, not shortly afterwards. Safe to call more than once. */
  stopMedia: () => void;
}

interface WebRTCRoomProps {
  sessionId: string;
  token: string;
  role: "candidate" | "interviewer";
  iceServers: IceServer[] | null;
  extraVideoTrack?: MediaStreamTrack | null;
  onApiReady?: (api: WebRTCApi) => void;
  onMuteRequested?: () => void;
  onScreenShareRequested?: () => void;
  onPeerEnded?: () => void;
  onPeerConnectedChange?: (connected: boolean) => void;
  livekitToken?: string | null;
  livekitUrl?: string | null;
  enableEyeTracking?: boolean;
  onGazeChange?: (isFocused: boolean, isTeleprompter?: boolean, status?: GazeStatus) => void;
  /** What the pre-join dialog chose. Applied to the local tracks before they are ever added
   * to the peer connection, so a camera or mic switched off there is never published — not
   * even for the frame between acquiring the device and the first toggle. Both default to
   * on, which is what every caller that skips the dialog gets. The in-call toggles work
   * from there as usual; these are the starting position, not a lock. */
  initialCameraEnabled?: boolean;
  initialMicEnabled?: boolean;
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

/** Plain-language reason the camera/mic couldn't be opened, for the person in the call.
 * A failure here used to be a console warning only, which left an unexplained black
 * rectangle on both sides — the single least diagnosable state this component has. */
function mediaErrorMessage(err: unknown, gotAudio: boolean): string {
  const name = err instanceof DOMException ? err.name : "";

  if (name === "NotReadableError" || name === "TrackStartError") {
    // By far the most common cause: the device is open somewhere else. On Windows most
    // webcams can only be held by one capture at a time.
    return gotAudio
      ? "Your camera is already in use by another app or browser tab, so you've joined with audio only. Close whatever is using it — including any other interview tab — then rejoin to turn video on."
      : "Your camera and microphone are already in use by another app or browser tab. Close whatever is using them, then rejoin.";
  }
  if (name === "NotAllowedError" || name === "PermissionDeniedError") {
    return gotAudio
      ? "Camera access was blocked, so you've joined with audio only. Allow it in the browser prompt and in your computer's privacy settings, then rejoin."
      : "Camera and microphone access was blocked. Allow it in the browser prompt and in your computer's privacy settings, then rejoin.";
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return gotAudio
      ? "No camera was found on this device, so you've joined with audio only."
      : "No camera or microphone was found on this device.";
  }
  return gotAudio
    ? "Couldn't turn your camera on, so you've joined with audio only."
    : "Couldn't turn on your camera or microphone.";
}

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
  onScreenShareRequested,
  onPeerEnded,
  onPeerConnectedChange,
  livekitToken,
  livekitUrl,
  enableEyeTracking = false,
  onGazeChange,
  initialCameraEnabled = true,
  initialMicEnabled = true,
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
        initialCameraEnabled={initialCameraEnabled}
        initialMicEnabled={initialMicEnabled}
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
  const [mediaError, setMediaError] = useState<string | null>(null);

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
        // Losing the camera must not take the microphone down with it. Asking for both at
        // once is all-or-nothing, so a busy or blocked camera previously left the call with
        // no media at all — silently, since this was only a console warning. Retry for
        // audio so the interview can still go ahead, and tell the user what happened.
        console.warn("Could not acquire camera; retrying audio-only", e);
        try {
          localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
          if (!cancelled) setMediaError(mediaErrorMessage(e, true));
        } catch (audioErr) {
          console.warn("Could not acquire microphone either", audioErr);
          if (!cancelled) setMediaError(mediaErrorMessage(audioErr, false));
        }
      }

      if (cancelled) {
        localStream?.getTracks().forEach((t) => t.stop());
        return;
      }

      // Apply the pre-join choices before addLocalTracks() below hands these to the peer
      // connection. Disabling the track rather than dropping it is deliberate and matches
      // toggleMic/toggleCamera: the track still exists and is still negotiated, so turning
      // the camera back on mid-call is a flag flip rather than a renegotiation.
      //
      // Read straight from the props rather than through a ref: this effect runs once per
      // connection ([sessionId, token, role]), and the parent fixes both values at the
      // moment Join is pressed — before this component mounts — so there is no later value
      // for the closure to be stale against.
      if (localStream) {
        if (!initialCameraEnabled) {
          localStream.getVideoTracks().forEach((t) => (t.enabled = false));
        }
        if (!initialMicEnabled) {
          localStream.getAudioTracks().forEach((t) => (t.enabled = false));
        }
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
        toggleFullscreen: () => {
          if (isFullscreenActive()) {
            exitFullscreen().catch(() => {});
            return false;
          }
          if (containerRef.current) requestFullscreen(containerRef.current).catch(() => {});
          return true;
        },
        requestPeerMute: () => send({ type: "mute-request" }),
        requestPeerScreenShare: () => send({ type: "screenshare-request" }),
        notifyPeerEnded: () => send({ type: "call-ended" }),
        stopMedia: () => {
          localStream?.getTracks().forEach((t) => t.stop());
          // The screen-share track is owned by the page that passed it in, so it is left
          // alone here; that page stops it as part of its own teardown.
        },
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
        } else if (message.type === "screenshare-request") {
          onScreenShareRequested?.();
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

  // One state for the whole finding rather than two booleans. "Eyes down" is a third thing
  // that is neither focused nor turned away, and a pair of booleans had nowhere to put it —
  // it would have arrived here as simply "not focused" and been drawn the same red as a
  // candidate facing away from the camera entirely.
  const [gazeStatus, setGazeStatus] = useState<GazeStatus>("focused");

  const handleGaze = (focused: boolean, teleprompter?: boolean, status?: GazeStatus) => {
    // status is the richer value; the booleans remain the fallback for any caller that
    // predates it, so a missing status still lands on a sensible state rather than
    // pinning the badge to "focused" through an entire interview.
    setGazeStatus(status ?? (teleprompter ? "teleprompter_reading" : focused ? "focused" : "turned_away"));
    onGazeChange?.(focused, teleprompter, status);
  };

  const isTeleprompter = gazeStatus === "teleprompter_reading";
  const isGazeFocused = gazeStatus === "focused";

  // Interviewer Dynamic Gaze Border Class
  const gazeBorderClass = isTeleprompter
    ? "border-purple-500 ring-4 ring-purple-500/40 shadow-[0_0_20px_rgba(168,85,247,0.5)]"
    : gazeStatus === "looking_up"
    ? // Amber: common while thinking, so not drawn as an alarm. See GAZE_TONE.
      "border-amber-500 ring-2 ring-amber-500/30 shadow-[0_0_12px_rgba(245,158,11,0.4)]"
    : isGazeFocused || gazeStatus === "no_face"
    ? "border-emerald-500 ring-2 ring-emerald-500/30 shadow-[0_0_12px_rgba(16,185,129,0.3)]"
    : // looking_down and turned_away both land here — eyes off the screen, red either way.
      "border-red-500 ring-4 ring-red-500/40 shadow-[0_0_20px_rgba(239,68,68,0.5)] animate-pulse";

  if (role === "interviewer") {
    return (
      <div ref={containerRef} className="relative w-full h-full min-h-[380px] flex flex-col md:flex-row gap-3">
        <audio ref={remoteAudioRef} autoPlay playsInline className="hidden" />
        {mediaError && (
          <div className="absolute top-2 left-1/2 -translate-x-1/2 z-30 max-w-lg px-3 py-2 rounded-lg bg-amber-50 border border-amber-300 text-amber-900 text-xs font-medium shadow-md">
            ⚠️ {mediaError}
          </div>
        )}

        {/* Candidate screen share. Kept mounted at all times and hidden with CSS rather than
          * removed from the tree: the track can arrive in a WebRTC callback before React has
          * re-rendered (see attachScreen), and an unmounted element means a null ref and a
          * stream attached to nothing. Hidden rather than present-but-empty, so there is no
          * dead "waiting for screen share" panel occupying half the stage before sharing. */}
        <div
          className={`relative flex-1 min-h-[220px] bg-zinc-950 rounded-xl overflow-hidden border border-zinc-200 ${
            hasRemoteScreen ? "flex flex-col items-center justify-center" : "hidden"
          }`}
        >
          <video
            ref={remoteScreenRef}
            autoPlay
            playsInline
            muted
            className="w-full h-full object-contain bg-zinc-950"
          />
          <div className="absolute top-2 left-2 px-2.5 py-1 rounded-md bg-white/95 shadow text-xs font-semibold text-zinc-800 border border-zinc-200 flex items-center gap-1.5 z-10">
            <span className="w-2 h-2 rounded-full bg-blue-600 animate-pulse" />
            <span>🖥️ Candidate Screenshare (Live)</span>
          </div>
        </div>

        {/* Candidate camera. Takes half the row beside the interviewer while nothing is being
          * shared, and narrows to a side panel once the screen share claims the main stage. */}
        <div
          className={`relative ${
            hasRemoteScreen ? "w-full md:w-80" : "flex-1"
          } min-h-[220px] bg-zinc-900 rounded-xl overflow-hidden border-2 transition-all duration-300 ${gazeBorderClass}`}
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
            <span className={`w-2 h-2 rounded-full ${GAZE_TONE[gazeStatus].dot}`} />
            <span className={GAZE_TONE[gazeStatus].text}>{GAZE_BADGE_LABEL[gazeStatus]}</span>
          </div>

        </div>

        {/* Interviewer self-view: a full panel beside the candidate until a screen share
          * starts, then a picture-in-picture so the shared screen gets the room.
          *
          * One element throughout, with only these classes changing. Writing this as a
          * ternary over two <video> tags would remount it on every toggle, and srcObject is
          * assigned exactly once when the camera is acquired - the self-view would go black
          * the first time the candidate shared their screen, and stay black. */}
        <div
          className={
            hasRemoteScreen
              ? "absolute bottom-3 right-3 z-20 w-28 h-20 rounded-lg overflow-hidden border border-white/40 shadow-md bg-black"
              : "relative flex-1 min-h-[220px] rounded-xl overflow-hidden border border-zinc-200 bg-zinc-900"
          }
        >
          <video
            ref={localVideoRef}
            autoPlay
            playsInline
            muted
            className="w-full h-full object-cover"
          />
          {!hasRemoteScreen && (
            <div className="absolute top-2 left-2 px-2.5 py-1 rounded-md bg-white/95 shadow text-xs font-semibold text-zinc-800 border border-zinc-200 z-10">
              You
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="relative w-full h-full min-h-[360px] rounded-xl bg-black overflow-hidden border border-zinc-200">
      <audio ref={remoteAudioRef} autoPlay playsInline className="hidden" />
      {mediaError && (
        <div className="absolute top-2 left-1/2 -translate-x-1/2 z-30 max-w-lg px-3 py-2 rounded-lg bg-amber-50 border border-amber-300 text-amber-900 text-xs font-medium shadow-md">
          ⚠️ {mediaError}
        </div>
      )}
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
  onScreenShareRequested,
  onPeerEnded,
  onPeerConnectedChange,
  enableEyeTracking,
  onGazeChange,
  initialCameraEnabled = true,
  initialMicEnabled = true,
}: {
  sessionId: string;
  token: string;
  role: "candidate" | "interviewer";
  url: string;
  extraVideoTrack?: MediaStreamTrack | null;
  onApiReady?: (api: WebRTCApi) => void;
  onMuteRequested?: () => void;
  onScreenShareRequested?: () => void;
  onPeerEnded?: () => void;
  onPeerConnectedChange?: (connected: boolean) => void;
  enableEyeTracking?: boolean;
  onGazeChange?: (isFocused: boolean, isTeleprompter?: boolean, status?: GazeStatus) => void;
  initialCameraEnabled?: boolean;
  initialMicEnabled?: boolean;
}) {
  const room = useMemo(() => new Room(), []);
  const containerRef = useRef<HTMLDivElement>(null);

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
        toggleFullscreen: () => {
          if (isFullscreenActive()) {
            exitFullscreen().catch(() => {});
            return false;
          }
          if (containerRef.current) requestFullscreen(containerRef.current).catch(() => {});
          return true;
        },
        requestPeerMute: () => {
          const encoder = new TextEncoder();
          room.localParticipant.publishData(
            encoder.encode(JSON.stringify({ type: "mute-request" })),
            { reliable: true }
          ).catch((err) => console.error("failed to publish data", err));
        },
        requestPeerScreenShare: () => {
          const encoder = new TextEncoder();
          room.localParticipant.publishData(
            encoder.encode(JSON.stringify({ type: "screenshare-request" })),
            { reliable: true }
          ).catch((err: unknown) => console.error("failed to publish data", err));
        },
        notifyPeerEnded: () => {
          const encoder = new TextEncoder();
          room.localParticipant.publishData(
            encoder.encode(JSON.stringify({ type: "call-ended" })),
            { reliable: true }
          ).catch((err) => console.error("failed to publish data", err));
        },
        stopMedia: () => {
          // Disabling these unpublishes the tracks and hands the devices back.
          room.localParticipant.setCameraEnabled(false).catch(() => {});
          room.localParticipant.setMicrophoneEnabled(false).catch(() => {});
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
        } else if (msg.type === "screenshare-request") {
          onScreenShareRequested?.();
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
  }, [onMuteRequested, onScreenShareRequested, onPeerEnded, room]);

  if (role === "interviewer") {
    return (
      <div ref={containerRef} className="relative w-full h-full min-h-[380px]">
        {/* video/audio carry the pre-join choices. Unlike the mesh path, which keeps the
          * track and disables it, LiveKit simply does not publish it — toggleCamera and
          * toggleMic call setCameraEnabled / setMicrophoneEnabled, which publish on demand,
          * so turning either back on mid-call still works from this starting position. */}
        <LiveKitRoom
          room={room}
          serverUrl={url}
          token={token}
          connect={true}
          video={initialCameraEnabled}
          audio={initialMicEnabled}
          className="relative w-full h-full flex flex-col md:flex-row gap-3"
        >
        <RoomAudioRenderer />
        {/* Candidate screen share. Rendered only once a track exists - unlike the mesh path
          * above, VideoTrack attaches on mount, so there is nothing to keep alive. */}
        {remoteScreen && (
          <div className="relative flex-1 min-h-[220px] bg-zinc-950 rounded-xl overflow-hidden border border-zinc-200 flex flex-col items-center justify-center">
            <VideoTrack
              trackRef={remoteScreen}
              className="w-full h-full object-contain bg-zinc-950"
            />
            <div className="absolute top-2 left-2 px-2.5 py-1 rounded-md bg-white/95 shadow text-xs font-semibold text-zinc-800 border border-zinc-200 flex items-center gap-1.5 z-10">
              <span className="w-2 h-2 rounded-full bg-blue-600 animate-pulse" />
              <span>🖥️ Candidate Screenshare (Live)</span>
            </div>
          </div>
        )}

        {/* Candidate camera: half the row beside the interviewer, a side panel once shared. */}
        <div
          className={`relative ${
            remoteScreen ? "w-full md:w-80" : "flex-1"
          } min-h-[220px] bg-zinc-900 rounded-xl overflow-hidden border-2 border-emerald-500 ring-2 ring-emerald-500/30`}
        >
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
        </div>

        {/* Interviewer self-view: a panel of its own until a screen share starts, then a PIP. */}
        {localCamera &&
          (remoteScreen ? (
            <VideoTrack
              trackRef={localCamera}
              className="absolute bottom-3 right-3 z-20 w-28 h-20 rounded-lg border border-white/40 shadow-md object-cover"
            />
          ) : (
            <div className="relative flex-1 min-h-[220px] rounded-xl overflow-hidden border border-zinc-200 bg-zinc-900">
              <VideoTrack trackRef={localCamera} className="w-full h-full object-cover" />
              <div className="absolute top-2 left-2 px-2.5 py-1 rounded-md bg-white/95 shadow text-xs font-semibold text-zinc-800 border border-zinc-200 z-10">
                You
              </div>
            </div>
          ))}
        </LiveKitRoom>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="relative w-full h-full min-h-[360px] rounded-xl bg-black overflow-hidden border border-zinc-200">
      <LiveKitRoom
        room={room}
        serverUrl={url}
        token={token}
        connect={true}
        video={initialCameraEnabled}
        audio={initialMicEnabled}
        className="relative w-full h-full"
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
    </div>
  );
}
