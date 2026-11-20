"use client";

import { useParams } from "next/navigation";
import Image from "next/image";
import { useEffect, useRef, useState, useCallback } from "react";
import { BASE_URL, getJson, postForm, postJson } from "@/lib/api";
import { useDialog } from "@/components/Dialog";
import WebRTCRoom, { type WebRTCApi } from "@/components/WebRTCRoom";
import DeviceSetupDialog, {
  DEFAULT_DEVICE_PREFS,
  type DevicePrefs,
} from "@/components/DeviceSetupDialog";
import { GAZE_TONE } from "@/components/EyeTrackingOverlay";
import type { GazeStatus } from "@/lib/eyeGazeTracker";
import LiveTranscriptFeed from "@/components/LiveTranscriptFeed";
import { useLiveSpeech, type LiveTranscriptItem } from "@/lib/useLiveSpeech";
import { useRealtimeTranscribe } from "@/lib/useRealtimeTranscribe";
import { exitFullscreen, isFullscreenActive, onFullscreenChange } from "@/lib/fullscreen";
import type { FacialAffectAnalysis, InterviewSession, LiveSignalEvent, SignalType, VoiceToneAnalysis } from "@/lib/types";

// Pragmatic email shape check — mirrors the backend guard on /send-report (TYH-003).
function isValidEmail(value: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value.trim());
}

interface SentimentSample {
  session_offset_ms: number;
  facial_affect: FacialAffectAnalysis | null;
  voice_tone: VoiceToneAnalysis | null;
}

export interface SuggestedQuestion {
  id: string;
  category: string;
  question: string;
  context_reason: string;
  expected_concepts: string[];
  difficulty: string;
}

export interface AnswerEvaluation {
  // "question" = scored against the active question; "freeform" = understood from the answer alone
  // (no active question), so scoring fields are null/empty and hr_summary is the understanding.
  mode: "question" | "freeform";
  accuracy_score: number | null;
  verdict: "strong" | "partially_correct" | "superficial" | "inaccurate" | "scripted_delivery" | null;
  concepts_covered: string[];
  concepts_missing: string[];
  depth_rating: "deep" | "adequate" | "surface" | null;
  fluff_detected: boolean;
  teleprompter_speech_flag: boolean;
  hr_summary: string;
  /** Up to 3 ranked follow-ups, best first. */
  suggested_followups: string[];
  /** Back-compat: the first follow-up. */
  suggested_followup: string;
}

export interface RatedQuestion {
  question_id: string;
  question_text: string;
  rating: string;
  accuracy_score?: number;
  notes?: string;
  concepts_covered: string[];
  concepts_missing: string[];
  timestamp: string;
}

const SIGNAL_LABELS: Record<SignalType, string> = {
  tab_switch: "Tab switch",
  window_blur: "Window lost focus",
  copy_paste: "Copy/paste",
  second_face: "Second face detected",
  second_voice: "Second voice detected",
  voice_mismatch: "Voice mismatch detected",
  gaze_off_screen: "Gaze off-screen (Looking away)",
  excessive_motion: "Excessive motion",
  virtual_camera: "Virtual camera signature",
  response_timing_anomaly: "Response timing anomaly",
  unauthorized_app_detected: "Unauthorized app running",
  external_display_detected: "External display connected",
  fullscreen_exit: "Exited fullscreen",
  devtools_open: "Browser DevTools possibly open",
  screen_share_partial: "Shared a tab/window, not full screen",
  screen_share_stopped: "Stopped screen sharing",
  screen_share_never: "Never shared their screen",
  location_mismatch: "IP location doesn't match stated location",
  ai_extension_detected: "AI answer-helper browser extension detected",
  teleprompter_reading: "Teleprompter / Script-reading eye motion pattern",
  proctoring_tamper_detected: "Extension interfering with proctoring (focus/visibility faked)",
  sustained_downward_gaze: "Eyes held below the screen — reading something off-screen",
};

/** The header pill is the one gaze readout always on screen, so it names the direction
 * rather than only whether the candidate is engaged — "looking away" and "eyes down at
 * something" call for different questions from the interviewer. */
const HEADER_GAZE_LABEL: Record<GazeStatus, string> = {
  focused: "🟢 Gaze: Focused On Screen",
  looking_down: "👁️ Eyes Down — Off-Screen",
  looking_up: "Gaze: Upward",
  turned_away: "🔴 Gaze: Looking Away",
  teleprompter_reading: "⚠️ Teleprompter Reading",
  no_face: "Gaze: No Face Detected",
};

/** The telemetry panel has room to say what was actually measured, and should: an
 * interviewer deciding how much weight to put on this deserves the finding in plain words,
 * not a colour. */
const TELEMETRY_GAZE_LABEL: Record<GazeStatus, string> = {
  focused: "🟢 Eyes on screen (iris tracking: focused)",
  looking_down: "👁️ Eyes held below the screen — reading something off-screen",
  looking_up: "Eyes directed above the screen",
  turned_away: "🔴 Eyes directed away from the screen",
  teleprompter_reading: "⚠️ Teleprompter Script Reading Detected (Horizontal scanning)",
  no_face: "No face in frame",
};

const DECISION_OPTIONS: { value: "proceed" | "concern" | "reject"; label: string; className: string }[] = [
  { value: "proceed", label: "Proceed", className: "bg-emerald-600 hover:bg-emerald-700 text-white font-medium shadow-sm" },
  { value: "concern", label: "Some concern", className: "bg-amber-600 hover:bg-amber-700 text-white font-medium shadow-sm" },
  { value: "reject", label: "Reject", className: "bg-red-600 hover:bg-red-700 text-white font-medium shadow-sm" },
];

/** Signals that shouldn't wait for the post-interview review. These are the ones that
 * indicate active assistance rather than ordinary nervous behaviour — a glance off-screen
 * or a brief focus loss stays in the Signals tab, where it belongs. */
const CRITICAL_SIGNAL_TYPES: Set<SignalType> = new Set([
  "unauthorized_app_detected",
  "ai_extension_detected",
  "proctoring_tamper_detected",
  "virtual_camera",
  "second_face",
  "second_voice",
  "voice_mismatch",
  "external_display_detected",
  "teleprompter_reading",
  // Surfaced live rather than left for the post-interview review, which is the only point
  // at which it is useful: the interviewer can look at the candidate and ask. By the time
  // anyone reads the report, "were they reading notes or a phone?" is unanswerable.
  // Deliberately NOT treated as evidence on its own — see LOW_SIGNAL_ALONE in
  // backend/app/services/integrity.py.
  "sustained_downward_gaze",
]);

/** Names the offending application where the detector reported one — "an unauthorised app
 * is running" is far less actionable than knowing it is Interview Coder. */
function describeCriticalSignal(signal: LiveSignalEvent): string {
  const label = SIGNAL_LABELS[signal.signal_type] ?? signal.signal_type;
  const apps = signal.meta?.apps;
  if (Array.isArray(apps) && apps.length > 0) {
    return `${label}: ${apps.map(String).join(", ")}`;
  }
  const reason = signal.meta?.reason;
  if (typeof reason === "string" && reason) return `${label} — ${reason}`;
  return label;
}

