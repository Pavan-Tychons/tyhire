"use client";

import { useEffect, useRef, useState } from "react";
import { BASE_URL } from "@/lib/api";
import type { LiveTranscriptItem } from "@/lib/useLiveSpeech";

/**
 * Route A — instant live transcription over a WebSocket.
 *
 * Streams this side's microphone as PCM16/24k to the backend relay
 * (`/interviews/{id}/ws/transcribe`), which forwards it to OpenAI's realtime transcription and
 * pushes text back word-by-word. The interviewer side receives BOTH speakers' events (so its panel
 * shows the merged transcript); the candidate side is upload-only.
 *
 * Replaces the ~12s chunk-upload + 2.5s poll path (`useLiveSpeech`) when it can. If the backend
 * has the feature flag off, can't reach the realtime model, or the socket errors, it reports
 * `fellBack: true` and the caller re-enables the chunk pipeline + poll — so nothing regresses.
 *
 * No client-side VAD or commit: `gpt-live-transcribe` streams continuously and the backend
 * finalizes a turn on a silence gap (see api/v1/live_transcribe.py).
 */

export type Speaker = "candidate" | "interviewer";

export interface RealtimeInterims {
  candidate: string;
  interviewer: string;
}

interface UseRealtimeTranscribeArgs {
  sessionId?: string;
  role: Speaker;
  enabled: boolean;
  /** Candidate `join_token` or interviewer `interviewer_join_token` (sent as a query param — WS
   * handshakes can't carry custom headers). */
  token?: string;
  /** Anchor for the displayed offset on finalized lines (the caller's call-start timestamp). */
  startedAtMs?: number;
  /** Interviewer only: fires when a candidate turn is finalized, with the answer text — used to run
   * answer evaluation / follow-up generation instantly instead of on the poll debounce. */
  onCandidateTurn?: (text: string) => void;
}

function toWsUrl(path: string): string {
  // BASE_URL is like "http://host:8000/api/v1" → "ws://host:8000/api/v1".
  return `${BASE_URL.replace(/^http/, "ws")}${path}`;
}

export function useRealtimeTranscribe({
  sessionId,
  role,
  enabled,
  token,
  startedAtMs,
  onCandidateTurn,
}: UseRealtimeTranscribeArgs): {
  finals: LiveTranscriptItem[];
  interims: RealtimeInterims;
  streaming: boolean;
  fellBack: boolean;
} {
  const [finals, setFinals] = useState<LiveTranscriptItem[]>([]);
  const [interims, setInterims] = useState<RealtimeInterims>({ candidate: "", interviewer: "" });
  const [streaming, setStreaming] = useState(false);
  const [fellBack, setFellBack] = useState(false);

  // Keep the callback current without re-opening the socket when the caller re-renders.
  const onCandidateTurnRef = useRef(onCandidateTurn);
  useEffect(() => {
    onCandidateTurnRef.current = onCandidateTurn;
  }, [onCandidateTurn]);

  useEffect(() => {
    if (!enabled || !sessionId || !token) return;

    let cancelled = false;
    let ws: WebSocket | null = null;
    let stream: MediaStream | null = null;
    let audioCtx: AudioContext | null = null;
    let workletNode: AudioWorkletNode | null = null;
    let sourceNode: MediaStreamAudioSourceNode | null = null;

    const markFallback = () => {
      if (cancelled) return;
      setFellBack(true);
      setStreaming(false);
    };

    async function startAudio(socket: WebSocket) {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            channelCount: 1,
          },
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        // Ask for a 24kHz context; the worklet also downsamples from the actual rate, so this is
        // correct whether or not the browser honors the request.
        const Ctx =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        audioCtx = new Ctx({ sampleRate: 24000 });
        await audioCtx.audioWorklet.addModule("/worklets/pcm-downsampler.js");
        if (cancelled) return;
        sourceNode = audioCtx.createMediaStreamSource(stream);
        workletNode = new AudioWorkletNode(audioCtx, "pcm-downsampler");
        workletNode.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
          if (socket.readyState === WebSocket.OPEN) socket.send(e.data);
        };
        sourceNode.connect(workletNode);
        // Not connected to destination — we don't want to echo the mic to the speakers.
        if (!cancelled) setStreaming(true);
      } catch {
        // Mic unavailable/denied for this capture: transcription for this side just won't
        // populate (same outcome the chunk path would have). Not treated as a fallback.
      }
    }

    try {
      ws = new WebSocket(
        toWsUrl(`/interviews/${sessionId}/ws/transcribe?token=${encodeURIComponent(token)}&role=${role}`)
      );
    } catch {
      markFallback();
      return;
    }
    ws.binaryType = "arraybuffer";

    ws.onopen = () => {
      if (cancelled || !ws) return;
      void startAudio(ws);
    };

    ws.onmessage = (event) => {
      if (cancelled || typeof event.data !== "string") return;
      let msg: { type?: string; speaker?: Speaker; text?: string };
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.type === "fallback") {
        markFallback();
        return;
      }
      if (msg.type === "delta" && msg.speaker) {
        const speaker = msg.speaker;
        const text = msg.text ?? "";
        setInterims((prev) => ({ ...prev, [speaker]: text }));
      } else if (msg.type === "final" && msg.speaker) {
        const speaker = msg.speaker;
        const text = (msg.text ?? "").trim();
        setInterims((prev) => ({ ...prev, [speaker]: "" }));
        if (text) {
          setFinals((prev) => [
            ...prev,
            {
              id: `rt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              speaker,
              text,
              offsetMs: startedAtMs ? Date.now() - startedAtMs : 0,
              timestamp: new Date().toISOString(),
            },
          ]);
        }
      } else if (msg.type === "candidate_turn") {
        const text = (msg.text ?? "").trim();
        if (text) onCandidateTurnRef.current?.(text);
      }
    };

    // An error, or a close we didn't initiate, means the realtime path isn't working — fall back.
    ws.onerror = () => markFallback();
    ws.onclose = () => {
      if (!cancelled) markFallback();
    };

    return () => {
      cancelled = true;
      setStreaming(false);
      try {
        workletNode?.port.close();
        workletNode?.disconnect();
        sourceNode?.disconnect();
      } catch {
        /* best-effort teardown */
      }
      void audioCtx?.close().catch(() => {});
      stream?.getTracks().forEach((t) => t.stop());
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        try {
          ws.onclose = null; // our own teardown must not trip the fallback
          ws.close();
        } catch {
          /* ignore */
        }
      }
    };
  }, [enabled, sessionId, role, token, startedAtMs]);

  return { finals, interims, streaming, fellBack };
}
