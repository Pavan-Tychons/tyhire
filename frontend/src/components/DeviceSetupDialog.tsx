"use client";

import { useEffect, useRef, useState } from "react";

/** What the person chose on the pre-join dialog, handed to the page that starts the call. */
export interface DevicePrefs {
  cameraEnabled: boolean;
  micEnabled: boolean;
  /** A live screen-share track if they opted in before joining, otherwise null. Ownership
   * passes to the caller: the dialog deliberately does NOT stop it on unmount. */
  screenTrack: MediaStreamTrack | null;
}

export const DEFAULT_DEVICE_PREFS: DevicePrefs = {
  cameraEnabled: true,
  micEnabled: true,
  screenTrack: null,
};

/** Plain-language reason the preview could not be opened. Mirrors WebRTCRoom's wording so
 * the same failure reads the same way here and inside the call. */
function previewErrorMessage(err: unknown): string {
  const name = err instanceof DOMException ? err.name : "";
  if (name === "NotReadableError" || name === "TrackStartError") {
    return "Your camera or microphone is already in use by another app or browser tab. Close whatever is using it, then reopen this dialog.";
  }
  if (name === "NotAllowedError" || name === "PermissionDeniedError") {
    return "Camera and microphone access was blocked. Allow it in the browser prompt and in your system privacy settings, then reopen this dialog.";
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return "No camera or microphone was found on this device.";
  }
  return "Could not open your camera and microphone for a preview.";
}

function screenShareErrorMessage(err: unknown): string {
  if (err instanceof DOMException) {
    if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") {
      return "Screen sharing was cancelled or blocked. You can try again, or join without it.";
    }
    if (err.name === "AbortError") return "No screen was selected. You can try again.";
  }
  return err instanceof Error ? err.message : "Could not start screen sharing.";
}

interface DeviceSetupDialogProps {
  title: string;
  description: string;
  joinLabel: string;
  /** Shows the screen-share row. Both roles can share, but only the side that actually has
   * somewhere to send it should be offered the choice. */
  allowScreenShare?: boolean;
  /** Extra line under the toggles - e.g. the candidate recording notice. */
  notice?: string;
  onJoin: (prefs: DevicePrefs) => void;
  onCancel: () => void;
}

/**
 * The pre-join device check. Opens its own short-lived camera/mic stream purely for the
 * preview, then releases it the moment the call starts - the call and (on the candidate
 * side) the proctoring recorder each open their own capture, and on Windows a webcam held
 * by three readers at once is exactly the NotReadableError the call already warns about.
 *
 * Nothing here is sent anywhere. The choices are returned to the caller, which applies them
 * to the real streams as they are created, so a camera switched off here is never published
 * to the other side even for a frame.
 */
