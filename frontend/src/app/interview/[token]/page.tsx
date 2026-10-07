"use client";

import { useParams } from "next/navigation";
import { useEffect, useRef, useState, type RefObject } from "react";
import { BASE_URL, getJson, postForm, postJson } from "@/lib/api";
import WebRTCRoom, { type WebRTCApi } from "@/components/WebRTCRoom";
import { createFaceSignalDetector } from "@/lib/faceDetection";
import { detectAiExtensionArtifacts } from "@/lib/extensionDetection";
import {
  exitFullscreen,
  isFullscreenActive,
  onFullscreenChange as watchFullscreenChange,
  requestFullscreen,
} from "@/lib/fullscreen";
import { useLiveSpeech } from "@/lib/useLiveSpeech";
import type { InterviewSession, SignalType } from "@/lib/types";

type Stage =
  | "loading"
  | "error"
  | "consent"
  | "identity"
  | "screenshare"
  | "starting"
  | "ready"
  | "interview"
  | "completed";

const VIRTUAL_CAMERA_HINTS = ["obs", "virtual", "manycam", "snap camera", "droidcam"];

function tokenHeader(session: InterviewSession): Record<string, string> {
  return { "X-Interview-Token": session.join_token };
}

function cameraErrorMessage(err: unknown): string {
  const name = err instanceof DOMException ? err.name : "";
  if (name === "NotAllowedError") {
    return (
      "Camera/microphone access was blocked. This can be the browser's own permission " +
      "prompt, or your computer's system-level privacy settings blocking it entirely " +
      "(Windows: Settings > Privacy & security > Camera / Microphone; macOS: System " +
      "Settings > Privacy & Security). Fix that, then reload this page."
    );
  }
  if (name === "NotFoundError") {
    return "No camera was found on this device. A working camera is required for this step.";
  }
  return "Couldn't access your camera/microphone. Please check your permissions and try again.";
}

export default function InterviewJoinPage() {
  const { token } = useParams<{ token: string }>();
  const [stage, setStage] = useState<Stage>("loading");
  const [session, setSession] = useState<InterviewSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [finishHadError, setFinishHadError] = useState(false);
  const screenStreamRef = useRef<MediaStream | null>(null);
  // The screen-share track itself lives in state, not read off screenStreamRef during
  // render below (WebRTCRoom's extraVideoTrack prop) — reading a ref's .current during
  // render is unsound (react-hooks/refs): render isn't guaranteed to observe a consistent
  // value, e.g. under Strict Mode's double-invoke or any future concurrent rendering.
  // screenStreamRef itself stays a ref because its other use (finish()'s stop-tracks
  // call, InterviewRecorder below) is a real imperative access in an event handler, not a
  // render read.
  const [screenTrack, setScreenTrack] = useState<MediaStreamTrack | null>(null);
  const startRef = useRef<number>(Date.now());

  useEffect(() => {
    getJson<InterviewSession>(`/interviews/join/${token}`)
      .then((s) => {
        setSession(s);
        // This link has already been used to completion — the backend also rejects any
        // further mutating calls on a completed session, but jumping straight to the
        // terminal screen here avoids walking through consent/identity/etc. only to hit
        // an error partway through.
        setStage(s.status === "completed" ? "completed" : "consent");
      })
      .catch(() => setError("This interview link is invalid or has expired."));
  }, [token]);

  if (error) return <Centered>{error}</Centered>;
  if (stage === "loading" || !session) return <Centered>Loading…</Centered>;
  if (stage === "consent")
    return <ConsentScreen onAccept={() => setStage("identity")} />;
  if (stage === "identity")
    return <IdentityCheck session={session} onDone={() => setStage("screenshare")} />;
  if (stage === "screenshare")
    return (
      <ScreenShareGate
        session={session}
        screenStreamRef={screenStreamRef}
        onScreenTrack={setScreenTrack}
        startRef={startRef}
        onDone={() => setStage("starting")}
      />
    );
  if (stage === "starting")
    return <StartGate session={session} onReady={() => setStage("ready")} />;
  if (stage === "ready")
    return (
      <JoinGate
        onJoin={() => {
          // The interview clock starts here, at the actual join click, not when /start
          // succeeded above — otherwise time spent reading this screen before joining
          // would wrongly count against every signal's session_offset_ms below.
          startRef.current = Date.now();
          setStage("interview");
        }}
      />
    );
  if (stage === "interview")
    return (
      <InterviewRecorder
        session={session}
        screenStreamRef={screenStreamRef}
        screenTrack={screenTrack}
        startRef={startRef}
        onDone={(hadError) => {
          setFinishHadError(hadError);
          setStage("completed");
        }}
      />
    );
  return <CompletedScreen hadError={finishHadError} />;
}