function formatOffset(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export default function InterviewerCapturePage() {
  const { token } = useParams<{ token: string }>();
  const [session, setSession] = useState<InterviewSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [stopped, setStopped] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);
  const [recordingWarning, setRecordingWarning] = useState<string | null>(null);
  const [liveSignals, setLiveSignals] = useState<LiveSignalEvent[]>([]);
  const [sentimentSamples, setSentimentSamples] = useState<SentimentSample[]>([]);
  const [decision, setDecision] = useState<"proceed" | "concern" | "reject" | null>(null);
  const [decisionNotes, setDecisionNotes] = useState("");
  const [savingDecision, setSavingDecision] = useState(false);
  const [activeTab, setActiveTab] = useState<"questions" | "transcript" | "sentiment" | "proctoring" | "evaluation">("questions");
  // One piece of state for the candidate's gaze, not three. This was a pair of booleans
  // (focused / teleprompter) that could not express "eyes down" at all, and keeping them
  // beside the status would mean three values that can disagree about the same instant.
  const [candidateGazeStatus, setCandidateGazeStatus] = useState<GazeStatus>("focused");
  const isTeleprompterReading = candidateGazeStatus === "teleprompter_reading";

  // AI-Suggested Questions & Live Answer Evaluation
  const [suggestedQuestions, setSuggestedQuestions] = useState<SuggestedQuestion[]>([]);
  const [refreshingQuestions, setRefreshingQuestions] = useState(false);
  const [activeQuestion, setActiveQuestion] = useState<SuggestedQuestion | null>(null);
  const [activeEvaluation, setActiveEvaluation] = useState<AnswerEvaluation | null>(null);
  const [evaluatingAnswer, setEvaluatingAnswer] = useState(false);
  const [ratedQuestions, setRatedQuestions] = useState<RatedQuestion[]>([]);

  // Consolidated scorecard post-meeting state
  const [showScorecard, setShowScorecard] = useState(false);
  const [consolidatedReport, setConsolidatedReport] = useState<Record<string, unknown> | null>(null);
  const [sendingEmail, setSendingEmail] = useState(false);
  const [emailSent, setEmailSent] = useState(false);
  const [emailRecipient, setEmailRecipient] = useState("");
  const { toast } = useDialog();

  // Manual test utterance input
  const [manualUtterance, setManualUtterance] = useState("");

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  // Consecutive failed chunk uploads. One is ordinary — the backend restarting, a blip,
  // or the last chunk racing the page unload when the call ends. A run of them means the
  // interviewer's audio track is actually losing material, which they should know before
  // they rely on the transcript.
  const chunkFailuresRef = useRef(0);
  const webrtcApiRef = useRef<WebRTCApi | null>(null);
  const [micMuted, setMicMuted] = useState(false);
  const [cameraOff, setCameraOff] = useState(false);
  // What the pre-join dialog chose. Unlike the candidate page — where the call lives in a
  // child that mounts after the choice is made — this component is already mounted when the
  // dialog closes, so the choice is also pushed into micMuted/cameraOff by hand there.
  const [devicePrefs, setDevicePrefs] = useState<DevicePrefs>(DEFAULT_DEVICE_PREFS);
  const [setupOpen, setSetupOpen] = useState(false);
  // The interviewer's own screen share — for walking a candidate through a diagram or a
  // code sample. Separate from requestScreenShare() below, which only asks the candidate to
  // share theirs. The candidate's view already renders an incoming screen track, so this
  // needs no counterpart there.
  const screenStreamRef = useRef<MediaStream | null>(null);
  const [screenTrack, setScreenTrack] = useState<MediaStreamTrack | null>(null);
  const [muteRequestSent, setMuteRequestSent] = useState(false);
  const [screenShareRequestSent, setScreenShareRequestSent] = useState(false);
  const [isFullscreenOn, setIsFullscreenOn] = useState(false);
  // Toasts raised over the call itself. The banner above the grid is the standing record;
  // this is what actually catches the eye of someone looking at the candidate rather than
  // at the page furniture.
  const [alertToasts, setAlertToasts] = useState<{ key: string; text: string }[]>([]);
  // Signals already toasted. The live feed is re-fetched whole every 3s, so without this
  // every poll would re-raise the same alert forever.
  const toastedSignalsRef = useRef<Set<string>>(new Set());
  const [callEnded, setCallEnded] = useState(false);
  const [joined, setJoined] = useState(false);
  const [callStartTime, setCallStartTime] = useState<number>(Date.now());
  const [elapsedMs, setElapsedMs] = useState(0);

  // Live call duration — ticks every second from the same callStartTime anchor everything
  // else (live transcript offsets, sentiment sample offsets) is measured from, so this
  // always matches the timestamps shown elsewhere instead of drifting from its own clock.
  useEffect(() => {
    if (!joined || callEnded) return;
    setElapsedMs(Date.now() - callStartTime);
    const timer = setInterval(() => setElapsedMs(Date.now() - callStartTime), 1000);
    return () => clearInterval(timer);
  }, [joined, callEnded, callStartTime]);

  // Instant streaming transcription (Route A). This interviewer socket streams the interviewer's
  // own mic AND receives both speakers' transcript events pushed back, so `realtimeFinals` /
  // `realtimeInterims` are the live display source. `onCandidateTurn` fires the moment a candidate
  // utterance is finalized, so answer evaluation (and its suggested follow-up) runs instantly
  // instead of waiting for the poll debounce. If the backend realtime path is off/unavailable,
  // `realtimeFellBack` flips true and the chunk-upload path + poll below take over.
  const runEvalRef = useRef<((text: string) => void) | null>(null);
  const candidateTextRef = useRef("");
  const {
    finals: realtimeFinals,
    interims: realtimeInterims,
    fellBack: realtimeFellBack,
  } = useRealtimeTranscribe({
    sessionId: session?.id,
    role: "interviewer",
    enabled: joined && !callEnded,
    token: session?.interviewer_join_token ?? undefined,
    startedAtMs: callStartTime,
    onCandidateTurn: (text) => {
      // Skip trivial turns ("yes", "okay, sure") — now that this also runs free-form on every
      // candidate turn, a word-count floor keeps the per-turn evaluation cost in check.
      if (text.trim().split(/\s+/).filter(Boolean).length < 6) return;
      // Evaluate the full answer so far (prior turns + this one), not just the last sentence.
      const full = `${candidateTextRef.current} ${text}`.trim();
      runEvalRef.current?.(full || text);
    },
  });

  // Chunk-upload fallback — only captures the interviewer's audio when realtime fell back. The
  // actual text then comes back through the live-transcripts poll below. `isCapturing` drives the
  // "recording…" indicator in that mode.
  const { isCapturing: interviewerCapturing } = useLiveSpeech({
    sessionId: session?.id,
    speaker: "interviewer",
    enabled: joined && !callEnded && realtimeFellBack,
    startedAtMs: callStartTime,
    authToken: session?.interviewer_join_token ?? undefined,
    tokenHeaderKey: "X-Interviewer-Token",
  });

  // Polled live transcript items from both candidate & interviewer
  const [mergedLiveTranscripts, setMergedLiveTranscripts] = useState<LiveTranscriptItem[]>([]);

  useEffect(() => {
    getJson<InterviewSession>(`/interviews/interviewer-join/${token}`)
      .then((s) => {
        setSession(s);
        if (s.interviewer_live_decision) setDecision(s.interviewer_live_decision as "proceed" | "concern" | "reject");
        if (s.interviewer_live_notes) setDecisionNotes(s.interviewer_live_notes);
      })
      .catch(() => setError("This interviewer link is invalid or has expired."));
  }, [token]);

  // Fetch AI-suggested questions (refresh=true re-rolls a fresh set — TYH-020).
  const loadSuggestedQuestions = useCallback(
    async (refresh = false) => {
      if (!session) return;
      if (refresh) setRefreshingQuestions(true);
      try {
        const questions = await getJson<SuggestedQuestion[]>(
          `/interviews/${session.id}/suggested-questions${refresh ? "?refresh=true" : ""}`
        );
        if (questions && questions.length > 0) {
          setSuggestedQuestions(questions);
          setActiveQuestion(questions[0]);
        }
      } catch {
        // non-fatal — the interviewer can still run the call without suggestions
      } finally {
        if (refresh) setRefreshingQuestions(false);
      }
    },
    [session]
  );

  useEffect(() => {
    if (!session) return;
    // Initial load (refresh=false) never sets state synchronously; the static rule can't see that.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadSuggestedQuestions();

    getJson<RatedQuestion[]>(`/interviews/${session.id}/qa-evaluations`)
      .then((evals) => {
        if (evals) setRatedQuestions(evals);
      })
      .catch(() => {});
  }, [session, loadSuggestedQuestions]);

  // Live signals polling
  useEffect(() => {
    if (!session || callEnded) return;
    const poll = () =>
      getJson<LiveSignalEvent[]>(`/interviews/${session.id}/live-signals`, {
        "X-Interviewer-Token": session.interviewer_join_token ?? "",
      })
        .then(setLiveSignals)
        .catch(() => {});
    poll();
    const interval = setInterval(poll, 3000);
    return () => clearInterval(interval);
  }, [session, callEnded]);

  // Raises a toast over the call the first time each serious signal appears. Keyed on
  // type + offset because the feed is replaced wholesale on every poll — identity has to
  // come from the event itself, not from its position in the array.
  useEffect(() => {
    const fresh = liveSignals
      .filter((s) => CRITICAL_SIGNAL_TYPES.has(s.signal_type))
      .map((s) => ({ key: `${s.signal_type}:${s.session_offset_ms}`, text: describeCriticalSignal(s) }))
      .filter((t) => !toastedSignalsRef.current.has(t.key));

    if (fresh.length === 0) return;
    fresh.forEach((t) => toastedSignalsRef.current.add(t.key));
    setAlertToasts((prev) => [...prev, ...fresh].slice(-3));

    // Long enough to read mid-conversation without having to break off; the banner and
    // the Signals tab keep it afterwards, so nothing is lost when it goes.
    const timer = setTimeout(() => {
      setAlertToasts((prev) => prev.filter((p) => !fresh.some((f) => f.key === p.key)));
    }, 15000);
    return () => clearTimeout(timer);
  }, [liveSignals]);

  // Live sentiment polling
  useEffect(() => {
    if (!session || callEnded) return;
    const poll = () =>
      getJson<SentimentSample[]>(`/interviews/${session.id}/live-sentiment`, {
        "X-Interviewer-Token": session.interviewer_join_token ?? "",
      })
        .then((samples) => {
          if (samples && samples.length > 0) setSentimentSamples(samples);
        })
        .catch(() => {});
    poll();
    const interval = setInterval(poll, 8000);
    return () => clearInterval(interval);
  }, [session, callEnded]);

  // Live transcripts polling — only the fallback path. When realtime streaming is working the
  // transcript arrives over the WebSocket (realtimeFinals), so there's no need to poll.
  useEffect(() => {
    if (!session || callEnded || !realtimeFellBack) return;
    const poll = () =>
      getJson<LiveTranscriptItem[]>(`/interviews/${session.id}/live-transcripts`)
        .then((items) => {
          if (items && items.length > 0) {
            setMergedLiveTranscripts(items);
          }
        })
        .catch(() => {});
    poll();
    const interval = setInterval(poll, 2500);
    return () => clearInterval(interval);
  }, [session, callEnded, realtimeFellBack]);

  // Display source: streamed finals when realtime works, polled chunks when it fell back.
  const allTranscripts = realtimeFellBack ? mergedLiveTranscripts : realtimeFinals;

  // Keep the running candidate answer current for the instant onCandidateTurn trigger above.
  useEffect(() => {
    candidateTextRef.current = allTranscripts
      .filter((t) => t.speaker === "candidate")
      .map((t) => t.text)
      .join(" ");
  }, [allTranscripts]);

  // Real-time answer evaluation + follow-up suggestion. Runs in question mode when a question is
  // active (scores against it) and free-form otherwise (understands the answer and suggests
  // follow-ups from it alone).
  const runAnswerEvaluation = useCallback(async (customSpeech?: string) => {
    if (!session) return;

    let candidateSpeech = customSpeech;
    if (!candidateSpeech) {
      candidateSpeech = allTranscripts
        .filter((t) => t.speaker === "candidate")
        .map((t) => t.text)
        .join(" ");
    }

    if (!candidateSpeech || candidateSpeech.length < 8) {
      return;
    }

    setEvaluatingAnswer(true);
    try {
      const evalResult = await postJson<AnswerEvaluation>(
        `/interviews/${session.id}/evaluate-live-answer`,
        activeQuestion
          ? {
              question_id: activeQuestion.id,
              question_text: activeQuestion.question,
              expected_concepts: activeQuestion.expected_concepts,
              candidate_transcript: candidateSpeech,
            }
          : { candidate_transcript: candidateSpeech }
      );
      setActiveEvaluation(evalResult);
    } catch {
      // Degrade gracefully
    } finally {
      setEvaluatingAnswer(false);
    }
  }, [session, activeQuestion, allTranscripts]);

  // Promote a suggested follow-up to the Active Question so the next answer is evaluated against it.
  const askFollowup = useCallback((text: string) => {
    setActiveQuestion({
      id: `followup-${Date.now()}`,
      category: "Follow-up",
      question: text,
      context_reason: "Adaptive follow-up from the candidate's answer",
      expected_concepts: [],
      difficulty: "intermediate",
    });
    setActiveEvaluation(null);
    setActiveTab("questions");
  }, []);

  // Let the realtime onCandidateTurn trigger call the latest runAnswerEvaluation without
  // re-opening the transcription socket on every render.
  useEffect(() => {
    runEvalRef.current = runAnswerEvaluation;
  }, [runAnswerEvaluation]);

  // Debounced answer evaluation — fallback path only. With realtime streaming, evaluation fires
  // instantly from onCandidateTurn the moment the candidate finishes a turn, so this debounce is
  // disabled to avoid duplicate (billed) evaluation calls.
  useEffect(() => {
    if (!realtimeFellBack || !activeQuestion || allTranscripts.length === 0) return;
    const timer = setTimeout(() => {
      runAnswerEvaluation();
    }, 3500);
    return () => clearTimeout(timer);
  }, [realtimeFellBack, allTranscripts, activeQuestion, runAnswerEvaluation]);

  async function handleRateQuestion(rating: "strong_pass" | "needs_followup" | "inaccurate_scripted") {
    if (!session || !activeQuestion) return;
    const accuracy = activeEvaluation?.accuracy_score ?? 80;
    try {
      const res = await postJson<{ qa_evaluations: RatedQuestion[] }>(`/interviews/${session.id}/rate-question-answer`, {
        question_id: activeQuestion.id,
        question_text: activeQuestion.question,
        rating,
        accuracy_score: accuracy,
        concepts_covered: activeEvaluation?.concepts_covered ?? [],
        concepts_missing: activeEvaluation?.concepts_missing ?? [],
      });
      if (res.qa_evaluations) setRatedQuestions(res.qa_evaluations);
    } catch {}
  }

  async function handleSendManualUtterance(speaker: "candidate" | "interviewer") {
    if (!session || !manualUtterance.trim()) return;
    const text = manualUtterance.trim();
    setManualUtterance("");
    try {
      await postJson(`/interviews/${session.id}/live-transcript`, {
        speaker,
        text,
        offset_ms: Date.now() - callStartTime,
      });
      if (speaker === "candidate" && activeQuestion) {
        runAnswerEvaluation(text);
      }
    } catch {}
  }

  const loadConsolidatedReport = useCallback(async () => {
    if (!session) return;
    try {
      const data = await getJson<Record<string, unknown>>(`/interviews/${session.id}/consolidated-report`);
      setConsolidatedReport(data);
      setShowScorecard(true);
    } catch {
      setShowScorecard(true);
    }
  }, [session]);

  // Takes the choice as an argument rather than reading devicePrefs: this is called from
  // the same handler that sets that state, and a state update is not visible to the closure
  // that scheduled it — so reading it here would always see the previous value.
  async function startRecording(prefs: DevicePrefs = devicePrefs) {
    if (!session) return;
    setMicError(null);
    setRecordingWarning(null);
    chunkFailuresRef.current = 0;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      // Joining muted has to mean muted here too. This recorder is independent of the call,
      // so without this the transcript would carry the interviewer's side of a conversation
      // the candidate never heard.
      if (!prefs.micEnabled) stream.getAudioTracks().forEach((t) => (t.enabled = false));
      const recorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
      recorder.ondataavailable = async (e) => {
        if (e.data.size === 0) return;
        const form = new FormData();
        form.append("chunk", e.data, "chunk.webm");
        // Every periodic upload in this app is best-effort (see the candidate page and
        // useLiveSpeech), and this one has to be too: it is an async DOM event handler, so
        // a rejection here has nowhere to go but an unhandled promise rejection — which in
        // dev is a full-screen "Failed to fetch" overlay thrown over a live interview,
        // every 5 seconds, for a dropped audio chunk. The upload fires again in 5s anyway,
        // and `stop()` on End Call flushes a final chunk whose request is routinely
        // cancelled by the page tearing down, which is not an error worth showing at all.
        try {
          await postForm(`/interviews/${session.id}/interviewer-recording-chunk`, form, {
            "X-Interviewer-Token": session.interviewer_join_token ?? "",
          });
          chunkFailuresRef.current = 0;
          setRecordingWarning(null);
        } catch {
          chunkFailuresRef.current += 1;
          // ~15s of consecutive loss before saying anything, so a single blip stays quiet.
          if (chunkFailuresRef.current >= 3) {
            setRecordingWarning(
              "Your audio recording isn't reaching the server — the saved interview audio may be incomplete."
            );
          }
        }
      };
      recorder.start(5000);
      recorderRef.current = recorder;
      setRecording(true);
    } catch (err) {
      setMicError(err instanceof Error ? err.message : "Could not access microphone.");
    }
  }

  function endCall(notifyPeer = true) {
    // Told first, while the connection is still up — the message can't be delivered once
    // the tracks and socket below are gone.
    if (notifyPeer) {
      webrtcApiRef.current?.notifyPeerEnded();
    }

    // Two independent captures have to be released, and both are released here rather
    // than left to component teardown: unmounting WebRTCRoom also stops its devices, but
    // only on a later render, so the camera light lingered after the button was pressed.
    webrtcApiRef.current?.stopMedia();
    recorderRef.current?.stop();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    // A share left running after the call would keep the browser's "sharing your screen"
    // bar up over whatever the interviewer does next.
    screenStreamRef.current?.getTracks().forEach((t) => t.stop());
    screenStreamRef.current = null;
    setScreenTrack(null);
    recorderRef.current = null;
    streamRef.current = null;

    setRecording(false);
    setStopped(true);
    if (isFullscreenActive()) exitFullscreen().catch(() => {});
    // Also what stops the live-speech capture, which is gated on !callEnded.
    setCallEnded(true);
    setTimeout(loadConsolidatedReport, 1000);
  }

  function toggleMic() {
    const muted = webrtcApiRef.current?.toggleMic() ?? false;
    // The interviewer's voice is captured twice: once by the call, and once by the
    // audio-only recorder feeding the live transcript. Muting has to reach both, or the
    // transcript keeps attributing speech to someone the candidate cannot hear.
    streamRef.current?.getAudioTracks().forEach((t) => (t.enabled = !muted));
    setMicMuted(muted);
  }

  function toggleCamera() {
    setCameraOff(webrtcApiRef.current?.toggleCamera() ?? false);
  }

  async function toggleScreenShare() {
    if (screenTrack && screenTrack.readyState === "live") {
      screenTrack.stop();
      screenStreamRef.current = null;
      setScreenTrack(null);
      return;
    }

    try {
      if (!navigator.mediaDevices?.getDisplayMedia) {
        throw new Error(
          "Screen sharing is not supported in this browser. Please use Chrome, Edge, or Firefox."
        );
      }
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const track = stream.getVideoTracks()[0];
      if (!track) throw new Error("No video track was found in the screen share.");
      screenStreamRef.current = stream;
      setScreenTrack(track);
      // Also fires for the browser's own "Stop sharing" bar, which is the usual way a share
      // ends and would otherwise leave the button claiming a share that is already over.
      track.onended = () => {
        screenStreamRef.current = null;
        setScreenTrack(null);
      };
    } catch (err) {
      // Shown rather than swallowed: a silently-dismissed picker looks identical to a
      // share that started, and the interviewer would carry on talking to a blank panel.
      let message = "Could not start screen sharing.";
      if (err instanceof DOMException) {
        if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") {
          message = "Screen sharing was cancelled or blocked.";
        } else if (err.name === "AbortError") {
          message = "No screen was selected.";
        } else if (err instanceof Error) {
          message = err.message;
        }
      } else if (err instanceof Error) {
        message = err.message;
      }
      toast({ variant: "error", message });
    }
  }

  function toggleFullscreen() {
    setIsFullscreenOn(webrtcApiRef.current?.toggleFullscreen() ?? false);
  }

  // Keeps the button's label accurate if fullscreen is exited via Esc rather than the
  // button itself — isFullscreenOn would otherwise stay stuck on "Exit Fullscreen".
  useEffect(() => onFullscreenChange(() => setIsFullscreenOn(isFullscreenActive())), []);

  function requestScreenShare() {
    // Only a prompt on their side, never a share: getDisplayMedia needs a user gesture in
    // the candidate's own browser, so they still choose what (and whether) to share.
    webrtcApiRef.current?.requestPeerScreenShare();
    setScreenShareRequestSent(true);
    setTimeout(() => setScreenShareRequestSent(false), 3000);
  }

  function requestMute() {
    webrtcApiRef.current?.requestPeerMute();
    setMuteRequestSent(true);
    setTimeout(() => setMuteRequestSent(false), 3000);
  }

  async function submitDecision(value: "proceed" | "concern" | "reject") {
    if (!session) return;
    setDecision(value);
    setSavingDecision(true);
    try {
      await postJson(
        `/interviews/${session.id}/interviewer-decision`,
        { decision: value, notes: decisionNotes || null },
        { "X-Interviewer-Token": session.interviewer_join_token ?? "" }
      );
    } finally {
      setSavingDecision(false);
    }
  }

  async function handleSendEmailReport() {
    if (!session) return;
    const recipient = emailRecipient.trim();
    // TYH-003: never dispatch without a valid recipient. The button is already disabled for
    // this, but guard here too so the report can't be "dispatched" to an empty address.
    if (!isValidEmail(recipient)) {
      toast({ variant: "error", message: "Enter a valid interviewer email address before sending." });
      return;
    }
    setSendingEmail(true);
    try {
      await postJson(`/interviews/${session.id}/send-report`, {
        recipient_email: recipient,
      });
      setEmailSent(true);
      toast({ variant: "success", message: `Report dispatched to ${recipient}.` });
    } catch (err) {
      toast({
        variant: "error",
        message: err instanceof Error && err.message ? err.message : "Failed to send the report.",
      });
    } finally {
      setSendingEmail(false);
    }
  }

  if (error) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 bg-zinc-50 min-h-screen text-zinc-900">
        <div className="max-w-md p-6 bg-surface border border-zinc-200 rounded-xl text-center shadow-md">
          <p className="text-red-600 font-medium">{error}</p>
        </div>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 bg-zinc-50 min-h-screen text-zinc-900">
        <div className="flex items-center gap-3 text-zinc-500">
          <span className="w-5 h-5 border-2 border-zinc-300 border-t-blue-600 rounded-full animate-spin"></span>
          <span>Loading Interviewer Command Center…</span>
        </div>
      </div>
    );
  }

  const latestSentiment = sentimentSamples.length > 0 ? sentimentSamples[0] : null;
  const criticalSignals = liveSignals.filter((s) => CRITICAL_SIGNAL_TYPES.has(s.signal_type));

  return (
    <div className="flex flex-col min-h-screen bg-zinc-50 text-zinc-900 font-sans">
      {/* Top Header with TyHire Logo */}
      <header className="flex items-center justify-between px-6 py-3.5 bg-surface border-b border-zinc-200 shrink-0 sticky top-0 z-20 shadow-xs">
        <div className="flex items-center gap-4">
          <Image src="/logo.png" alt="TyHire" width={120} height={40} priority className="h-7 w-auto" />
          <div className="h-5 w-px bg-zinc-200" />
          <div>
            <h1 className="text-sm font-bold tracking-tight text-zinc-900 flex items-center gap-2">
              Interviewer Command Center
              <span className="text-[10px] uppercase px-2 py-0.5 rounded-full bg-blue-50 border border-blue-200 text-blue-700 font-mono font-semibold">
                GPT Telemetry & Gaze AI
              </span>
            </h1>
            <p className="text-xs text-zinc-500">
              Candidate: <strong className="text-zinc-800 font-semibold">{session.candidate_name}</strong>
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {joined && !callEnded && (
            <div className="flex items-center gap-2 px-3 py-1 bg-surface border border-zinc-200 rounded-full text-xs shadow-xs">
              <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
              <span className="text-zinc-700 text-xs font-semibold font-mono">
                {formatOffset(elapsedMs)}
              </span>
            </div>
          )}

          {joined && !callEnded && isTeleprompterReading && (
            <div className="flex items-center gap-2 px-3 py-1 bg-purple-50 border border-purple-300 rounded-full text-xs animate-pulse">
              <span className="w-2.5 h-2.5 rounded-full bg-purple-600 shadow-[0_0_8px_#9333ea]" />
              <span className="text-purple-700 font-bold">⚠️ Teleprompter Script Reading Detected</span>
            </div>
          )}

          {joined && !callEnded && (
            <div className="flex items-center gap-2 px-3 py-1 bg-surface border border-zinc-200 rounded-full text-xs shadow-xs">
              <span className={`w-2 h-2 rounded-full ${GAZE_TONE[candidateGazeStatus].dot}`} />
              <span className={`text-xs ${GAZE_TONE[candidateGazeStatus].text}`}>
                {HEADER_GAZE_LABEL[candidateGazeStatus]}
              </span>
            </div>
          )}

          {joined && !callEnded && (
            <button
              onClick={() => endCall()}
              className="px-4 py-1.5 rounded-lg bg-red-600 hover:bg-red-700 text-white text-xs font-bold shadow-sm transition-all"
            >
              End Interview
            </button>
          )}

          {callEnded && (
            <button
              onClick={loadConsolidatedReport}
              className="px-3.5 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold shadow-sm"
            >
              View Consolidated Scorecard
            </button>
          )}
        </div>
      </header>

      {/* Pre-Join Screen */}
      {!joined ? (
        <div className="flex flex-1 items-center justify-center p-8">
          <div className="max-w-lg w-full bg-surface border border-zinc-200 rounded-2xl p-8 text-center shadow-lg space-y-6">
            <div className="w-16 h-16 bg-blue-50 border border-blue-200 rounded-2xl flex items-center justify-center mx-auto text-3xl">
              🎯
            </div>
            <div>
              <h2 className="text-xl font-bold text-zinc-900 mb-2">Ready to Conduct Interview</h2>
              <p className="text-sm text-zinc-500 leading-relaxed">
                Conduct the interview for <strong>{session.candidate_name}</strong> with real-time GPT question guidance, live answer accuracy analysis, teleprompter eye gaze detection, and live transcription.
              </p>
            </div>

            <button
              onClick={() => setSetupOpen(true)}
              className="w-full py-3.5 px-6 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-bold text-sm shadow-md hover:shadow-lg transition-all transform active:scale-98"
            >
              Check devices &amp; join
            </button>
          </div>

          {setupOpen && (
            <DeviceSetupDialog
              title="Before you join"
              description="Check how you look and sound, and choose what to turn on. You can change any of this during the interview."
              joinLabel="Join Meet & Start AI Telemetry"
              allowScreenShare
              onCancel={() => setSetupOpen(false)}
              onJoin={(prefs) => {
                // Pushed into the control-bar state by hand: this component is already
                // mounted, so unlike the candidate's recorder it cannot pick these up from
                // a useState initialiser.
                setDevicePrefs(prefs);
                setMicMuted(!prefs.micEnabled);
                setCameraOff(!prefs.cameraEnabled);
                setScreenTrack(prefs.screenTrack);
                if (prefs.screenTrack) {
                  screenStreamRef.current = new MediaStream([prefs.screenTrack]);
                  // Re-pointed off the dialog, which is about to unmount.
                  prefs.screenTrack.onended = () => {
                    screenStreamRef.current = null;
                    setScreenTrack(null);
                  };
                }
                setSetupOpen(false);

                // Deliberately NOT auto-fullscreening the whole page here — that swallowed
                // the AI Questions/Transcript/Sentiment/Signals tabs and decision bar along
                // with the video, with no way back short of Esc. WebRTCRoom's own fullscreen
                // button now targets just the video+screenshare area instead.
                setCallStartTime(Date.now());
                setJoined(true);
                startRecording(prefs);
              }}
            />
          )}
        </div>
      ) : (
        <>
        {/* Live proctoring alert. Deliberately outside the tab panels: these were only
            visible inside the Signals tab, and during a live call the interviewer is
            almost always on AI Questions — so "the candidate is running an AI assistant
            right now" sat behind a tab nobody was looking at and was first noticed in the
            post-interview review. Serious signals now interrupt wherever you are. */}
        {criticalSignals.length > 0 && (
          <div className="px-4 pt-3 max-w-[1600px] w-full mx-auto">
            <div className="rounded-xl border-2 border-red-400 bg-red-50 shadow-sm overflow-hidden">
              <div className="flex items-center justify-between gap-3 px-4 py-2 bg-red-100/70 border-b border-red-200">
                <span className="flex items-center gap-2 text-sm font-bold text-red-800">
                  <span className="relative flex h-2.5 w-2.5">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-500 opacity-75" />
                    <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-red-600" />
                  </span>
                  Detected during this interview ({criticalSignals.length})
                </span>
                <button
                  onClick={() => setActiveTab("proctoring")}
                  className="text-[11px] font-bold text-red-700 underline hover:text-red-900 shrink-0"
                >
                  Open the full signal feed
                </button>
              </div>
              <ul className="divide-y divide-red-200/70 max-h-32 overflow-y-auto">
                {criticalSignals
                  .slice()
                  .reverse()
                  .slice(0, 4)
                  .map((s, i) => (
                    <li key={i} className="flex items-center justify-between gap-3 px-4 py-1.5 text-xs">
                      <span className="text-red-900 font-medium">{describeCriticalSignal(s)}</span>
                      <span className="text-[10px] text-red-500 font-mono shrink-0">
                        {formatOffset(s.session_offset_ms)}
                      </span>
                    </li>
                  ))}
              </ul>
              <p className="px-4 py-1.5 text-[11px] text-red-700 bg-red-100/50 border-t border-red-200">
                The candidate has been asked on their own screen to close it. Nothing is
                auto-rejected — raise it in the call, or leave it for review.
              </p>
            </div>
          </div>
        )}
        {/* Main Command Center Layout */}
        <main className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-4 p-4 max-w-[1600px] w-full mx-auto">
          {/* Left Column: Two-Part Video/Screenshare & Active Question / Then-and-There Decision */}
          <div className="lg:col-span-7 flex flex-col gap-3">
            <div className="relative w-full h-[450px] bg-white rounded-xl overflow-hidden border border-zinc-200 shadow-sm p-1.5">
              {/* Alert toasts, over the call itself. Placed here rather than at the edge of
                  the page on purpose: during an interview the interviewer is watching the
                  candidate, and anything outside this box goes unread until afterwards. */}
              {alertToasts.length > 0 && (
                <div className="absolute top-3 left-1/2 -translate-x-1/2 z-40 w-[min(32rem,92%)] space-y-2 pointer-events-none">
                  {alertToasts.map((toast) => (
                    <div
                      key={toast.key}
                      className="pointer-events-auto flex items-start gap-2.5 rounded-xl border border-red-700 bg-red-600 px-3.5 py-2.5 text-white shadow-2xl ring-2 ring-red-500/40"
                    >
                      <span className="relative flex h-2.5 w-2.5 mt-1 shrink-0">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-white opacity-75" />
                        <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-white" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-[11px] font-bold uppercase tracking-wider text-red-100">
                          External tool detected
                        </p>
                        <p className="text-xs font-semibold leading-snug break-words">{toast.text}</p>
                      </div>
                      <button
                        onClick={() =>
                          setAlertToasts((prev) => prev.filter((t) => t.key !== toast.key))
                        }
                        aria-label="Dismiss"
                        className="shrink-0 text-red-100 hover:text-white text-sm font-bold leading-none px-1"
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {!callEnded ? (
                <WebRTCRoom
                  sessionId={session.id}
                  token={session.interviewer_join_token ?? ""}
                  role="interviewer"
                  iceServers={session.ice_servers}
                  extraVideoTrack={screenTrack}
                  initialCameraEnabled={devicePrefs.cameraEnabled}
                  initialMicEnabled={devicePrefs.micEnabled}
                  enableEyeTracking={true}
                  onGazeChange={(focused, isTeleprompter, status) => {
                    // Same fallback as WebRTCRoom's own handler: if a caller ever omits the
                    // status, land on a sensible state rather than leaving the pill frozen
                    // on whatever it last showed.
                    setCandidateGazeStatus(
                      status ??
                        (isTeleprompter ? "teleprompter_reading" : focused ? "focused" : "turned_away")
                    );
                  }}
                  onApiReady={(api) => {
                    webrtcApiRef.current = api;
                  }}
                  onPeerEnded={() => endCall(false)}
                  livekitToken={session.livekit_token}
                  livekitUrl={session.livekit_url}
                />
              ) : (
                <div className="flex items-center justify-center w-full h-full bg-zinc-100 text-zinc-500 text-sm font-medium rounded-lg">
                  Call ended — recording finalized.
                </div>
              )}
            </div>

            {/* Live follow-ups when no question is active — driven purely by the candidate's answer.
                Click one to promote it to the Active Question. */}
            {!activeQuestion && activeEvaluation?.mode === "freeform" && (
              <div className="bg-surface border border-zinc-200 rounded-xl p-4 space-y-2 shadow-xs">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-indigo-50 border border-indigo-200 text-indigo-700">
                    💡 Live Follow-ups
                  </span>
                  {evaluatingAnswer && (
                    <span className="text-[11px] text-zinc-400 italic">reading answer…</span>
                  )}
                </div>
                {activeEvaluation.hr_summary && (
                  <p className="text-[11px] text-zinc-600 leading-relaxed">
                    <strong className="text-zinc-700">They said:</strong> {activeEvaluation.hr_summary}
                  </p>
                )}
                <div className="space-y-1">
                  {activeEvaluation.suggested_followups.map((f, i) => (
                    <button
                      key={i}
                      onClick={() => askFollowup(f)}
                      title="Click to ask this as the next question"
                      className="w-full text-left px-2 py-1.5 rounded-md bg-indigo-50/70 hover:bg-indigo-100 border border-indigo-200 hover:border-indigo-400 text-[11px] text-indigo-900 transition-all flex items-start gap-1.5"
                    >
                      <span className="font-bold text-indigo-500">{i + 1}.</span>
                      <span>{f}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Active Question & "Then and There" Instant Decision Bar */}
            {activeQuestion && (
              <div className="bg-surface border border-zinc-200 rounded-xl p-4 space-y-3 shadow-xs">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-blue-50 border border-blue-200 text-blue-700">
                    Active Question · {activeQuestion.category} · {activeQuestion.difficulty}
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => runAnswerEvaluation()}
                      disabled={evaluatingAnswer}
                      className="px-2.5 py-1 rounded bg-blue-50 hover:bg-blue-100 border border-blue-200 text-blue-700 text-[11px] font-bold transition-all flex items-center gap-1 shadow-2xs"
                    >
                      {evaluatingAnswer ? "Evaluating…" : "⚡ Evaluate Answer"}
                    </button>
                    {activeEvaluation && activeEvaluation.accuracy_score != null && (
                      <span className="text-xs font-bold px-2.5 py-0.5 rounded-full bg-emerald-50 border border-emerald-200 text-emerald-700 shadow-2xs">
                        Accuracy: {activeEvaluation.accuracy_score.toFixed(0)}/100
                      </span>
                    )}
                  </div>
                </div>

                <p className="text-xs font-bold text-zinc-900 leading-relaxed">{activeQuestion.question}</p>

                {/* Concept Checklist */}
                <div className="flex flex-wrap gap-1.5 pt-0.5">
                  {activeQuestion.expected_concepts.map((concept, idx) => {
                    const isCovered = activeEvaluation?.concepts_covered.includes(concept);
                    return (
                      <span
                        key={idx}
                        className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border transition-all ${
                          isCovered
                            ? "bg-emerald-50 border-emerald-300 text-emerald-700 shadow-2xs"
                            : "bg-zinc-50 border-zinc-200 text-zinc-500"
                        }`}
                      >
                        {isCovered ? "✓" : "○"} {concept}
                      </span>
                    );
                  })}
                </div>

                {/* Adaptive Follow-ups — click one to make it the Active Question */}
                {activeEvaluation && activeEvaluation.suggested_followups.length > 0 && (
                  <div className="p-2.5 rounded-lg bg-indigo-50 border border-indigo-200 text-[11px] text-indigo-900 space-y-1.5">
                    <strong className="text-indigo-700 font-bold">💡 Suggested Follow-ups</strong>
                    <div className="space-y-1">
                      {activeEvaluation.suggested_followups.map((f, i) => (
                        <button
                          key={i}
                          onClick={() => askFollowup(f)}
                          title="Click to ask this as the next question"
                          className="w-full text-left px-2 py-1.5 rounded-md bg-white/70 hover:bg-white border border-indigo-200 hover:border-indigo-400 transition-all flex items-start gap-1.5"
                        >
                          <span className="font-bold text-indigo-500">{i + 1}.</span>
                          <span>{f}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* "Then and There" 1-Click Evaluation Buttons */}
                <div className="flex items-center justify-between pt-2 border-t border-zinc-100">
                  <span className="text-[11px] font-bold text-zinc-600">Rate Answer Then & There:</span>
                  <div className="flex gap-2">
                    <button
                      onClick={() => handleRateQuestion("strong_pass")}
                      className="px-3 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-[11px] font-bold shadow-2xs transition-all"
                    >
                      🟢 Strong Pass
                    </button>
                    <button
                      onClick={() => handleRateQuestion("needs_followup")}
                      className="px-3 py-1 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-[11px] font-bold shadow-2xs transition-all"
                    >
                      🟡 Needs Follow-up
                    </button>
                    <button
                      onClick={() => handleRateQuestion("inaccurate_scripted")}
                      className="px-3 py-1 rounded-lg bg-red-600 hover:bg-red-700 text-white text-[11px] font-bold shadow-2xs transition-all"
                    >
                      🔴 Inaccurate / Scripted
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* In-Call Action Toolbar — gone once the call is over. Leaving it up implied
                the call was still live, and "Start Audio Record" would genuinely re-open
                the microphone after the interview had ended. */}
            {callEnded ? (
              <div className="bg-white border border-zinc-200 rounded-xl p-4 shadow-xs space-y-3">
                <p className="text-sm font-semibold text-emerald-700 flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-full bg-emerald-500" />
                  Interview ended — camera, microphone and recording are all off.
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    onClick={loadConsolidatedReport}
                    className="px-3.5 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold shadow-2xs"
                  >
                    View Consolidated Scorecard
                  </button>
                  <span className="text-xs text-zinc-500">
                    You can close this tab when you&apos;re done — nothing is still recording.
                  </span>
                </div>
              </div>
            ) : (
            <div className="flex flex-wrap items-center justify-between bg-white border border-zinc-200 rounded-xl p-2.5 gap-2 shadow-xs">
              <div className="flex items-center gap-2">
                <button
                  onClick={toggleMic}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all ${
                    micMuted ? "bg-red-50 border-red-200 text-red-700" : "bg-zinc-50 border-zinc-200 text-zinc-700 hover:bg-zinc-100"
                  }`}
                >
                  {micMuted ? "🔇 Unmute Mic" : "🎙️ Mute Mic"}
                </button>
                <button
                  onClick={toggleCamera}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all ${
                    cameraOff ? "bg-red-50 border-red-200 text-red-700" : "bg-zinc-50 border-zinc-200 text-zinc-700 hover:bg-zinc-100"
                  }`}
                >
                  {cameraOff ? "Turn Camera On" : "Turn Camera Off"}
                </button>
                <button
                  onClick={toggleScreenShare}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all ${
                    screenTrack
                      ? "bg-blue-50 border-blue-200 text-blue-700"
                      : "bg-zinc-50 border-zinc-200 text-zinc-700 hover:bg-zinc-100"
                  }`}
                  title="Shares your own screen with the candidate"
                >
                  {screenTrack ? "🖥️ Sharing — Stop" : "🖥️ Share My Screen"}
                </button>
                <button
                  onClick={requestMute}
                  className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-zinc-50 border border-zinc-200 hover:bg-zinc-100 text-zinc-700 transition-all"
                >
                  {muteRequestSent ? "✓ Request Sent" : "Ask Candidate to Mute"}
                </button>
                <button
                  onClick={requestScreenShare}
                  className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-zinc-50 border border-zinc-200 hover:bg-zinc-100 text-zinc-700 transition-all"
                  title="Prompts the candidate to share their screen — they choose what to share"
                >
                  {screenShareRequestSent ? "✓ Request Sent" : "🖥️ Ask to Share Screen"}
                </button>
                <button
                  onClick={toggleFullscreen}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all ${
                    isFullscreenOn ? "bg-blue-50 border-blue-200 text-blue-700" : "bg-zinc-50 border-zinc-200 text-zinc-700 hover:bg-zinc-100"
                  }`}
                >
                  {isFullscreenOn ? "⛶ Exit Fullscreen" : "⛶ Fullscreen"}
                </button>
              </div>

              <div className="flex items-center gap-2">
                {recording ? (
                  <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-purple-50 border border-purple-200 text-purple-700 text-xs font-medium">
                    <span className="w-2 h-2 rounded-full bg-purple-600 animate-pulse" />
                    Recording Live
                  </span>
                ) : (
                  <button
                    // Wrapped, not passed by reference: startRecording's first parameter is
                    // now the device prefs, and React would hand it the click event —
                    // whose micEnabled is undefined, which would restart the recorder muted.
                    onClick={() => startRecording()}
                    className="px-3 py-1.5 rounded-lg bg-purple-600 hover:bg-purple-700 text-white text-xs font-bold shadow-2xs"
                  >
                    Start Audio Record
                  </button>
                )}
                <button
                  onClick={() => endCall()}
                  className="px-3.5 py-1.5 rounded-lg bg-red-600 hover:bg-red-700 text-white text-xs font-bold shadow-2xs"
                >
                  End Call
                </button>
              </div>
            </div>
            )}

            {micError && !callEnded && (
              <p className="text-xs text-red-600 bg-red-50 p-2 rounded border border-red-200">{micError}</p>
            )}
            {recordingWarning && !callEnded && (
              <p className="text-xs text-amber-700 bg-amber-50 p-2 rounded border border-amber-200">
                {recordingWarning}
              </p>
            )}
          </div>

          {/* Right Column: AI Intelligence & Live Telemetry Tabs */}
          <div className="lg:col-span-5 flex flex-col gap-3">
            {/* Tab Navigation */}
            <div className="flex bg-zinc-100 border border-zinc-200 rounded-xl p-1 gap-1">
              <button
                onClick={() => setActiveTab("questions")}
                className={`flex-1 py-1.5 text-xs font-semibold rounded-lg transition-all ${
                  activeTab === "questions" ? "bg-surface text-blue-700 shadow-xs border border-zinc-200/60" : "text-zinc-600 hover:text-zinc-900"
                }`}
              >
                🤖 AI Questions ({suggestedQuestions.length})
              </button>
              <button
                onClick={() => setActiveTab("transcript")}
                className={`flex-1 py-1.5 text-xs font-semibold rounded-lg transition-all ${
                  activeTab === "transcript" ? "bg-surface text-blue-700 shadow-xs border border-zinc-200/60" : "text-zinc-600 hover:text-zinc-900"
                }`}
              >
                🎙️ Live Transcript
              </button>
              <button
                onClick={() => setActiveTab("sentiment")}
                className={`flex-1 py-1.5 text-xs font-semibold rounded-lg transition-all ${
                  activeTab === "sentiment" ? "bg-surface text-blue-700 shadow-xs border border-zinc-200/60" : "text-zinc-600 hover:text-zinc-900"
                }`}
              >
                🧠 Sentiment
              </button>
              <button
                onClick={() => setActiveTab("proctoring")}
                className={`flex-1 py-1.5 text-xs font-semibold rounded-lg transition-all ${
                  activeTab === "proctoring"
                    ? "bg-white text-blue-700 shadow-xs border border-zinc-200/60"
                    : criticalSignals.length > 0
                    ? "text-red-700 font-bold"
                    : "text-zinc-600 hover:text-zinc-900"
                }`}
              >
                🛡️ Signals ({liveSignals.length})
                {criticalSignals.length > 0 && (
                  <span className="ml-1 px-1.5 py-0.5 rounded-full bg-red-600 text-white text-[10px] font-bold align-middle">
                    {criticalSignals.length}
                  </span>
                )}
              </button>
              <button
                onClick={() => setActiveTab("evaluation")}
                className={`flex-1 py-1.5 text-xs font-semibold rounded-lg transition-all ${
                  activeTab === "evaluation" ? "bg-surface text-blue-700 shadow-xs border border-zinc-200/60" : "text-zinc-600 hover:text-zinc-900"
                }`}
              >
                📝 Notes
              </button>
            </div>

            {/* Tab Content */}
            <div className="flex-1">
              {/* Tab 0: AI-Suggested Questions Bank */}
              {activeTab === "questions" && (
                <div className="bg-surface border border-zinc-200 rounded-xl p-3.5 space-y-3 h-[450px] overflow-y-auto shadow-xs">
                  <div className="flex items-center justify-between border-b border-zinc-100 pb-2">
                    <h3 className="text-xs font-bold uppercase tracking-wider text-zinc-700">GPT-Suggested Question Bank</h3>
                    <button
                      type="button"
                      onClick={() => loadSuggestedQuestions(true)}
                      disabled={refreshingQuestions}
                      title="Generate a fresh set of suggested questions"
                      className="text-[10px] font-semibold px-2 py-1 rounded-md border border-zinc-200 text-zinc-600 hover:bg-zinc-100 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
                    >
                      {refreshingQuestions ? "Refreshing…" : "↻ Refresh"}
                    </button>
                  </div>

                  <div className="space-y-2">
                    {suggestedQuestions.map((q) => {
                      const isSelected = activeQuestion?.id === q.id;
                      const hasRating = ratedQuestions.find((r) => r.question_id === q.id);
                      return (
                        <div
                          key={q.id}
                          className={`p-3 rounded-xl border text-xs transition-all ${
                            isSelected
                              ? "bg-blue-50/70 border-blue-500 ring-1 ring-blue-500/50 shadow-xs"
                              : "bg-surface border-zinc-200 hover:border-zinc-300"
                          }`}
                        >
                          <div className="flex items-center justify-between mb-1.5">
                            <span className="font-semibold text-[10px] uppercase px-2 py-0.5 rounded-full bg-zinc-100 text-zinc-700">
                              {q.category} · {q.difficulty}
                            </span>
                            {hasRating && (
                              <span
                                className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                                  hasRating.rating === "strong_pass"
                                    ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                                    : hasRating.rating === "needs_followup"
                                    ? "bg-amber-50 text-amber-700 border border-amber-200"
                                    : "bg-red-50 text-red-700 border border-red-200"
                                }`}
                              >
                                ✓ {hasRating.rating.replace("_", " ")}
                              </span>
                            )}
                          </div>
                          <p className="font-bold text-zinc-900 mb-1.5">{q.question}</p>
                          <p className="text-[11px] text-zinc-500 mb-2 italic">Context: {q.context_reason}</p>

                          <div className="flex items-center justify-between pt-1 border-t border-zinc-100">
                            <span className="text-[10px] text-zinc-500">
                              Key concepts: {q.expected_concepts.join(", ")}
                            </span>
                            <button
                              onClick={() => {
                                setActiveQuestion(q);
                                setActiveEvaluation(null);
                              }}
                              className={`px-3 py-1 rounded-lg text-[11px] font-bold transition-all ${
                                isSelected
                                  ? "bg-blue-600 text-white shadow-xs"
                                  : "bg-zinc-100 hover:bg-zinc-200 text-zinc-700"
                              }`}
                            >
                              {isSelected ? "Active Question" : "Ask Question"}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Tab 1: Live Transcription Stream */}
              {activeTab === "transcript" && (
                <div className="space-y-2">
                  <LiveTranscriptFeed
                    items={allTranscripts}
                    interviewerCapturing={interviewerCapturing}
                    interims={realtimeInterims}
                    className="h-[390px]"
                  />
                  {/* Quick Speech / Utterance Entry Bar */}
                  <div className="flex gap-1.5 bg-surface border border-zinc-200 rounded-xl p-1.5 shadow-xs">
                    <input
                      type="text"
                      placeholder="Type test candidate or interviewer utterance..."
                      value={manualUtterance}
                      onChange={(e) => setManualUtterance(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleSendManualUtterance("candidate");
                      }}
                      className="flex-1 bg-zinc-50 border border-zinc-200 rounded-lg px-2.5 py-1 text-xs text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus:border-blue-500"
                    />
                    <button
                      onClick={() => handleSendManualUtterance("candidate")}
                      className="px-2.5 py-1 bg-blue-600 hover:bg-blue-700 text-white text-[11px] font-bold rounded-lg shadow-2xs"
                    >
                      Post Candidate
                    </button>
                  </div>
                </div>
              )}

              {/* Tab 2: Live Sentiment & Emotional Affect */}
              {activeTab === "sentiment" && (
                <div className="bg-surface border border-zinc-200 rounded-xl p-4 space-y-3.5 h-[450px] overflow-y-auto shadow-xs">
                  <div className="flex items-center justify-between border-b border-zinc-100 pb-2">
                    <h3 className="text-xs font-bold uppercase tracking-wider text-zinc-700">Live Emotional & Voice Telemetry</h3>
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-50 border border-emerald-200 text-emerald-700 font-semibold">
                      Real-time AI
                    </span>
                  </div>

                  {!latestSentiment ? (
                    // Distinct from an actual "calm" reading below — samples are taken every
                    // 60s and take a moment to process, so without this the panel showed the
                    // exact same "Low / Calm & Composed" defaults whether that was a real AI
                    // reading or just no data yet, with no way to tell the two apart.
                    <div className="bg-zinc-50 border border-zinc-200 rounded-xl p-4 text-center space-y-1">
                      <p className="text-xs font-semibold text-zinc-500">
                        ⏳ Waiting for the first sentiment reading…
                      </p>
                      <p className="text-[11px] text-zinc-400">
                        Samples are taken every 60s and take a few seconds to process.
                      </p>
                    </div>
                  ) : (
                    <>
                      {/* Tension Level Meter */}
                      <div className="bg-zinc-50 border border-zinc-200 rounded-xl p-3 space-y-2">
                        <div className="flex justify-between text-xs">
                          <span className="text-zinc-600 font-medium">Candidate Emotional Tension:</span>
                          <span
                            className={`font-bold capitalize ${
                              latestSentiment.facial_affect?.tension_level === "high"
                                ? "text-red-600"
                                : latestSentiment.facial_affect?.tension_level === "medium"
                                ? "text-amber-600"
                                : "text-emerald-600"
                            }`}
                          >
                            {latestSentiment.facial_affect?.tension_level ?? "Low"}
                          </span>
                        </div>
                        <div className="w-full bg-zinc-200 rounded-full h-2.5 overflow-hidden flex">
                          <div className="bg-emerald-500 h-full w-1/3" />
                          <div className={`h-full w-1/3 ${latestSentiment.facial_affect?.tension_level === "medium" || latestSentiment.facial_affect?.tension_level === "high" ? "bg-amber-500" : "bg-zinc-300"}`} />
                          <div className={`h-full w-1/3 ${latestSentiment.facial_affect?.tension_level === "high" ? "bg-red-500 animate-pulse" : "bg-zinc-300"}`} />
                        </div>
                        <p className="text-[10px] text-zinc-400 text-right">
                          as of {formatOffset(latestSentiment.session_offset_ms)}
                        </p>
                      </div>

                      {/* Facial Affect */}
                      <div className="bg-zinc-50 border border-zinc-200 rounded-xl p-3 space-y-1">
                        <span className="text-[11px] uppercase font-bold text-zinc-500">Observable Facial Affect</span>
                        <p className="text-sm font-bold capitalize text-zinc-900">
                          {latestSentiment.facial_affect?.overall_affect ?? "Not detected"}
                        </p>
                        {latestSentiment.facial_affect?.notes && (
                          <p className="text-xs text-zinc-500 mt-1">{latestSentiment.facial_affect.notes}</p>
                        )}
                      </div>

                      {/* Voice Tone */}
                      <div className="bg-zinc-50 border border-zinc-200 rounded-xl p-3 space-y-1">
                        <span className="text-[11px] uppercase font-bold text-zinc-500">Voice Tone & Pitch</span>
                        <p className="text-sm font-bold capitalize text-zinc-900">
                          {latestSentiment.voice_tone?.overall_tone ?? "Not detected"}
                        </p>
                        {latestSentiment.voice_tone?.notes && (
                          <p className="text-xs text-zinc-500 mt-1">{latestSentiment.voice_tone.notes}</p>
                        )}
                      </div>
                    </>
                  )}

                  {/* Eye Tracking Telemetry State */}
                  <div className="bg-zinc-50 border border-zinc-200 rounded-xl p-3 space-y-1">
                    <span className="text-[11px] uppercase font-bold text-zinc-500">Candidate Eye & Gaze Motion</span>
                    <div className="flex items-center gap-2 mt-1">
                      <span className={`w-3 h-3 rounded-full ${GAZE_TONE[candidateGazeStatus].dot}`} />
                      <span className="text-xs font-semibold text-zinc-800">
                        {TELEMETRY_GAZE_LABEL[candidateGazeStatus]}
                      </span>
                    </div>
                  </div>
                </div>
              )}

              {/* Tab 3: Live Proctoring & Integrity */}
              {activeTab === "proctoring" && (
                <div className="bg-surface border border-zinc-200 rounded-xl p-4 space-y-3 h-[450px] flex flex-col shadow-xs">
                  <div className="flex items-center justify-between border-b border-zinc-100 pb-2">
                    <h3 className="text-xs font-bold uppercase tracking-wider text-zinc-700">Live Proctoring Signal Feed</h3>
                    <span className="text-[10px] text-zinc-500 font-mono">{liveSignals.length} events logged</span>
                  </div>

                  <div className="flex-1 overflow-y-auto space-y-2 pr-1">
                    {liveSignals.length === 0 ? (
                      <div className="flex flex-col items-center justify-center py-12 text-center text-zinc-400">
                        <p className="text-xs font-medium">✨ Clean session so far.</p>
                        <p className="text-[11px] text-zinc-400 mt-1">No proctoring anomalies or suspicious activities detected.</p>
                      </div>
                    ) : (
                      liveSignals.slice().reverse().map((s, i) => (
                        <div key={i} className="flex items-start justify-between bg-zinc-50 border border-zinc-200 rounded-xl p-2.5 text-xs">
                          <div>
                            <span className="font-bold text-zinc-800">{SIGNAL_LABELS[s.signal_type] || s.signal_type}</span>
                          </div>
                          <span className="text-[10px] text-zinc-500 font-mono">{formatOffset(s.session_offset_ms)}</span>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              )}

              {/* Tab 4: Evaluation & Live Read */}
              {activeTab === "evaluation" && (
                <div className="bg-surface border border-zinc-200 rounded-xl p-4 space-y-4 h-[450px] flex flex-col justify-between shadow-xs">
                  <div className="space-y-3">
                    <h3 className="text-xs font-bold uppercase tracking-wider text-zinc-700">Live Interviewer Decision</h3>
                    <p className="text-xs text-zinc-500">Record your evaluation in real time during the call:</p>

                    <div className="grid grid-cols-3 gap-2">
                      {DECISION_OPTIONS.map((opt) => (
                        <button
                          key={opt.value}
                          type="button"
                          onClick={() => submitDecision(opt.value)}
                          disabled={savingDecision}
                          className={`py-2.5 px-2 text-xs font-bold rounded-xl transition-all ${opt.className} ${
                            decision === opt.value ? "ring-2 ring-blue-600 scale-102" : "opacity-85 hover:opacity-100"
                          }`}
                        >
                          {decision === opt.value ? `✓ ${opt.label}` : opt.label}
                        </button>
                      ))}
                    </div>

                    <div className="space-y-1.5 pt-2">
                      <label className="text-xs font-bold text-zinc-700">Interviewer Notes & Impressions:</label>
                      <textarea
                        rows={6}
                        value={decisionNotes}
                        onChange={(e) => setDecisionNotes(e.target.value)}
                        onBlur={() => decision && submitDecision(decision)}
                        placeholder="Type candidate strengths, answers to core technical questions, red flags, or notes..."
                        className="w-full bg-zinc-50 border border-zinc-200 rounded-xl p-3 text-xs text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus:border-blue-500"
                      />
                    </div>
                  </div>

                  <button
                    onClick={() => decision && submitDecision(decision)}
                    disabled={savingDecision}
                    className="w-full py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-xs font-bold shadow-xs transition-all"
                  >
                    {savingDecision ? "Saving…" : "Save Evaluation Notes"}
                  </button>
                </div>
              )}
            </div>
          </div>
        </main>
        </>
      )}

      {/* Post-Meeting Consolidated Scorecard Modal */}
      {showScorecard && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4 z-50 overflow-y-auto">
          <div className="bg-surface border border-zinc-200 rounded-2xl max-w-3xl w-full p-6 shadow-2xl space-y-6 my-8">
            <div className="flex items-center justify-between border-b border-zinc-200 pb-3">
              <div>
                <h2 className="text-lg font-bold text-zinc-900 flex items-center gap-2">
                  📊 Consolidated Evaluation Scorecard
                </h2>
                <p className="text-xs text-zinc-500">
                  Candidate: {session.candidate_name}
                  {session.job_title ? ` · Role: ${session.job_title}` : ""}
                </p>
              </div>
              <button
                onClick={() => setShowScorecard(false)}
                className="text-zinc-400 hover:text-zinc-700 text-lg font-bold p-1"
              >
                ✕
              </button>
            </div>

            {/* Scorecard Summary Metrics — real values only; honest states when data is absent. */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-center">
              <div className="bg-zinc-50 border border-zinc-200 rounded-xl p-3">
                <span className="text-[11px] font-bold text-zinc-500 uppercase">Interview Score</span>
                {consolidatedReport?.interview_qa_score != null ? (
                  <>
                    <p className="text-xl font-extrabold text-blue-600 mt-0.5">
                      {Number(consolidatedReport.interview_qa_score).toFixed(0)}/100
                    </p>
                    <span className="text-[10px] text-zinc-400">
                      {Number(consolidatedReport.evaluated_questions_count ?? 0)} answer
                      {Number(consolidatedReport.evaluated_questions_count ?? 0) === 1 ? "" : "s"} scored
                    </span>
                  </>
                ) : (
                  <>
                    <p className="text-xl font-extrabold text-zinc-400 mt-0.5">—</p>
                    <span className="text-[10px] text-zinc-400">No answers evaluated</span>
                  </>
                )}
              </div>
              <div className="bg-zinc-50 border border-zinc-200 rounded-xl p-3">
                <span className="text-[11px] font-bold text-zinc-500 uppercase">AI Fit (Resume)</span>
                <p className={`text-xl font-extrabold mt-0.5 ${consolidatedReport?.fit_score != null ? "text-zinc-700" : "text-zinc-400"}`}>
                  {consolidatedReport?.fit_score != null ? `${Number(consolidatedReport.fit_score).toFixed(0)}/100` : "Not scored"}
                </p>
              </div>
              <div className="bg-zinc-50 border border-zinc-200 rounded-xl p-3">
                <span className="text-[11px] font-bold text-zinc-500 uppercase">Proctoring</span>
                <p className={`text-xl font-extrabold mt-0.5 ${consolidatedReport?.integrity_score != null ? "text-emerald-600" : "text-zinc-400"}`}>
                  {consolidatedReport?.integrity_score != null ? `${Number(consolidatedReport.integrity_score).toFixed(0)}/100` : "Pending"}
                </p>
              </div>
              <div className="bg-zinc-50 border border-zinc-200 rounded-xl p-3">
                <span className="text-[11px] font-bold text-zinc-500 uppercase">Interviewer Read</span>
                <p className={`text-xl font-extrabold capitalize mt-0.5 ${decision ? "text-purple-600" : "text-zinc-400"}`}>
                  {decision || "Pending"}
                </p>
              </div>
            </div>

            {/* Question Accuracy Scorecard */}
            {ratedQuestions.length > 0 && (
              <div className="bg-zinc-50 border border-zinc-200 rounded-xl p-4 space-y-2.5">
                <h4 className="text-xs font-bold text-zinc-700 uppercase">AI-Evaluated Question Scorecard</h4>
                <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
                  {ratedQuestions.map((rq, idx) => (
                    <div key={idx} className="p-2.5 rounded-lg bg-surface border border-zinc-200 text-xs flex items-start justify-between gap-3 shadow-2xs">
                      <div className="space-y-0.5">
                        <p className="font-bold text-zinc-900">{rq.question_text}</p>
                        {rq.concepts_covered?.length > 0 && (
                          <p className="text-[11px] text-emerald-700 font-medium">Covered: {rq.concepts_covered.join(", ")}</p>
                        )}
                      </div>
                      <div className="text-right shrink-0">
                        <span className="font-bold text-blue-600">
                          {rq.accuracy_score != null ? `${rq.accuracy_score.toFixed(0)}/100` : "—"}
                        </span>
                        <span className="block text-[10px] text-zinc-500 capitalize">{rq.rating.replace("_", " ")}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Interviewer Notes Review */}
            {decisionNotes && (
              <div className="bg-zinc-50 border border-zinc-200 rounded-xl p-3.5 space-y-1">
                <span className="text-[11px] font-bold text-zinc-500 uppercase">Interviewer Notes</span>
                <p className="text-xs text-zinc-800 whitespace-pre-wrap">{decisionNotes}</p>
              </div>
            )}

            {/* Actions: Send to Interviewer Email & Download PDF */}
            <div className="bg-zinc-50 border border-zinc-200 rounded-xl p-4 space-y-3">
              <h4 className="text-xs font-bold text-zinc-700 uppercase">Send Consolidated Report to Interviewer</h4>
              <div className="flex gap-2">
                <input
                  type="email"
                  placeholder="Enter interviewer email address (e.g. interviewer@company.com)"
                  value={emailRecipient}
                  onChange={(e) => setEmailRecipient(e.target.value)}
                  className="flex-1 bg-surface border border-zinc-200 rounded-lg px-3 py-2 text-xs text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus:border-blue-500"
                />
                <button
                  onClick={handleSendEmailReport}
                  disabled={sendingEmail || emailSent || !isValidEmail(emailRecipient)}
                  className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-zinc-200 disabled:text-zinc-400 disabled:cursor-not-allowed text-white font-bold text-xs rounded-lg shadow-xs transition-all"
                >
                  {sendingEmail ? "Sending…" : emailSent ? "✓ Email Dispatched" : "📧 Send Scorecard"}
                </button>
              </div>
              {emailRecipient.trim() && !isValidEmail(emailRecipient) && !emailSent && (
                <p className="text-xs text-red-600">Enter a valid email address (e.g. name@company.com).</p>
              )}
              {emailSent && (
                <p className="text-xs text-emerald-700 font-semibold">
                  ✓ Consolidated evaluation report and PDF summary dispatched to interviewer!
                </p>
              )}
            </div>

            {/* Action Bar */}
            <div className="flex items-center justify-between pt-2 gap-2">
              <a
                href={`${BASE_URL}/interviews/${session.id}/consolidated-report/pdf`}
                target="_blank"
                rel="noreferrer"
                className="px-4 py-2 bg-zinc-100 hover:bg-zinc-200 text-zinc-700 font-semibold text-xs rounded-lg border border-zinc-200 flex items-center gap-1.5 shadow-2xs"
              >
                📄 Download PDF Evaluation Report
              </a>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setShowScorecard(false)}
                  className="px-5 py-2 bg-zinc-100 hover:bg-zinc-200 text-zinc-700 font-bold text-xs rounded-lg shadow-2xs"
                >
                  Close
                </button>
                <span className="text-xs font-semibold text-emerald-700 self-center max-w-[260px] text-right">
                  ✓ All done — this evaluation is saved. You can close this tab when finished.
                </span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