export default function DeviceSetupDialog({
  title,
  description,
  joinLabel,
  allowScreenShare = false,
  notice,
  onJoin,
  onCancel,
}: DeviceSetupDialogProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const previewStreamRef = useRef<MediaStream | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  // Set the instant Join is pressed so the cleanup below releases the preview but leaves the
  // screen share alone - that one is handed to the caller, and stopping it here would end a
  // share the user just set up.
  const handedOffRef = useRef(false);
  // Detaches the "ended" listener from the current screen track. Held as a closure rather
  // than assigning track.onended: the track lives in state once acquired, and overwriting a
  // property on it is both a lint error and a quiet way for two owners to clobber each
  // other — the receiving page attaches a listener of its own after handover.
  const detachScreenEndedRef = useRef<(() => void) | null>(null);

  const [cameraEnabled, setCameraEnabled] = useState(true);
  const [micEnabled, setMicEnabled] = useState(true);
  const [screenTrack, setScreenTrack] = useState<MediaStreamTrack | null>(null);
  const [previewState, setPreviewState] = useState<"loading" | "ready" | "error">("loading");
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [screenError, setScreenError] = useState<string | null>(null);
  const [startingShare, setStartingShare] = useState(false);

  useEffect(() => {
    let cancelled = false;

    navigator.mediaDevices
      .getUserMedia({ video: true, audio: true })
      .then((stream) => {
        // Resolved after the dialog closed - the stream still arrives, and dropping it on
        // the floor leaves the camera light on with nothing holding it on purpose.
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        previewStreamRef.current = stream;
        if (videoRef.current) videoRef.current.srcObject = stream;
        setPreviewState("ready");
      })
      .catch((err) => {
        if (cancelled) return;
        setPreviewError(previewErrorMessage(err));
        setPreviewState("error");
      });

    return () => {
      cancelled = true;
      previewStreamRef.current?.getTracks().forEach((t) => t.stop());
      previewStreamRef.current = null;
      if (!handedOffRef.current) {
        screenStreamRef.current?.getTracks().forEach((t) => t.stop());
        screenStreamRef.current = null;
      }
    };
  }, []);

  function toggleCamera() {
    const next = !cameraEnabled;
    previewStreamRef.current?.getVideoTracks().forEach((t) => (t.enabled = next));
    setCameraEnabled(next);
  }

  function toggleMic() {
    const next = !micEnabled;
    previewStreamRef.current?.getAudioTracks().forEach((t) => (t.enabled = next));
    setMicEnabled(next);
  }

  async function toggleScreenShare() {
    if (screenTrack) {
      // stop() does not fire "ended", so the listener is detached here rather than left
      // attached to a track nothing is watching any more.
      detachScreenEndedRef.current?.();
      detachScreenEndedRef.current = null;
      screenStreamRef.current?.getTracks().forEach((t) => t.stop());
      screenStreamRef.current = null;
      setScreenTrack(null);
      return;
    }

    setScreenError(null);
    setStartingShare(true);
    try {
      if (!navigator.mediaDevices?.getDisplayMedia) {
        throw new Error(
          "Screen sharing is not supported in this browser. Please use Chrome, Edge, or Firefox."
        );
      }
      // Started from this click, not from Join: getDisplayMedia needs a user gesture, and
      // doing it here means the picker is answered while the dialog is still open rather
      // than appearing on top of a call that has already begun.
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const track = stream.getVideoTracks()[0];
      if (!track) throw new Error("No video track was found in the screen share.");
      screenStreamRef.current = stream;
      setScreenTrack(track);
      // Stopped from the browser's own "Stop sharing" bar while the dialog is still open.
      const onEnded = () => {
        screenStreamRef.current = null;
        detachScreenEndedRef.current = null;
        setScreenTrack(null);
      };
      track.addEventListener("ended", onEnded);
      detachScreenEndedRef.current = () => track.removeEventListener("ended", onEnded);
    } catch (err) {
      setScreenError(screenShareErrorMessage(err));
    } finally {
      setStartingShare(false);
    }
  }

  function join() {
    handedOffRef.current = true;
    // Released before the call opens its own capture, not after.
    previewStreamRef.current?.getTracks().forEach((t) => t.stop());
    previewStreamRef.current = null;
    // Detached before handover, because this component is about to unmount and the handler
    // closes over its setState. The receiving page attaches its own listener.
    detachScreenEndedRef.current?.();
    detachScreenEndedRef.current = null;
    onJoin({ cameraEnabled, micEnabled, screenTrack });
  }

  const screenLabel = (() => {
    if (!screenTrack) return "Off";
    const settings = screenTrack.getSettings() as MediaTrackSettings & { displaySurface?: string };
    if (settings.displaySurface === "monitor") return "Entire screen";
    if (settings.displaySurface === "window") return "Window";
    if (settings.displaySurface === "browser") return "Browser tab";
    return "Selected";
  })();

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div className="w-full max-w-md bg-surface rounded-2xl shadow-2xl border border-zinc-200 overflow-hidden">
        <div className="px-6 pt-5 pb-3">
          <h2 className="text-base font-bold text-zinc-900">{title}</h2>
          <p className="text-xs text-zinc-500 leading-relaxed mt-1">{description}</p>
        </div>

        <div className="px-6">
          <div className="relative w-full aspect-video rounded-xl overflow-hidden bg-zinc-900 border border-zinc-200">
            {/* Kept mounted in every state: srcObject is assigned from the getUserMedia
              * callback above, which can land before React has re-rendered. */}
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              className={`w-full h-full object-cover ${
                cameraEnabled && previewState === "ready" ? "block" : "hidden"
              }`}
            />
            {previewState === "loading" && (
              <p className="absolute inset-0 flex items-center justify-center text-xs text-white/60">
                Starting your camera…
              </p>
            )}
            {previewState === "ready" && !cameraEnabled && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-white/70">
                <span className="text-2xl">📷</span>
                <span className="text-xs font-medium">Camera is off</span>
              </div>
            )}
            {previewState === "error" && (
              <div className="absolute inset-0 flex items-center justify-center p-4 text-center">
                <span className="text-xs text-white/70">No preview available</span>
              </div>
            )}
          </div>

          {previewError && (
            <p className="mt-3 px-3 py-2 rounded-lg bg-amber-50 border border-amber-300 text-amber-900 text-xs leading-relaxed">
              ⚠️ {previewError}
            </p>
          )}

          <div className="mt-4 space-y-2">
            <ToggleRow
              icon="🎥"
              label="Camera"
              state={cameraEnabled ? "On" : "Off"}
              on={cameraEnabled}
              disabled={previewState === "error"}
              onToggle={toggleCamera}
            />
            <ToggleRow
              icon="🎙️"
              label="Microphone"
              state={micEnabled ? "On" : "Muted"}
              on={micEnabled}
              disabled={previewState === "error"}
              onToggle={toggleMic}
            />
            {allowScreenShare && (
              <ToggleRow
                icon="🖥️"
                label="Share screen"
                state={startingShare ? "Choosing…" : screenLabel}
                on={screenTrack !== null}
                disabled={startingShare}
                onToggle={toggleScreenShare}
              />
            )}
          </div>

          {screenError && (
            <p className="mt-2 px-3 py-2 rounded-lg bg-amber-50 border border-amber-300 text-amber-900 text-xs leading-relaxed">
              {screenError}
            </p>
          )}

          <p className="mt-3 text-[11px] text-zinc-500 leading-relaxed">
            {notice ??
              "Anything switched off here stays off when you join. You can change it again at any point during the call."}
          </p>
        </div>

        <div className="flex items-center justify-end gap-2 px-6 py-4 mt-4 bg-zinc-50 border-t border-zinc-200">
          <button
            onClick={onCancel}
            className="px-3.5 py-2 rounded-lg text-xs font-semibold text-zinc-600 hover:text-zinc-900 hover:bg-zinc-100 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={join}
            disabled={previewState === "loading"}
            className="px-5 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:bg-zinc-300 disabled:cursor-not-allowed text-white text-xs font-bold shadow-sm transition-colors"
          >
            {previewState === "loading" ? "Checking devices…" : joinLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function ToggleRow({
  icon,
  label,
  state,
  on,
  disabled,
  onToggle,
}: {
  icon: string;
  label: string;
  state: string;
  on: boolean;
  disabled?: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-xl border border-zinc-200 bg-surface">
      <span className="flex items-center gap-2.5 min-w-0">
        <span className="text-base leading-none">{icon}</span>
        <span className="min-w-0">
          <span className="block text-xs font-semibold text-zinc-800">{label}</span>
          <span
            className={`block text-[11px] font-medium truncate ${
              on ? "text-emerald-600" : "text-zinc-400"
            }`}
          >
            {state}
          </span>
        </span>
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={`${label}: ${state}`}
        disabled={disabled}
        onClick={onToggle}
        className={`relative shrink-0 w-11 h-6 rounded-full transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
          on ? "bg-emerald-500" : "bg-zinc-300"
        }`}
      >
        <span
          className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${
            on ? "translate-x-5" : "translate-x-0"
          }`}
        />
      </button>
    </div>
  );
}