function CompletedScreen({ hadError }: { hadError: boolean }) {
  const [closeFailed, setCloseFailed] = useState(false);

  function handleClose() {
    // Best-effort — script-initiated tab close only works for tabs opened by script, which
    // this one wasn't (it's a normal navigated-to link), so most browsers silently ignore
    // this with no error and no event to detect it by. If we're still here a moment
    // later, it clearly didn't work — fall back to telling the candidate to close the tab
    // themselves instead of leaving an unresponsive button with no explanation. The
    // teardown that actually matters (camera/mic/screen-share) already happened before
    // this screen ever rendered, in InterviewRecorder.finish().
    window.close();
    setTimeout(() => setCloseFailed(true), 300);
  }

  return (
    <Centered>
      <div className="space-y-3">
        <p>
          {hadError
            ? "Your interview recording was submitted, but we hit a problem confirming it " +
              "was fully received. Your camera, microphone, and screen sharing have already " +
              "been turned off — if you're concerned, please contact HR to confirm."
            : "Thanks — your interview has been submitted for review. Your camera, " +
              "microphone, and screen sharing have been turned off."}
        </p>
        {closeFailed ? (
          <p className="text-sm text-zinc-500">
            This tab can&apos;t be closed automatically — go ahead and close it yourself
            (or just navigate away). Everything has already been submitted.
          </p>
        ) : (
          <button onClick={handleClose} className="btn-outline">
            Close
          </button>
        )}
      </div>
    </Centered>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  // A <div>, not a <p> — CompletedScreen passes a <div> (containing its own <p> and a
  // <button>) as children, and <p> can't legally contain block-level elements like that
  // (the browser was silently un-nesting it, which is what triggered the hydration errors).
  return (
    <div className="flex flex-1 items-center justify-center px-6">
      <div className="max-w-md text-center text-zinc-600">{children}</div>
    </div>
  );
}

function ConsentScreen({ onAccept }: { onAccept: () => void }) {
  return (
    <div className="flex flex-1 items-center justify-center px-6">
      <div className="max-w-md space-y-4">
        <h1 className="text-lg font-semibold">Before you begin</h1>
        <p className="text-sm text-zinc-600">
          This interview is recorded and monitored for integrity. We check your identity
          against a government ID, ask you to share your screen, and monitor for tab
          switching, copy/paste, fullscreen exits, and other signals during the session,
          including face/gaze tracking run locally in your browser to detect if you&apos;re
          reading from another screen. Your recording is also transcribed, and we analyze
          the content of your answers, your vocal tone (pacing, hesitation, energy), and
          your visible facial expression/body language as supplementary signals for the
          reviewer — not as an automated pass/fail judgment. Nothing here auto-rejects you —
          every flag is reviewed by a person before any decision is made. You can withdraw
          consent by closing this window before starting.
        </p>
        <button onClick={onAccept} className="btn-primary">
          I understand, continue
        </button>
      </div>
    </div>
  );
}

function IdentityCheck({
  session,
  onDone,
}: {
  session: InterviewSession;
  onDone: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [idFile, setIdFile] = useState<File | null>(null);
  const [selfieBlob, setSelfieBlob] = useState<Blob | null>(null);
  const [voiceBlob, setVoiceBlob] = useState<Blob | null>(null);
  const [livenessPassed, setLivenessPassed] = useState(false);
  const [checking, setChecking] = useState(false);
  const [recordingVoice, setRecordingVoice] = useState(false);
  const [prompt] = useState<"blink" | "turn_head">("turn_head");
  const [status, setStatus] = useState<string | null>(null);
  const [voiceStatus, setVoiceStatus] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);

  useEffect(() => {
    navigator.mediaDevices
      .getUserMedia({ video: true })
      .then((stream) => {
        if (videoRef.current) videoRef.current.srcObject = stream;
      })
      .catch((err) => setCameraError(cameraErrorMessage(err)));
  }, []);

  function grabFrame(): { blob: Promise<Blob | null>; canvas: HTMLCanvasElement } {
    const video = videoRef.current;
    const canvas = document.createElement("canvas");
    const w = video && video.videoWidth > 0 ? video.videoWidth : 640;
    const h = video && video.videoHeight > 0 ? video.videoHeight : 480;
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (ctx && video && video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) {
      try {
        ctx.drawImage(video, 0, 0, w, h);
      } catch (err) {
        console.warn("grabFrame drawImage warning", err);
      }
    }
    return { blob: new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg")), canvas };
  }

  async function captureLivenessAndSelfie() {
    setStatus(`Capturing — please ${prompt === "blink" ? "blink" : "turn your head"} now…`);
    const first = grabFrame();
    await new Promise((r) => setTimeout(r, 1500));
    const second = grabFrame();

    const diff = frameDifference(first.canvas, second.canvas);
    setLivenessPassed(diff > 0.02); // real pixel-motion heuristic, not a hardcoded pass

    const selfieBlobResult = await second.blob;
    setSelfieBlob(selfieBlobResult);
    setStatus(diff > 0.02 ? "Motion detected — liveness OK." : "No motion detected — try again.");
  }

  async function recordVoiceSnippet() {
    setRecordingVoice(true);
    setVoiceStatus("Recording for 5 seconds... Speak now!");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };
      recorder.onstop = () => {
        const audioBlob = new Blob(chunks, { type: "audio/wav" });
        setVoiceBlob(audioBlob);
        setVoiceStatus("Voice sample recorded successfully!");
        stream.getTracks().forEach((t) => t.stop());
      };
      recorder.start();
      setTimeout(() => {
        recorder.stop();
        setRecordingVoice(false);
      }, 5000);
    } catch {
      setVoiceStatus("Microphone access is required to record voice sample.");
      setRecordingVoice(false);
    }
  }

  async function submit() {
    if (!idFile || !selfieBlob || !voiceBlob) return;
    setChecking(true);
    setSubmitError(null);
    try {
      let idBlob: Blob;
      try {
        idBlob = await normalizeToJpeg(idFile);
      } catch {
        throw new Error(
          "Couldn't read that ID photo. Please upload a JPG or PNG image (not HEIC/PDF)."
        );
      }

      const form = new FormData();
      form.append("id_document", idBlob, "id.jpg");
      form.append("selfie", selfieBlob, "selfie.jpg");
      form.append("voice_enrollment", voiceBlob, "voice_enrollment.webm");
      form.append("liveness_prompt", prompt);
      form.append("liveness_passed", String(livenessPassed));
      await postForm(`/interviews/${session.id}/identity-check`, form, tokenHeader(session));
      onDone();
    } catch (err) {
      setSubmitError(
        err instanceof Error
          ? err.message
          : "Something went wrong submitting your identity check. Please try again."
      );
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="flex flex-1 items-center justify-center px-6 py-8">
      <div className="max-w-md w-full space-y-4">
        <h1 className="text-lg font-semibold">Identity check</h1>

        <div>
          <label className="block text-sm font-medium mb-1">Upload a photo of your government ID</label>
          <input
            type="file"
            accept="image/*"
            onChange={(e) => setIdFile(e.target.files?.[0] ?? null)}
          />
        </div>

        {cameraError && <p className="text-sm text-red-600">{cameraError}</p>}

        <video ref={videoRef} autoPlay muted playsInline className="w-full rounded-md bg-black" />

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={captureLivenessAndSelfie}
            disabled={!!cameraError}
            className="btn-outline disabled:opacity-40"
          >
            Turn your head and click here
          </button>
          {status && <span className="text-xs text-zinc-500">{status}</span>}
        </div>

        <div className="border-t border-zinc-200 pt-4 space-y-2">
          <label className="block text-sm font-medium mb-1">
            Voice Verification: Read this sentence aloud:
          </label>
          <p className="bg-zinc-50 border border-zinc-200 rounded p-2 text-sm italic font-medium">
            &ldquo;My name is {session.candidate_name} and I am ready to start my interview.&rdquo;
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={recordVoiceSnippet}
              disabled={recordingVoice}
              className="btn-outline disabled:opacity-40"
            >
              {recordingVoice ? "Recording..." : "Record voice sample (5s)"}
            </button>
            {voiceStatus && <span className="text-xs text-zinc-500">{voiceStatus}</span>}
          </div>
        </div>

        {submitError && <p className="text-sm text-red-600">{submitError}</p>}

        <button
          onClick={submit}
          disabled={!idFile || !selfieBlob || !voiceBlob || checking}
          className="btn-primary"
        >
          {checking ? "Verifying…" : "Continue"}
        </button>
      </div>
    </div>
  );
}

/**
 * OpenAI's vision API only accepts png/jpeg/gif/webp — phone camera photos are often HEIC,
 * which it rejects outright. Re-encoding through a canvas normalizes whatever the browser
 * can decode (jpeg, png, webp, gif, bmp, and HEIC on browsers/OSes with that codec) to a
 * plain JPEG before upload, instead of passing the original file straight through.
 */
async function normalizeToJpeg(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Could not encode image"))),
      "image/jpeg",
      0.92
    );
  });
}

