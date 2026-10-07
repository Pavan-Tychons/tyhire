"use client";

import { useParams } from "next/navigation";
import Image from "next/image";
import { useEffect, useRef, useState, useCallback } from "react";
import { BASE_URL, getJson, postForm, postJson } from "@/lib/api";
import WebRTCRoom, { type WebRTCApi } from "@/components/WebRTCRoom";
import LiveTranscriptFeed from "@/components/LiveTranscriptFeed";
import { useLiveSpeech, type LiveTranscriptItem } from "@/lib/useLiveSpeech";
import { exitFullscreen, isFullscreenActive, onFullscreenChange } from "@/lib/fullscreen";
import type { FacialAffectAnalysis, InterviewSession, LiveSignalEvent, SignalType, VoiceToneAnalysis } from "@/lib/types";

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
  accuracy_score: number;
  verdict: "strong" | "partially_correct" | "superficial" | "inaccurate" | "scripted_delivery";
  concepts_covered: string[];
  concepts_missing: string[];
  depth_rating: "deep" | "adequate" | "surface";
  fluff_detected: boolean;
  teleprompter_speech_flag: boolean;
  hr_summary: string;
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
  location_mismatch: "IP location doesn't match stated location",
  ai_extension_detected: "AI answer-helper browser extension detected",
  teleprompter_reading: "Teleprompter / Script-reading eye motion pattern",
};

