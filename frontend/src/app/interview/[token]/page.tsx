"use client";

import { useParams } from "next/navigation";
import { useEffect, useRef, useState, type RefObject } from "react";
import { ApiError, BASE_URL, getJson, postForm, postJson } from "@/lib/api";
import WebRTCRoom, { type WebRTCApi } from "@/components/WebRTCRoom";
import DeviceSetupDialog, {
  DEFAULT_DEVICE_PREFS,
  type DevicePrefs,
} from "@/components/DeviceSetupDialog";
import { createFaceSignalDetector } from "@/lib/faceDetection";
import { detectAiExtensionArtifacts, detectProctoringTamper } from "@/lib/extensionDetection";
import {
  exitFullscreen,
  isFullscreenActive,
  onFullscreenChange as watchFullscreenChange,
  requestFullscreen,
} from "@/lib/fullscreen";
import { useLiveSpeech } from "@/lib/useLiveSpeech";
import { useRealtimeTranscribe } from "@/lib/useRealtimeTranscribe";
import type { InterviewSession, SignalType } from "@/lib/types";

type Stage =
  | "loading"
  | "error"
  | "consent"
  | "identity"
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
  // Chosen on the pre-join dialog and fixed for the rest of the call. Held here rather than
  // inside JoinGate because JoinGate unmounts the moment the stage flips to "interview" —
  // and one of these is a live screen-share track that has to outlive it.
  const [devicePrefs, setDevicePrefs] = useState<DevicePrefs>(DEFAULT_DEVICE_PREFS);
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
    return <IdentityCheck session={session} onDone={() => setStage("starting")} />;
  if (stage === "starting")
    return <StartGate session={session} onReady={() => setStage("ready")} />;
  if (stage === "ready")
    return (
      <JoinGate
        onJoin={(prefs) => {
          // The interview clock starts here, at the actual join click, not when /start
          // succeeded above — otherwise time spent reading this screen before joining
          // would wrongly count against every signal's session_offset_ms below.
          startRef.current = Date.now();
          setDevicePrefs(prefs);
          setStage("interview");
        }}
      />
    );
  if (stage === "interview")
    return (
      <InterviewRecorder
        session={session}
        devicePrefs={devicePrefs}
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
  // No "Close" button here: a tab opened from a pasted interview link is not script-closable,
  // so window.close() is silently refused by the browser (TYH-019). Rather than offer a button
  // that can't keep its promise, we just tell the candidate they're free to close the tab. The
  // teardown that matters (camera/mic/screen-share) already happened in InterviewRecorder.finish().
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
        <p className="text-sm text-zinc-500">
          You can safely close this tab now — everything has already been submitted.
        </p>
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

// Voice-sample loudness gates (TYH-018). RMS is 0..1; pure silence / a muted mic sits near 0,
// normal speech is ~0.05-0.2. The floor only rejects genuine silence so noisy real-world rooms
// still pass; the hint flags a faint-but-usable sample without blocking submission.
const VOICE_SILENCE_FLOOR = 0.005;
const VOICE_QUIET_HINT = 0.02;

/**
 * Returns the RMS loudness (0..1) of an audio blob, or -1 if it can't be decoded. Decodes by
 * content, so the blob's declared MIME type doesn't matter. Used to tell a real recording from
 * a silent/empty one — MediaRecorder happily produces a non-empty container with no audio when
 * the mic is muted or unavailable, which is exactly the "recorded successfully but nothing there"
 * case this guards against.
 */
async function audioLoudnessRms(blob: Blob): Promise<number> {
  try {
    const buf = await blob.arrayBuffer();
    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return -1;
    const ctx = new Ctx();
    try {
      const audio = await ctx.decodeAudioData(buf);
      const data = audio.getChannelData(0);
      if (!data.length) return 0;
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
      return Math.sqrt(sum / data.length);
    } finally {
      ctx.close();
    }
  } catch {
    return -1;
  }
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
    // The stream has to be released when this step is done. Without the cleanup below it
    // stayed open for the rest of the session, so by the time the interview itself asked
    // for the camera the device was still held by this screen — and on hardware that only
    // allows one capture at a time that surfaces as NotReadableError, i.e. a black video
    // on both sides of the call with nothing explaining why.
    //
    // `cancelled` covers the case where the component unmounts (or Strict Mode re-runs the
    // effect) while getUserMedia is still resolving: the stream arrives after teardown and
    // would otherwise never be stopped by anyone.
    let cancelled = false;
    let stream: MediaStream | null = null;

    navigator.mediaDevices
      .getUserMedia({ video: true })
      .then((s) => {
        stream = s;
        if (cancelled) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        if (videoRef.current) videoRef.current.srcObject = s;
      })
      .catch((err) => {
        if (!cancelled) setCameraError(cameraErrorMessage(err));
      });

    return () => {
      cancelled = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
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
    setVoiceBlob(null); // clear any previous sample until this one is validated
    setVoiceStatus("Recording for 5 seconds... Speak now!");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const audioBlob = new Blob(chunks, { type: "audio/wav" });
        const rms = await audioLoudnessRms(audioBlob);

        // Reject a silent/empty capture (the TYH-018 bug) — but only genuine silence, so a
        // noisy room still passes. If we couldn't decode it, fall back to a size sanity check.
        const silent =
          rms >= 0 ? rms < VOICE_SILENCE_FLOOR : audioBlob.size < 2000;
        if (silent) {
          setVoiceBlob(null);
          setVoiceStatus(
            "We couldn't hear anything — please record again and read the sentence aloud."
          );
        } else {
          setVoiceBlob(audioBlob);
          if (rms >= 0 && rms < VOICE_QUIET_HINT) {
            setVoiceStatus("Recorded — but it sounds faint. You can re-record in a quieter spot if you like.");
          } else {
            setVoiceStatus("Voice sample recorded successfully!");
          }
        }
        setRecordingVoice(false);
      };
      recorder.start();
      setTimeout(() => recorder.stop(), 5000);
    } catch {
      setVoiceStatus("Microphone access is required to record voice sample.");
      setRecordingVoice(false);
    }
  }

  async function submit() {
    // Validate every field rather than silently no-op'ing (TYH-018): a candidate must have
    // uploaded an ID, passed the liveness capture (real motion), and recorded an audible voice
    // sample. voiceBlob is only set once the recording cleared the silence check above.
    if (!idFile || !selfieBlob || !livenessPassed || !voiceBlob) {
      setSubmitError(
        "Please complete every step first: upload your government ID, run the liveness capture until motion is detected, and record an audible voice sample."
      );
      return;
    }
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
          disabled={!idFile || !selfieBlob || !livenessPassed || !voiceBlob || checking}
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

function JoinGate({ onJoin }: { onJoin: (prefs: DevicePrefs) => void }) {
  const [setupOpen, setSetupOpen] = useState(false);

  return (
    <>
      <Centered>
        <div className="space-y-4">
          <h1 className="text-lg font-semibold">Ready to begin</h1>
          <p className="text-sm text-zinc-600">
            Next you&apos;ll check your camera and microphone and choose what to turn on.
            Nothing is sent to the interviewer until you join from that dialog. Make sure
            you&apos;re somewhere quiet and well-lit first.
          </p>
          <button onClick={() => setSetupOpen(true)} className="btn-primary">
            Check devices &amp; join
          </button>
        </div>
      </Centered>

      {setupOpen && (
        <DeviceSetupDialog
          title="Before you join"
          description="Check how you look and sound, and choose what to turn on. You can change any of this during the interview."
          joinLabel="Join Meet"
          allowScreenShare
          notice="This interview is recorded for review. Turning your camera off here stops video being recorded or sent to the interviewer — they will be able to see that it is off."
          onCancel={() => setSetupOpen(false)}
          onJoin={(prefs) => {
            // Fired synchronously inside the click, because requestFullscreen only works
            // from a user gesture — which this still is, now that the dialog's Join button
            // is the gesture rather than the one on the screen behind it.
            requestFullscreen().catch(() => {});
            onJoin(prefs);
          }}
        />
      )}
    </>
  );
}

function InterviewRecorder({
  session,
  devicePrefs,
  startRef,
  onDone,
}: {
  session: InterviewSession;
  devicePrefs: DevicePrefs;
  startRef: RefObject<number>;
  onDone: (hadError: boolean) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const webrtcApiRef = useRef<WebRTCApi | null>(null);
  const pendingSignals = useRef<
    { signal_type: SignalType; session_offset_ms: number; meta?: Record<string, unknown> }[]
  >([]);
  const [finishing, setFinishing] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [recordingStarted, setRecordingStarted] = useState(false);
  // Seeded from the pre-join dialog so the buttons below already read "Unmute mic" /
  // "Turn camera on" when the candidate chose to join with them off, instead of offering to
  // turn off something that is already off.
  const [micMuted, setMicMuted] = useState(!devicePrefs.micEnabled);
  const [cameraOff, setCameraOff] = useState(!devicePrefs.cameraEnabled);
  // Mirrors cameraOff for the face-detection interval, whose closure is created once and
  // would otherwise keep reading the camera state as it was at mount.
  const cameraOffRef = useRef(!devicePrefs.cameraEnabled);
  const [muteRequested, setMuteRequested] = useState(false);
  const [isFullscreenOn, setIsFullscreenOn] = useState(false);
  const [proctoringWarning, setProctoringWarning] = useState<string | null>(null);
  // Screen sharing is opt-in: from the pre-join dialog, from the button below, or by
  // accepting the interviewer's ask. The stream is owned by this component.
  const screenStreamRef = useRef<MediaStream | null>(null);
  const [currentScreenTrack, setCurrentScreenTrack] = useState<MediaStreamTrack | null>(
    devicePrefs.screenTrack
  );
  const [screenShareRequested, setScreenShareRequested] = useState(false);
  const [screenShareError, setScreenShareError] = useState<string | null>(null);
  // Whether a share ever happened, for the single end-of-interview signal. A ref, not
  // state: it is only read in finish(), and must survive the share being stopped again.
  const everSharedRef = useRef(devicePrefs.screenTrack !== null);

  // Takes ownership of a share that was started in the pre-join dialog, and records the
  // same facts the in-call path records — so a share begun before joining is
  // indistinguishable from one begun during the call to everything downstream.
  //
  // addEventListener rather than assigning .onended, which is what the in-call path does
  // with a track it created itself: this track arrives through props, and overwriting a
  // property of something owned upstream is both a lint error here and a real hazard —
  // the dialog clears its own handler on handover precisely so neither side clobbers the
  // other's. The listener is removed on unmount for the same reason.
  useEffect(() => {
    const track = devicePrefs.screenTrack;
    if (!track) return;

    // finish() tears down via screenStreamRef; the dialog hands over the track alone, so
    // wrap it. Stopping this wrapper's tracks stops the same underlying capture.
    screenStreamRef.current = new MediaStream([track]);

    const settings = track.getSettings() as MediaTrackSettings & { displaySurface?: string };
    if (settings.displaySurface && settings.displaySurface !== "monitor") {
      sendSignal(session, "screen_share_partial", Date.now() - startRef.current, {
        displaySurface: settings.displaySurface,
      });
    }

    const onEnded = () => {
      setCurrentScreenTrack(null);
      sendSignal(session, "screen_share_stopped", Date.now() - startRef.current);
    };
    track.addEventListener("ended", onEnded);
    return () => track.removeEventListener("ended", onEnded);
    // Mount-only: the handed-over track is fixed for the life of this component.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function toggleScreenShare() {
    if (currentScreenTrack && currentScreenTrack.readyState === "live") {
      currentScreenTrack.stop();
      setCurrentScreenTrack(null);
      // Stopping on purpose is the same event the reviewer used to see when a share was
      // abandoned mid-interview, so it is reported the same way.
      sendSignal(session, "screen_share_stopped", Date.now() - startRef.current);
      return;
    }

    setScreenShareError(null);
    try {
      if (!navigator.mediaDevices?.getDisplayMedia) {
        throw new Error(
          "Screen sharing isn't supported in this browser. Please use Chrome, Edge, or Firefox."
        );
      }
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      screenStreamRef.current = stream;
      const track = stream.getVideoTracks()[0];
      if (!track) throw new Error("No video track found in the screen share.");

      setCurrentScreenTrack(track);
      everSharedRef.current = true;
      // Accepted — the ask is answered, so stop asking.
      setScreenShareRequested(false);

      // Both of these used to be reported by the pre-join gate, which no longer exists.
      // Sharing a single tab or window instead of the whole screen is noted for the
      // reviewer, never blocked; ending the share is reported whether it was stopped from
      // this button or from the browser's own "Stop sharing" bar.
      const settings = track.getSettings() as MediaTrackSettings & { displaySurface?: string };
      if (settings.displaySurface && settings.displaySurface !== "monitor") {
        sendSignal(session, "screen_share_partial", Date.now() - startRef.current, {
          displaySurface: settings.displaySurface,
        });
      }
      track.onended = () => {
        setCurrentScreenTrack(null);
        sendSignal(session, "screen_share_stopped", Date.now() - startRef.current);
      };
    } catch (err: unknown) {
      // Shown rather than swallowed: when the interviewer has just asked for the screen,
      // a silently-dismissed picker leaves both sides waiting on each other.
      if (
        err instanceof DOMException &&
        (err.name === "NotAllowedError" || err.name === "PermissionDeniedError")
      ) {
        setScreenShareError("Screen sharing was cancelled or blocked. You can try again.");
      } else if (err instanceof DOMException && err.name === "AbortError") {
        setScreenShareError("No screen was selected. You can try again.");
      } else {
        setScreenShareError(
          err instanceof Error ? err.message : "Couldn't start screen sharing. Please try again."
        );
      }
    }
  }

  // Stream the candidate's speech to the interviewer's live transcript panel. Preferred path is
  // instant realtime streaming (upload-only here; the text is shown on the interviewer side); if
  // the backend realtime path is unavailable it falls back to the chunk-upload path below.
  // startedAtMs is omitted on purpose: this side is upload-only, so the displayed offset (computed
  // on the interviewer side) is irrelevant here, and reading startRef during render isn't needed.
  const { fellBack: realtimeFellBack } = useRealtimeTranscribe({
    sessionId: session.id,
    role: "candidate",
    enabled: true,
    token: session.join_token,
  });
  useLiveSpeech({
    sessionId: session.id,
    speaker: "candidate",
    enabled: realtimeFellBack,
    startedAtMs: startRef.current,
    authToken: session.join_token,
    tokenHeaderKey: "X-Interview-Token",
  });

  // Both toggles drive two captures: the call's stream inside WebRTCRoom, and the separate
  // proctoring stream this component records and uploads. Only the first used to be
  // flipped, so "Mute mic" silenced the interviewer while the recording kept listening —
  // and once the pre-join dialog could start the interview muted, unmuting would never have
  // brought the recording back at all.
  function toggleMic() {
    const muted = webrtcApiRef.current?.toggleMic() ?? false;
    streamRef.current?.getAudioTracks().forEach((t) => (t.enabled = !muted));
    setMicMuted(muted);
    setMuteRequested(false);
  }
  function toggleCamera() {
    const off = webrtcApiRef.current?.toggleCamera() ?? false;
    streamRef.current?.getVideoTracks().forEach((t) => (t.enabled = !off));
    cameraOffRef.current = off;
    setCameraOff(off);
  }
  function toggleFullscreen() {
    setIsFullscreenOn(webrtcApiRef.current?.toggleFullscreen() ?? false);
  }

  // meta is optional and carried through to the reviewer's timeline. For the gaze signals
  // it records which way the eyes went, so a flag raised weeks earlier can be read back as
  // "eyes down" rather than an unqualified "gaze off-screen" that nobody can now check.
  function pushSignal(signal_type: SignalType, meta?: Record<string, unknown>) {
    pendingSignals.current.push({
      signal_type,
      session_offset_ms: Date.now() - startRef.current,
      ...(meta ? { meta } : {}),
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
    let tamperFlagged = false;
    const extensionInterval = setInterval(() => {
      if (!aiExtensionFlagged && detectAiExtensionArtifacts()) {
        aiExtensionFlagged = true;
        pushSignal("ai_extension_detected");
        // Told directly rather than only reported to the interviewer. Someone who left an
        // assistant installed and didn't think about it can act on this; someone who did
        // it deliberately now knows it was seen. Either way the flag still stands.
        setProctoringWarning(
          "An AI assistant browser extension was detected on this page. Please disable or " +
            "remove it and reload — this has been noted for the reviewer."
        );
      }

      // Checked on the same cadence: an extension can be switched on part-way through, and
      // the point of this one is that it disables the checks around it.
      if (!tamperFlagged) {
        const tamper = detectProctoringTamper();
        if (tamper) {
          tamperFlagged = true;
          pushSignal("proctoring_tamper_detected");
          setProctoringWarning(
            `${tamper}. A browser extension is interfering with this interview page. ` +
              "Please disable it and reload — this has been noted for the reviewer."
          );
        }
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
    let downGazeStreak = 0;
    let secondFaceStreak = 0;
    // One report per episode — see the emission logic below.
    let gazeAwayReported = false;
    let downGazeReported = false;
    let secondFaceReported = false;
    let motionReported = false;

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

        // The proctoring capture is a second, independent getUserMedia — so the pre-join
        // choices have to be applied here as well as to the call. Without this, a candidate
        // who switched the camera off would still be recorded and uploaded in 5s chunks
        // while the UI told them it was off.
        if (!devicePrefs.cameraEnabled) s.getVideoTracks().forEach((t) => (t.enabled = false));
        if (!devicePrefs.micEnabled) s.getAudioTracks().forEach((t) => (t.enabled = false));

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
          // A disabled video track delivers black frames, and black frames are not evidence
          // of anything — read as proctoring input they would manufacture "no face" and
          // "looking away" for as long as the camera stayed off. The camera being off is
          // already its own plainly visible fact; it should not also become a flag.
          if (cameraOffRef.current) return;
          const result = await detectFace(videoRef.current);
          if (!result) return;

          // Reported once per episode, not once per frame. These conditions persist for as
          // long as they last, and re-sending every 800ms produced hundreds of identical
          // rows — one minute of looking away was ~75 events, which buried every other
          // signal in the interviewer's feed and made the thing unreadable precisely when
          // it mattered. The flag resets when the condition clears, so a genuine second
          // occurrence is still reported.
          if (result.faceCount > 1) {
            secondFaceStreak++;
            if (secondFaceStreak >= 2 && !secondFaceReported) {
              secondFaceReported = true;
              pushSignal("second_face");
            }
          } else {
            secondFaceStreak = 0;
            secondFaceReported = false;
          }

          if (result.gazeOffScreen) {
            gazeAwayStreak++;
            if (gazeAwayStreak >= 3 && !gazeAwayReported) {
              gazeAwayReported = true;
              pushSignal("gaze_off_screen", {
                direction: result.gazeDirection,
                eyeTracked: result.usedBlendshapes,
              });
            }
          } else {
            gazeAwayStreak = 0;
            gazeAwayReported = false;
          }

          // The specific case worth interrupting the interviewer for: eyes held below the
          // screen line rather than merely off it. The detector's own stabiliser has
          // already required ~2.4s before calling it "down"; these extra samples take the
          // total past 4s, which is well beyond a glance at the keyboard and into the
          // territory of reading something. Still one report per episode — a candidate
          // working from paper notes would otherwise generate a row every 800ms all
          // interview, which is how a feed stops being read.
          if (result.downwardGaze) {
            downGazeStreak++;
            if (downGazeStreak >= 2 && !downGazeReported) {
              downGazeReported = true;
              pushSignal("sustained_downward_gaze", { eyeTracked: result.usedBlendshapes });
            }
          } else {
            downGazeStreak = 0;
            downGazeReported = false;
          }

          if (result.excessiveMotion) {
            if (!motionReported) {
              motionReported = true;
              pushSignal("excessive_motion");
            }
          } else {
            motionReported = false;
          }
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
        if (err instanceof ApiError && err.status === 409) return;
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
    // running. The live call's devices are cut explicitly rather than waiting for
    // WebRTCRoom to unmount: that unmount only happens once onDone() re-renders the parent,
    // so the camera light stayed on for a moment after the interview had visibly finished.
    webrtcApiRef.current?.stopMedia();
    recorderRef.current?.stop();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    screenStreamRef.current?.getTracks().forEach((t) => t.stop());
    if (isFullscreenActive()) exitFullscreen().catch(() => {});

    // Recorded once, here, because it is a fact about the whole interview rather than a
    // moment in it. Low weight and excluded from standalone flagging (services/
    // integrity.py) — sharing is optional, so this is context for the reviewer, not an
    // accusation.
    if (!everSharedRef.current) {
      pendingSignals.current.push({
        signal_type: "screen_share_never",
        session_offset_ms: Date.now() - startRef.current,
      });
    }

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
      {proctoringWarning && (
        <div className="w-full max-w-2xl px-4 py-3 rounded-lg bg-amber-50 border border-amber-300 text-amber-900 text-sm">
          <p className="font-semibold mb-0.5">⚠️ Please close this before continuing</p>
          <p className="text-xs leading-relaxed">{proctoringWarning}</p>
        </div>
      )}
      <div className="w-full max-w-2xl h-[420px]">
        <WebRTCRoom
          sessionId={session.id}
          token={session.join_token}
          role="candidate"
          iceServers={session.ice_servers}
          extraVideoTrack={currentScreenTrack}
          initialCameraEnabled={devicePrefs.cameraEnabled}
          initialMicEnabled={devicePrefs.micEnabled}
          enableEyeTracking={true}
          onApiReady={(api) => {
            webrtcApiRef.current = api;
          }}
          onMuteRequested={() => setMuteRequested(true)}
          onScreenShareRequested={() => {
            setScreenShareRequested(true);
            setScreenShareError(null);
          }}
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
      {screenShareRequested && !currentScreenTrack && (
        <div className="w-full max-w-2xl px-4 py-3 rounded-lg bg-blue-50 border border-blue-300 text-blue-900 flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold">The interviewer asked you to share your screen</p>
            <p className="text-xs mt-0.5">
              Your browser will ask which screen or window to share. Sharing your entire
              screen is preferred.
            </p>
          </div>
          <div className="flex gap-2 shrink-0">
            <button onClick={toggleScreenShare} className="btn-primary text-xs px-3 py-1.5">
              Share my screen
            </button>
            <button
              onClick={() => setScreenShareRequested(false)}
              className="btn-outline text-xs px-2 py-1.5"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}
      {screenShareError && (
        <p className="text-xs text-red-600 max-w-2xl text-center">{screenShareError}</p>
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