function frameDifference(a: HTMLCanvasElement, b: HTMLCanvasElement): number {
  if (!a || !b || a.width === 0 || a.height === 0 || b.width === 0 || b.height === 0) {
    return 0.05; // Fallback motion score above 0.02 threshold
  }
  const w = 32, h = 32;
  const ctxA = document.createElement("canvas");
  const ctxB = document.createElement("canvas");
  ctxA.width = ctxB.width = w;
  ctxA.height = ctxB.height = h;
  const contextA = ctxA.getContext("2d");
  const contextB = ctxB.getContext("2d");
  if (!contextA || !contextB) return 0.05;

  try {
    contextA.drawImage(a, 0, 0, w, h);
    contextB.drawImage(b, 0, 0, w, h);
    const dataA = contextA.getImageData(0, 0, w, h).data;
    const dataB = contextB.getImageData(0, 0, w, h).data;
    let diff = 0;
    for (let i = 0; i < dataA.length; i += 4) {
      diff += Math.abs(dataA[i] - dataB[i]);
    }
    return diff / (w * h * 255);
  } catch (err) {
    console.warn("frameDifference execution warning in browser:", err);
    return 0.05;
  }
}

function sendSignal(session: InterviewSession, signal_type: SignalType, session_offset_ms: number, meta: Record<string, unknown> = {}) {
  postJson(`/interviews/${session.id}/signals`, [{ signal_type, session_offset_ms, meta }], tokenHeader(session)).catch(() => {
    // Best-effort — a dropped one-off signal isn't worth retry/queue complexity here.
  });
}