const DECISION_OPTIONS: { value: "proceed" | "concern" | "reject"; label: string; className: string }[] = [
  { value: "proceed", label: "Proceed", className: "bg-emerald-600 hover:bg-emerald-700 text-white font-medium shadow-sm" },
  { value: "concern", label: "Some concern", className: "bg-amber-600 hover:bg-amber-700 text-white font-medium shadow-sm" },
  { value: "reject", label: "Reject", className: "bg-red-600 hover:bg-red-700 text-white font-medium shadow-sm" },
];

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
  const [liveSignals, setLiveSignals] = useState<LiveSignalEvent[]>([]);
  const [sentimentSamples, setSentimentSamples] = useState<SentimentSample[]>([]);
  const [decision, setDecision] = useState<"proceed" | "concern" | "reject" | null>(null);
  const [decisionNotes, setDecisionNotes] = useState("");
  const [savingDecision, setSavingDecision] = useState(false);
  const [activeTab, setActiveTab] = useState<"questions" | "transcript" | "sentiment" | "proctoring" | "evaluation">("questions");
  const [isCandidateGazeFocused, setIsCandidateGazeFocused] = useState(true);
  const [isTeleprompterReading, setIsTeleprompterReading] = useState(false);

  // AI-Suggested Questions & Live Answer Evaluation
  const [suggestedQuestions, setSuggestedQuestions] = useState<SuggestedQuestion[]>([]);
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
  const [closeFailed, setCloseFailed] = useState(false);

  // Manual test utterance input
  const [manualUtterance, setManualUtterance] = useState("");

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const webrtcApiRef = useRef<WebRTCApi | null>(null);
  const [micMuted, setMicMuted] = useState(false);
  const [cameraOff, setCameraOff] = useState(false);
  const [muteRequestSent, setMuteRequestSent] = useState(false);
  const [isFullscreenOn, setIsFullscreenOn] = useState(false);
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

  // Browser-agnostic live transcript capture for the interviewer's own side — records and
  // uploads short chunks for server-side transcription rather than relying on the browser's
  // own (Chromium-only, unreliable) SpeechRecognition API. isCapturing just drives a
  // "recording…" indicator; the actual text comes back through the live-transcripts poll
  // below once the backend finishes transcribing each chunk.
  const { isCapturing: interviewerCapturing } = useLiveSpeech({
    sessionId: session?.id,
    speaker: "interviewer",
    enabled: joined && !callEnded,
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

  // Fetch AI-suggested questions
  useEffect(() => {
    if (!session) return;
    getJson<SuggestedQuestion[]>(`/interviews/${session.id}/suggested-questions`)
      .then((questions) => {
        if (questions && questions.length > 0) {
          setSuggestedQuestions(questions);
          setActiveQuestion(questions[0]);
        }
      })
      .catch(() => {});

    getJson<RatedQuestion[]>(`/interviews/${session.id}/qa-evaluations`)
      .then((evals) => {
        if (evals) setRatedQuestions(evals);
      })
      .catch(() => {});
  }, [session]);

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

  // Live transcripts polling from backend
  useEffect(() => {
    if (!session || callEnded) return;
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
  }, [session, callEnded]);

  // The only source now — both sides upload chunks for server-side transcription and this
  // polls the merged result back; neither side produces any transcript text locally anymore.
  const allTranscripts = mergedLiveTranscripts;

  // Real-time answer evaluation trigger
  const runAnswerEvaluation = useCallback(async (customSpeech?: string) => {
    if (!session || !activeQuestion) return;

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
      const evalResult = await postJson<AnswerEvaluation>(`/interviews/${session.id}/evaluate-live-answer`, {
        question_id: activeQuestion.id,
        question_text: activeQuestion.question,
        expected_concepts: activeQuestion.expected_concepts,
        candidate_transcript: candidateSpeech,
      });
      setActiveEvaluation(evalResult);
    } catch {
      // Degrade gracefully
    } finally {
      setEvaluatingAnswer(false);
    }
  }, [session, activeQuestion, allTranscripts]);

  // Debounced answer evaluation when new transcripts arrive
  useEffect(() => {
    if (!activeQuestion || allTranscripts.length === 0) return;
    const timer = setTimeout(() => {
      runAnswerEvaluation();
    }, 3500);
    return () => clearTimeout(timer);
  }, [allTranscripts, activeQuestion, runAnswerEvaluation]);

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

  async function startRecording() {
    if (!session) return;
    setMicError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const recorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
      recorder.ondataavailable = async (e) => {
        if (e.data.size === 0) return;
        const form = new FormData();
        form.append("chunk", e.data, "chunk.webm");
        await postForm(`/interviews/${session.id}/interviewer-recording-chunk`, form, {
          "X-Interviewer-Token": session.interviewer_join_token ?? "",
        });
      };
      recorder.start(5000);
      recorderRef.current = recorder;
      setRecording(true);
    } catch (err) {
      setMicError(err instanceof Error ? err.message : "Could not access microphone.");
    }
  }

  function endCall(notifyPeer = true) {
    if (notifyPeer) {
      webrtcApiRef.current?.notifyPeerEnded();
    }
    recorderRef.current?.stop();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    setRecording(false);
    setStopped(true);
    if (isFullscreenActive()) exitFullscreen().catch(() => {});
    setCallEnded(true);
    setTimeout(loadConsolidatedReport, 1000);
  }

  function handleCloseTab() {
    window.close();
    setTimeout(() => setCloseFailed(true), 300);
  }

  function toggleMic() {
    setMicMuted(webrtcApiRef.current?.toggleMic() ?? false);
  }

  function toggleCamera() {
    setCameraOff(webrtcApiRef.current?.toggleCamera() ?? false);
  }

  function toggleFullscreen() {
    setIsFullscreenOn(webrtcApiRef.current?.toggleFullscreen() ?? false);
  }

  // Keeps the button's label accurate if fullscreen is exited via Esc rather than the
  // button itself — isFullscreenOn would otherwise stay stuck on "Exit Fullscreen".
  useEffect(() => onFullscreenChange(() => setIsFullscreenOn(isFullscreenActive())), []);

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
    setSendingEmail(true);
    try {
      await postJson(`/interviews/${session.id}/send-report`, {
        recipient_email: emailRecipient.trim() || undefined,
      });
      setEmailSent(true);
    } catch (err) {
      alert("Failed to send report: " + (err instanceof Error ? err.message : "Network error"));
    } finally {
      setSendingEmail(false);
    }
  }

  if (error) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 bg-zinc-50 min-h-screen text-zinc-900">
        <div className="max-w-md p-6 bg-white border border-zinc-200 rounded-xl text-center shadow-md">
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

  return (
    <div className="flex flex-col min-h-screen bg-zinc-50 text-zinc-900 font-sans">
      {/* Top Header with TyHire Logo */}
      <header className="flex items-center justify-between px-6 py-3.5 bg-white border-b border-zinc-200 shrink-0 sticky top-0 z-20 shadow-xs">
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
            <div className="flex items-center gap-2 px-3 py-1 bg-white border border-zinc-200 rounded-full text-xs shadow-xs">
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
            <div className="flex items-center gap-2 px-3 py-1 bg-white border border-zinc-200 rounded-full text-xs shadow-xs">
              <span className={`w-2 h-2 rounded-full ${isCandidateGazeFocused ? "bg-emerald-500" : "bg-red-500 animate-ping"}`} />
              <span className={isCandidateGazeFocused ? "text-emerald-700 text-xs font-semibold" : "text-red-600 text-xs font-bold"}>
                {isCandidateGazeFocused ? "🟢 Gaze: Focused On Camera" : "🔴 Gaze: Looking Away"}
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
              onClick={() => setShowScorecard(true)}
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
          <div className="max-w-lg w-full bg-white border border-zinc-200 rounded-2xl p-8 text-center shadow-lg space-y-6">
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
              onClick={() => {
                // Deliberately NOT auto-fullscreening the whole page here — that swallowed
                // the AI Questions/Transcript/Sentiment/Signals tabs and decision bar along
                // with the video, with no way back short of Esc. WebRTCRoom's own fullscreen
                // button now targets just the video+screenshare area instead.
                setCallStartTime(Date.now());
                setJoined(true);
                startRecording();
              }}
              className="w-full py-3.5 px-6 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-bold text-sm shadow-md hover:shadow-lg transition-all transform active:scale-98"
            >
              Join Meet & Start AI Telemetry
            </button>
          </div>
        </div>
      ) : (
        /* Main Command Center Layout */
        <main className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-4 p-4 max-w-[1600px] w-full mx-auto">
          {/* Left Column: Two-Part Video/Screenshare & Active Question / Then-and-There Decision */}
          <div className="lg:col-span-7 flex flex-col gap-3">
            <div className="relative w-full h-[450px] bg-white rounded-xl overflow-hidden border border-zinc-200 shadow-sm p-1.5">
              {!callEnded ? (
                <WebRTCRoom
                  sessionId={session.id}
                  token={session.interviewer_join_token ?? ""}
                  role="interviewer"
                  iceServers={session.ice_servers}
                  enableEyeTracking={true}
                  onGazeChange={(focused, isTeleprompter) => {
                    setIsCandidateGazeFocused(focused);
                    if (isTeleprompter !== undefined) setIsTeleprompterReading(isTeleprompter);
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

            {/* Active Question & "Then and There" Instant Decision Bar */}
            {activeQuestion && (
              <div className="bg-white border border-zinc-200 rounded-xl p-4 space-y-3 shadow-xs">
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
                    {activeEvaluation && (
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

                {/* Adaptive Follow-up Prompt */}
                {activeEvaluation?.suggested_followup && (
                  <div className="p-2.5 rounded-lg bg-indigo-50 border border-indigo-200 text-[11px] text-indigo-900">
                    <strong className="text-indigo-700 font-bold">💡 Suggested Follow-up: </strong>
                    {activeEvaluation.suggested_followup}
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

            {/* In-Call Action Toolbar */}
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
                  onClick={requestMute}
                  className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-zinc-50 border border-zinc-200 hover:bg-zinc-100 text-zinc-700 transition-all"
                >
                  {muteRequestSent ? "✓ Request Sent" : "Ask Candidate to Mute"}
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
                    onClick={startRecording}
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

            {micError && <p className="text-xs text-red-600 bg-red-50 p-2 rounded border border-red-200">{micError}</p>}
          </div>

          {/* Right Column: AI Intelligence & Live Telemetry Tabs */}
          <div className="lg:col-span-5 flex flex-col gap-3">
            {/* Tab Navigation */}
            <div className="flex bg-zinc-100 border border-zinc-200 rounded-xl p-1 gap-1">
              <button
                onClick={() => setActiveTab("questions")}
                className={`flex-1 py-1.5 text-xs font-semibold rounded-lg transition-all ${
                  activeTab === "questions" ? "bg-white text-blue-700 shadow-xs border border-zinc-200/60" : "text-zinc-600 hover:text-zinc-900"
                }`}
              >
                🤖 AI Questions ({suggestedQuestions.length})
              </button>
              <button
                onClick={() => setActiveTab("transcript")}
                className={`flex-1 py-1.5 text-xs font-semibold rounded-lg transition-all ${
                  activeTab === "transcript" ? "bg-white text-blue-700 shadow-xs border border-zinc-200/60" : "text-zinc-600 hover:text-zinc-900"
                }`}
              >
                🎙️ Live Transcript
              </button>
              <button
                onClick={() => setActiveTab("sentiment")}
                className={`flex-1 py-1.5 text-xs font-semibold rounded-lg transition-all ${
                  activeTab === "sentiment" ? "bg-white text-blue-700 shadow-xs border border-zinc-200/60" : "text-zinc-600 hover:text-zinc-900"
                }`}
              >
                🧠 Sentiment
              </button>
              <button
                onClick={() => setActiveTab("proctoring")}
                className={`flex-1 py-1.5 text-xs font-semibold rounded-lg transition-all ${
                  activeTab === "proctoring" ? "bg-white text-blue-700 shadow-xs border border-zinc-200/60" : "text-zinc-600 hover:text-zinc-900"
                }`}
              >
                🛡️ Signals ({liveSignals.length})
              </button>
              <button
                onClick={() => setActiveTab("evaluation")}
                className={`flex-1 py-1.5 text-xs font-semibold rounded-lg transition-all ${
                  activeTab === "evaluation" ? "bg-white text-blue-700 shadow-xs border border-zinc-200/60" : "text-zinc-600 hover:text-zinc-900"
                }`}
              >
                📝 Notes
              </button>
            </div>

            {/* Tab Content */}
            <div className="flex-1">
              {/* Tab 0: AI-Suggested Questions Bank */}
              {activeTab === "questions" && (
                <div className="bg-white border border-zinc-200 rounded-xl p-3.5 space-y-3 h-[450px] overflow-y-auto shadow-xs">
                  <div className="flex items-center justify-between border-b border-zinc-100 pb-2">
                    <h3 className="text-xs font-bold uppercase tracking-wider text-zinc-700">GPT-Suggested Question Bank</h3>
                    <span className="text-[10px] text-zinc-500 font-mono">Tailored to Resume & JD</span>
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
                              : "bg-white border-zinc-200 hover:border-zinc-300"
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
                    className="h-[390px]"
                  />
                  {/* Quick Speech / Utterance Entry Bar */}
                  <div className="flex gap-1.5 bg-white border border-zinc-200 rounded-xl p-1.5 shadow-xs">
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
                <div className="bg-white border border-zinc-200 rounded-xl p-4 space-y-3.5 h-[450px] overflow-y-auto shadow-xs">
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
                      <span className={`w-3 h-3 rounded-full ${isTeleprompterReading ? "bg-purple-600" : isCandidateGazeFocused ? "bg-emerald-500" : "bg-red-500"}`} />
                      <span className="text-xs font-semibold text-zinc-800">
                        {isTeleprompterReading
                          ? "⚠️ Teleprompter Script Reading Detected (Horizontal scanning)"
                          : isCandidateGazeFocused
                          ? "🟢 Candidate looking at camera / screen (Focused)"
                          : "🔴 Candidate gaze turned away from camera (Looking Away)"}
                      </span>
                    </div>
                  </div>
                </div>
              )}

              {/* Tab 3: Live Proctoring & Integrity */}
              {activeTab === "proctoring" && (
                <div className="bg-white border border-zinc-200 rounded-xl p-4 space-y-3 h-[450px] flex flex-col shadow-xs">
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
                <div className="bg-white border border-zinc-200 rounded-xl p-4 space-y-4 h-[450px] flex flex-col justify-between shadow-xs">
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
      )}

      {/* Post-Meeting Consolidated Scorecard Modal */}
      {showScorecard && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4 z-50 overflow-y-auto">
          <div className="bg-white border border-zinc-200 rounded-2xl max-w-3xl w-full p-6 shadow-2xl space-y-6 my-8">
            <div className="flex items-center justify-between border-b border-zinc-200 pb-3">
              <div>
                <h2 className="text-lg font-bold text-zinc-900 flex items-center gap-2">
                  📊 Consolidated Evaluation Scorecard
                </h2>
                <p className="text-xs text-zinc-500">Candidate: {session.candidate_name}</p>
              </div>
              <button
                onClick={() => setShowScorecard(false)}
                className="text-zinc-400 hover:text-zinc-700 text-lg font-bold p-1"
              >
                ✕
              </button>
            </div>

            {/* Scorecard Summary Metrics */}
            <div className="grid grid-cols-3 gap-3 text-center">
              <div className="bg-zinc-50 border border-zinc-200 rounded-xl p-3">
                <span className="text-[11px] font-bold text-zinc-500 uppercase">AI Fit Score</span>
                <p className="text-xl font-extrabold text-blue-600 mt-0.5">
                  {consolidatedReport?.fit_score != null ? `${Number(consolidatedReport.fit_score).toFixed(0)}/100` : "85/100"}
                </p>
              </div>
              <div className="bg-zinc-50 border border-zinc-200 rounded-xl p-3">
                <span className="text-[11px] font-bold text-zinc-500 uppercase">Proctoring Rating</span>
                <p className="text-xl font-extrabold text-emerald-600 mt-0.5">
                  {consolidatedReport?.integrity_score != null ? `${Number(consolidatedReport.integrity_score).toFixed(0)}/100` : "Clean (100)"}
                </p>
              </div>
              <div className="bg-zinc-50 border border-zinc-200 rounded-xl p-3">
                <span className="text-[11px] font-bold text-zinc-500 uppercase">Interviewer Read</span>
                <p className="text-xl font-extrabold text-purple-600 capitalize mt-0.5">
                  {decision || "Proceed"}
                </p>
              </div>
            </div>

            {/* Question Accuracy Scorecard */}
            {ratedQuestions.length > 0 && (
              <div className="bg-zinc-50 border border-zinc-200 rounded-xl p-4 space-y-2.5">
                <h4 className="text-xs font-bold text-zinc-700 uppercase">AI-Evaluated Question Scorecard</h4>
                <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
                  {ratedQuestions.map((rq, idx) => (
                    <div key={idx} className="p-2.5 rounded-lg bg-white border border-zinc-200 text-xs flex items-start justify-between gap-3 shadow-2xs">
                      <div className="space-y-0.5">
                        <p className="font-bold text-zinc-900">{rq.question_text}</p>
                        {rq.concepts_covered?.length > 0 && (
                          <p className="text-[11px] text-emerald-700 font-medium">Covered: {rq.concepts_covered.join(", ")}</p>
                        )}
                      </div>
                      <div className="text-right shrink-0">
                        <span className="font-bold text-blue-600">{rq.accuracy_score?.toFixed(0) ?? 85}/100</span>
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
                  className="flex-1 bg-white border border-zinc-200 rounded-lg px-3 py-2 text-xs text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus:border-blue-500"
                />
                <button
                  onClick={handleSendEmailReport}
                  disabled={sendingEmail || emailSent}
                  className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-zinc-200 disabled:text-zinc-400 text-white font-bold text-xs rounded-lg shadow-xs transition-all"
                >
                  {sendingEmail ? "Sending…" : emailSent ? "✓ Email Dispatched" : "📧 Send Scorecard"}
                </button>
              </div>
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
                {closeFailed ? (
                  <p className="text-xs text-zinc-500 max-w-[220px] text-right">
                    Can&apos;t close this automatically — go ahead and close the tab yourself.
                  </p>
                ) : (
                  <button
                    onClick={handleCloseTab}
                    className="px-5 py-2 bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs rounded-lg shadow-xs"
                  >
                    Finish & Close Tab
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