function ScreenShareGate({
  session,
  screenStreamRef,
  onScreenTrack,
  startRef,
  onDone,
}: {
  session: InterviewSession;
  screenStreamRef: RefObject<MediaStream | null>;
  onScreenTrack: (track: MediaStreamTrack) => void;
  startRef: RefObject<number>;
  onDone: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);

  async function requestShare() {
    setRequesting(true);
    setError(null);

    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
        throw new Error("Screen sharing is not supported in this browser. Please use Chrome, Edge, or Firefox.");
      }
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      screenStreamRef.current = stream;
      const track = stream.getVideoTracks()[0];
      if (!track) throw new Error("No video track found in screen share stream.");
      onScreenTrack(track);
      const settings = track.getSettings() as MediaTrackSettings & { displaySurface?: string };

      if (settings.displaySurface && settings.displaySurface !== "monitor") {
        sendSignal(session, "screen_share_partial", 0, { displaySurface: settings.displaySurface });
      }

      track.onended = () => {
        sendSignal(session, "screen_share_stopped", Date.now() - startRef.current);
      };

      onDone();
    } catch (err: unknown) {
      console.warn("Screen share request error:", err);
      const msg = err instanceof Error ? err.message : String(err);
      if (
        err instanceof DOMException &&
        (err.name === "NotAllowedError" || err.name === "PermissionDeniedError")
      ) {
        setError(
          "Screen sharing was cancelled or blocked. Please click the button below and select a screen/window to continue."
        );
      } else if (err instanceof DOMException && err.name === "AbortError") {
        setError("Screen sharing selection was dismissed. Please try again.");
      } else {
        setError(msg || "Couldn't start screen sharing. Please try again.");
      }
    } finally {
      setRequesting(false);
    }
  }

  return (
    <div className="flex flex-1 items-center justify-center px-6 py-8">
      <div className="max-w-md w-full space-y-4 text-center">
        <h1 className="text-lg font-semibold">Share your screen</h1>
        <p className="text-sm text-zinc-600">
          Before continuing, please share your screen. Sharing your entire screen is
          preferred — if you share only a single tab or window instead, that&apos;s noted for
          the reviewer, not blocked.
        </p>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button onClick={requestShare} disabled={requesting} className="btn-primary">
          {requesting ? "Waiting for permission…" : "Share your screen"}
        </button>
      </div>
    </div>
  );
}

function StartGate({ session, onReady }: { session: InterviewSession; onReady: () => void }) {
  const [status, setStatus] = useState<"checking" | "waiting_probe" | "identity_blocked" | "error">(
    "checking"
  );
  // Bumped by the manual retry button to re-run the start attempt in place — needed because a
  // hard identity block (or a generic error) is otherwise a dead end: once HR clears the
  // no_match there's no way forward short of a full page reload, which isn't discoverable.
  const [retryKey, setRetryKey] = useState(0);

  function retry() {
    setStatus("checking");
    setRetryKey((k) => k + 1);
  }

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    async function attempt() {
      try {
        await postJson(`/interviews/${session.id}/start`, {}, tokenHeader(session));
        if (!cancelled) onReady();
      } catch (err) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : "";
        if (msg.includes("Desktop monitor")) {
          setStatus("waiting_probe");
          timer = setTimeout(attempt, 4000);
        } else if (msg.includes("Identity verification")) {
          setStatus("identity_blocked");
        } else {
          setStatus("error");
        }
      }
    }

    attempt();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id, retryKey]);

  if (status === "waiting_probe") {
    return (
      <Centered>
        <span className="block space-y-3">
          <span className="block font-medium">Waiting for the desktop monitor…</span>
          <span className="block text-sm">
            This role requires the background-app monitor to be running before the interview
            can start.{" "}
            <a
              href="/desktop-probe.js"
              download="probe.js"
              className="underline text-blue-700 font-medium hover:text-blue-900"
            >
              Download probe.js
            </a>{" "}
            and run it, then this page continues automatically:
          </span>
          <code className="block bg-zinc-100 rounded p-2 text-xs">
            node probe.js --session-id {session.id} --token {session.join_token}
          </code>
        </span>
      </Centered>
    );
  }

  if (status === "identity_blocked") {
    return (
      <Centered>
        <span className="block space-y-3">
          <span className="block">
            Identity verification hasn&apos;t been completed yet. Go back and finish the ID
            and selfie step, or contact HR if this keeps happening.
          </span>
          <button onClick={retry} className="btn-primary">
            Try again
          </button>
        </span>
      </Centered>
    );
  }

  if (status === "error") {
    return (
      <Centered>
        <span className="block space-y-3">
          <span className="block">Could not start the interview.</span>
          <button onClick={retry} className="btn-primary">
            Try again
          </button>
        </span>
      </Centered>
    );
  }

  return <Centered>Checking…</Centered>;
}

function JoinGate({ onJoin }: { onJoin: () => void }) {
  return (
    <Centered>
      <div className="space-y-4">
        <h1 className="text-lg font-semibold">Ready to begin</h1>
        <p className="text-sm text-zinc-600">
          Clicking below turns on your camera and microphone and connects you to the
          interviewer — nothing starts before that. Make sure you&apos;re somewhere quiet
          and well-lit first.
        </p>
        <button
          onClick={() => {
            // Fired synchronously in this click, same reasoning as ScreenShareGate — this
            // is the second of two independent attempts, not a fallback for the first: if
            // the candidate declined/never reached screen-share fullscreen for whatever
            // reason, the interview itself still shouldn't be the one place fullscreen was
            // never even tried.
            requestFullscreen().catch(() => {});
            onJoin();
          }}
          className="btn-primary"
        >
          Join Meet
        </button>
      </div>
    </Centered>
  );
}

function InterviewRecorder({
  session,
  screenStreamRef,
  screenTrack,
  startRef,
  onDone,
}: {
  session: InterviewSession;
  screenStreamRef: RefObject<MediaStream | null>;
  screenTrack: MediaStreamTrack | null;
  startRef: RefObject<number>;
  onDone: (hadError: boolean) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const webrtcApiRef = useRef<WebRTCApi | null>(null);
  const pendingSignals = useRef<{ signal_type: SignalType; session_offset_ms: number }[]>([]);
  const [finishing, setFinishing] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [recordingStarted, setRecordingStarted] = useState(false);
  const [micMuted, setMicMuted] = useState(false);
  const [cameraOff, setCameraOff] = useState(false);
  const [muteRequested, setMuteRequested] = useState(false);
  const [isFullscreenOn, setIsFullscreenOn] = useState(false);
  const [currentScreenTrack, setCurrentScreenTrack] = useState<MediaStreamTrack | null>(
    screenTrack || screenStreamRef.current?.getVideoTracks()[0] || null
  );

  useEffect(() => {
    if (screenTrack) {
      setCurrentScreenTrack(screenTrack);
    } else if (screenStreamRef.current) {
      const t = screenStreamRef.current.getVideoTracks()[0];
      if (t) setCurrentScreenTrack(t);
    }
  }, [screenTrack, screenStreamRef]);

  async function toggleScreenShare() {
    if (currentScreenTrack && currentScreenTrack.readyState === "live") {
      currentScreenTrack.stop();
      setCurrentScreenTrack(null);
    } else {
      try {
        const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
        screenStreamRef.current = stream;
        const track = stream.getVideoTracks()[0];
        setCurrentScreenTrack(track);
        track.onended = () => setCurrentScreenTrack(null);
      } catch {}
    }
  }

  // Live Speech Recognition: stream candidate's speech to interviewer live transcript panel
  useLiveSpeech({
    sessionId: session.id,
    speaker: "candidate",
    enabled: true,
    startedAtMs: startRef.current,
    authToken: session.join_token,
    tokenHeaderKey: "X-Interview-Token",
  });

  function toggleMic() {
    setMicMuted(webrtcApiRef.current?.toggleMic() ?? false);
    setMuteRequested(false);
  }
  function toggleCamera() {
    setCameraOff(webrtcApiRef.current?.toggleCamera() ?? false);
  }
  function toggleFullscreen() {
    setIsFullscreenOn(webrtcApiRef.current?.toggleFullscreen() ?? false);
  }

  function pushSignal(signal_type: SignalType) {
    pendingSignals.current.push({
      signal_type,
      session_offset_ms: Date.now() - startRef.current,
    });
  }

  useEffect(() => {
    // Alt-tabbing away fires BOTH of these for the exact same action — the window loses
    // OS focus (blur) at essentially the same instant the tab becomes hidden
    // (visibilitychange) — but their relative order isn't guaranteed across
    // browsers/OSes. Left unguarded, one alt-tab used to reach the backend as two
    // distinct signal types in the same fusion cluster, which (via integrity.py's
    // type-diversity multiplier) tripled its severity for what is really one event, not
    // two independent suspicious behaviors. window_blur is still pushed on its own for
    // genuine standalone focus loss (e.g. clicking a second monitor's window without the
    // tab ever going hidden) — only the redundant alt-tab case is suppressed here.
    const TAB_SWITCH_BLUR_DEDUP_MS = 500;
    let tabSwitchJustHappened = false;
    let tabSwitchResetTimer: ReturnType<typeof setTimeout> | undefined;
    let pendingBlurTimer: ReturnType<typeof setTimeout> | undefined;

    const onVisibility = () => {
      if (!document.hidden) return;
      tabSwitchJustHappened = true;
      clearTimeout(tabSwitchResetTimer);
      tabSwitchResetTimer = setTimeout(() => {
        tabSwitchJustHappened = false;
      }, TAB_SWITCH_BLUR_DEDUP_MS);
      if (pendingBlurTimer) {
        clearTimeout(pendingBlurTimer);
        pendingBlurTimer = undefined;
      }
      pushSignal("tab_switch");
    };
    const onBlur = () => {
      if (tabSwitchJustHappened) return;
      // blur can fire before visibilitychange for the same alt-tab — hold this briefly so
      // an about-to-arrive tab_switch can still cancel it via the branch above.
      pendingBlurTimer = setTimeout(() => {
        pendingBlurTimer = undefined;
        pushSignal("window_blur");
      }, TAB_SWITCH_BLUR_DEDUP_MS);
    };
    const onCopy = () => pushSignal("copy_paste");
    const onPaste = () => pushSignal("copy_paste");
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("blur", onBlur);
    document.addEventListener("copy", onCopy);
    document.addEventListener("paste", onPaste);

    // Only flags an EXIT after having actually been in fullscreen — never flags simply
    // "never entered fullscreen" (requestFullscreen in the previous steps is best-effort).
    // isFullscreenActive/watchFullscreenChange also check Safari's webkit-prefixed
    // fullscreenElement/fullscreenchange, which the plain unprefixed versions miss there.
    let wasFullscreen = isFullscreenActive();
    const stopWatchingFullscreen = watchFullscreenChange(() => {
      // Also keeps the Fullscreen button's label accurate when exited via Esc instead of
      // the button itself, not just the integrity-signal bookkeeping below.
      setIsFullscreenOn(isFullscreenActive());
      if (isFullscreenActive()) {
        wasFullscreen = true;
      } else if (wasFullscreen) {
        pushSignal("fullscreen_exit");
        wasFullscreen = false;
      }
    });

    // DevTools heuristic: a docked panel shrinks the viewport relative to the outer window.
    // Explicitly unreliable (the user's own window sizing can trigger it) — kept as a
    // low-signal-alone input to fusion rather than trusted standalone.
    const devtoolsInterval = setInterval(() => {
      const widthDiff = window.outerWidth - window.innerWidth;
      const heightDiff = window.outerHeight - window.innerHeight;
      if (widthDiff > 160 || heightDiff > 160) pushSignal("devtools_open");
    }, 4000);

    // AI answer-helper browser extension (Monica AI, Sider, etc.) DOM-signature check —
    // see lib/extensionDetection.ts. Once flagged, presence is stable for the rest of the
    // call (the extension doesn't uninstall itself mid-interview), so this only pushes
    // the signal once rather than every 4s for the remainder of the interview.
    let aiExtensionFlagged = false;
    const extensionInterval = setInterval(() => {
      if (aiExtensionFlagged) return;
      if (detectAiExtensionArtifacts()) {
        aiExtensionFlagged = true;
        pushSignal("ai_extension_detected");
      }
    }, 4000);

    // window.screen.isExtended: a lighter, permission-free complement to the
    // getScreenDetails() check below — narrower browser support, but no prompt needed.
    const screenWithExtended = window.screen as Screen & { isExtended?: boolean };
    if (screenWithExtended.isExtended) pushSignal("external_display_detected");

    navigator.mediaDevices
      .enumerateDevices()
      .then((devices) => {
        const suspicious = devices.some((d) =>
          VIRTUAL_CAMERA_HINTS.some((hint) => d.label.toLowerCase().includes(hint))
        );
        if (suspicious) pushSignal("virtual_camera");
      })
      .catch(() => {
        // Best-effort signal — not worth surfacing a failure to the candidate for this one.
      });

    // Window Management API (Chromium): genuinely detects connected displays from the
    // browser with just a permission prompt — no native install needed. Unsupported
    // browsers (Firefox/Safari as of writing) just skip this, since it's feature-detected.
    const screenAwareWindow = window as unknown as {
      getScreenDetails?: () => Promise<{
        screens: unknown[];
        addEventListener: (type: "screenschange", listener: () => void) => void;
      }>;
    };
    if (typeof screenAwareWindow.getScreenDetails === "function") {
      screenAwareWindow
        .getScreenDetails()
        .then((details) => {
          const checkDisplays = () => {
            if (details.screens.length > 1) pushSignal("external_display_detected");
          };
          checkDisplays();
          details.addEventListener("screenschange", checkDisplays);
        })
        .catch(() => {
          // Permission denied, or not actually supported at runtime — not a hard requirement.
        });
    }

    let stream: MediaStream;
    let faceInterval: ReturnType<typeof setInterval> | undefined;
    let sentimentInterval: ReturnType<typeof setInterval> | undefined;
    const detectFace = createFaceSignalDetector();
    // Consecutive-hit counters so a single bad frame (blink, brief head turn) doesn't flag —
    // only sustained conditions do, matching the roadmap's "never an alarm on its own" rule.
    let gazeAwayStreak = 0;
    let secondFaceStreak = 0;

    navigator.mediaDevices
      .getUserMedia({
        video: {
          width: { ideal: 640, max: 1280 },
          height: { ideal: 480, max: 720 },
          frameRate: { ideal: 15, max: 24 }
        },
        audio: true
      })
      .then((s) => {
        stream = s;
        streamRef.current = s;
        if (videoRef.current) videoRef.current.srcObject = s;

        const recorder = new MediaRecorder(s, { mimeType: "video/webm" });
        recorder.ondataavailable = async (e) => {
          if (e.data.size === 0) return;
          const form = new FormData();
          form.append("chunk", e.data, "chunk.webm");
          // Best-effort, same as the other periodic uploads below — a single dropped chunk
          // isn't worth retry complexity, and once a session is already completed (e.g. a
          // stale duplicate tab left open from an earlier run) this would otherwise throw
          // an unhandled rejection every 5s forever.
          await postForm(`/interviews/${session.id}/recording-chunk`, form, tokenHeader(session)).catch(
            () => {}
          );
        };
        recorder.start(5000);
        recorderRef.current = recorder;
        setRecordingStarted(true);

        // Periodic, independent, fully-closed clips for "live" sentiment — deliberately a
        // SEPARATE short recorder rather than slicing the continuously-appended recording
        // above, which isn't safe to read with ffmpeg mid-write server-side. 60s cadence
        // balances the interviewer seeing something current against per-clip OpenAI cost.
        const takeSentimentSample = () => {
          const sampleChunks: BlobPart[] = [];
          const sampleRecorder = new MediaRecorder(s, { mimeType: "video/webm" });
          sampleRecorder.ondataavailable = (e) => {
            if (e.data.size > 0) sampleChunks.push(e.data);
          };
          sampleRecorder.onstop = async () => {
            const blob = new Blob(sampleChunks, { type: "video/webm" });
            const form = new FormData();
            form.append("clip", blob, "sample.webm");
            form.append("session_offset_ms", String(Date.now() - startRef.current));
            await postForm(`/interviews/${session.id}/sentiment-sample`, form, tokenHeader(session)).catch(
              () => {}
            );
          };
          sampleRecorder.start();
          setTimeout(() => sampleRecorder.stop(), 4000);
        };
        takeSentimentSample();
        sentimentInterval = setInterval(takeSentimentSample, 60000);

        // Runs client-side only (MediaPipe WASM) — raw video never leaves the browser for
        // this; only the derived signal (e.g. "gaze off-screen") gets sent to the backend.
        faceInterval = setInterval(async () => {
          if (!videoRef.current) return;
          const result = await detectFace(videoRef.current);
          if (!result) return;

          if (result.faceCount > 1) {
            secondFaceStreak++;
            if (secondFaceStreak >= 2) pushSignal("second_face");
          } else {
            secondFaceStreak = 0;
          }

          if (result.gazeOffScreen) {
            gazeAwayStreak++;
            if (gazeAwayStreak >= 3) pushSignal("gaze_off_screen");
          } else {
            gazeAwayStreak = 0;
          }

          if (result.excessiveMotion) pushSignal("excessive_motion");
        }, 800);
      })
      .catch((err) => setCameraError(cameraErrorMessage(err)));

    const flushInterval = setInterval(() => {
      if (pendingSignals.current.length === 0) return;
      const batch = pendingSignals.current;
      pendingSignals.current = [];
      postJson(`/interviews/${session.id}/signals`, batch, tokenHeader(session)).catch((err) => {
        // A 409 means the session is already completed (e.g. a stale duplicate tab left
        // open from an earlier run) — retrying forever every 3s is pointless, so this one
        // case gives up instead of re-queuing. Any other failure (network blip) still
        // re-queues for the next tick, same as before.
        if (err instanceof Error && err.message.includes("409")) return;
        pendingSignals.current.unshift(...batch);
      });
    }, 3000);

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("copy", onCopy);
      document.removeEventListener("paste", onPaste);
      clearTimeout(tabSwitchResetTimer);
      clearTimeout(pendingBlurTimer);
      stopWatchingFullscreen();
      clearInterval(devtoolsInterval);
      clearInterval(extensionInterval);
      clearInterval(flushInterval);
      clearInterval(faceInterval);
      clearInterval(sentimentInterval);
      stream?.getTracks().forEach((t) => t.stop());
    };
    // Intentionally keyed on session.id (a stable primitive), not the session object
    // itself, which gets a new reference on every poll/refresh; re-running this effect on
    // that churn would tear down and rebuild the camera/screen streams, listeners, and
    // intervals mid-interview. pushSignal is a plain in-body function (new reference every
    // render, not memoized) for the same reason — it always closes over the current
    // session via the outer scope, so omitting it here doesn't make it stale.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id, startRef]);

  async function finish(notifyPeer = true) {
    if (finishing) return;
    setFinishing(true);

    // Tells the interviewer's page the call is over from this end — before any local
    // teardown below, since notifyPeer only reaches them while WebRTCRoom (and its
    // connection) is still mounted and alive. When finish() runs because *they* ended it
    // (notifyPeer=false, via onPeerEnded), skip this — they already know.
    if (notifyPeer) webrtcApiRef.current?.notifyPeerEnded();

    // Everything media-related stops here, unconditionally, before any network call — a
    // failed request below must never leave the candidate's camera/mic/screen-share
    // running. (The live call's own camera/mic releases separately, via WebRTCRoom's own
    // unmount cleanup once onDone() below causes the parent to stop rendering this stage —
    // guaranteed by the finally, not left contingent on the network calls succeeding.)
    recorderRef.current?.stop();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    screenStreamRef.current?.getTracks().forEach((t) => t.stop());
    if (isFullscreenActive()) exitFullscreen().catch(() => {});

    let hadError = false;
    try {
      await postJson(`/interviews/${session.id}/signals`, pendingSignals.current, tokenHeader(session));
      pendingSignals.current = [];
      const res = await fetch(`${BASE_URL}/interviews/${session.id}/complete`, {
        method: "POST",
        credentials: "include",
        headers: tokenHeader(session),
      });
      if (!res.ok) throw new Error(`complete failed: ${res.status}`);
    } catch {
      hadError = true;
    } finally {
      onDone(hadError);
    }
  }

  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 py-8 gap-4">
      {cameraError ? (
        <p className="max-w-md text-sm text-red-600 text-center">{cameraError}</p>
      ) : (
        <p className="text-sm text-zinc-500">
          Live call below — stay on this tab and answer the questions you&apos;re asked.
        </p>
      )}
      <div className="w-full max-w-2xl h-[420px]">
        <WebRTCRoom
          sessionId={session.id}
          token={session.join_token}
          role="candidate"
          iceServers={session.ice_servers}
          extraVideoTrack={currentScreenTrack}
          enableEyeTracking={true}
          onApiReady={(api) => {
            webrtcApiRef.current = api;
          }}
          onMuteRequested={() => setMuteRequested(true)}
          onPeerEnded={() => finish(false)}
          livekitToken={session.livekit_token}
          livekitUrl={session.livekit_url}
        />
      </div>
      {muteRequested && (
        <p className="text-xs text-zinc-600">
          The interviewer asked you to mute your mic.{" "}
          <button onClick={toggleMic} className="underline">
            Mute now
          </button>
        </p>
      )}
      <div className="flex gap-2">
        <button onClick={toggleMic} className="btn-outline text-xs px-2 py-1">
          {micMuted ? "Unmute mic" : "Mute mic"}
        </button>
        <button onClick={toggleCamera} className="btn-outline text-xs px-2 py-1">
          {cameraOff ? "Turn camera on" : "Turn camera off"}
        </button>
        <button onClick={toggleScreenShare} className="btn-outline text-xs px-2 py-1">
          {currentScreenTrack ? "🖥️ Screen sharing (Active)" : "🖥️ Share screen"}
        </button>
        <button onClick={toggleFullscreen} className="btn-outline text-xs px-2 py-1">
          {isFullscreenOn ? "⛶ Exit fullscreen" : "⛶ Fullscreen"}
        </button>
      </div>
      {/* Not display:none deliberately — some browsers stop maintaining a live decoded
          frame for fully un-rendered video elements, which breaks the canvas/WASM-based
          face detection reading from it. Kept tiny and invisible instead of hidden. */}
      <video
        ref={videoRef}
        autoPlay
        muted
        playsInline
        className="absolute w-px h-px opacity-0 pointer-events-none -z-10"
      />
      {recordingStarted ? (
        <button onClick={() => finish()} disabled={finishing} className="btn-primary">
          {finishing ? "Submitting…" : "Finish interview"}
        </button>
      ) : (
        !cameraError && <p className="text-xs text-zinc-400">Starting…</p>
      )}
    </div>
  );
}
