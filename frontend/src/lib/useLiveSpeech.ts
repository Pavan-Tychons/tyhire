"use client";

import { useEffect, useState } from "react";
import { postForm } from "@/lib/api";

export interface LiveTranscriptItem {
  id: string;
  speaker: "candidate" | "interviewer";
  text: string;
  offsetMs: number;
  timestamp: string;
  isInterim?: boolean;
}

// Longer chunks transcribe substantially more accurately: the model gets whole sentences
// with their surrounding context instead of fragments, and there are half as many chunk
// boundaries to mangle words across. The cost is latency, which this panel can afford — it
// was never word-by-word live captioning.
const CHUNK_DURATION_MS = 12000;
// Blobs smaller than this hold no real audio (a recorder stopped almost immediately after
// starting, e.g. during teardown) and only ever transcribe to noise.
const MIN_CHUNK_BYTES = 2000;

/** The recording container to ask for, in preference order. Safari implements MediaRecorder
 * but has never supported webm — it records mp4/AAC — so hard-coding audio/webm made the
 * live transcript silently dead there. The chosen type also decides the filename extension
 * sent to the server, since the transcription API infers the format from it. */
function pickMimeType(): { mimeType?: string; extension: string } {
  const candidates: { mimeType: string; extension: string }[] = [
    { mimeType: "audio/webm;codecs=opus", extension: "webm" },
    { mimeType: "audio/webm", extension: "webm" },
    { mimeType: "audio/mp4", extension: "mp4" },
    { mimeType: "audio/ogg;codecs=opus", extension: "ogg" },
  ];
  for (const candidate of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(candidate.mimeType)) {
      return candidate;
    }
  }
  // Let the browser pick its own default rather than refusing to record at all.
  return { extension: "webm" };
}

/**
 * Records short, independent audio chunks and uploads each to the backend for server-side
 * transcription (see live-transcript-chunk / interviewer-live-transcript-chunk in
 * interviews.py) — a browser-agnostic replacement for the browser's own SpeechRecognition
 * API, which only ever existed in Chromium browsers and was known to silently stop or drop
 * results even there. Trades true word-by-word captions for a few seconds of latency
 * (chunk length + upload + transcription) in exchange for working identically everywhere
 * MediaRecorder does — which is every modern browser.
 *
 * Requests its own microphone stream independently of whatever else on the page is already
 * capturing audio (the main interview recording, WebRTC) — getUserMedia supports multiple
 * concurrent captures from the same device fine, and keeping this self-contained means it
 * doesn't need to know about or share state with those other, unrelated capture paths.
 */
export function useLiveSpeech({
  sessionId,
  speaker,
  enabled,
  startedAtMs,
  authToken,
  tokenHeaderKey,
}: {
  sessionId?: string;
  speaker: "candidate" | "interviewer";
  enabled: boolean;
  startedAtMs?: number;
  authToken?: string;
  tokenHeaderKey?: string;
}) {
  const [liveItems, setLiveItems] = useState<LiveTranscriptItem[]>([]);
  const [isCapturing, setIsCapturing] = useState(false);

  useEffect(() => {
    if (!enabled || !sessionId) return;

    let cancelled = false;
    let stream: MediaStream | null = null;
    let rotateTimer: ReturnType<typeof setTimeout> | undefined;
    const active = new Set<MediaRecorder>();
    const { mimeType, extension } = pickMimeType();

    const endpoint =
      speaker === "interviewer"
        ? `/interviews/${sessionId}/interviewer-live-transcript-chunk`
        : `/interviews/${sessionId}/live-transcript-chunk`;
    const headers = authToken && tokenHeaderKey ? { [tokenHeaderKey]: authToken } : undefined;

    function uploadChunk(blob: Blob, offsetMs: number) {
      if (blob.size < MIN_CHUNK_BYTES) return;
      const form = new FormData();
      form.append("clip", blob, `chunk.${extension}`);
      form.append("session_offset_ms", String(offsetMs));
      // Best-effort — a dropped chunk just doesn't appear live, same as a missed browser
      // SpeechRecognition result would have. The final post-call transcript (from the main
      // recording) is unaffected either way.
      postForm(endpoint, form, headers).catch(() => {});
    }

    function startChunk() {
      if (cancelled || !stream) return;
      const chunkOffsetMs = startedAtMs ? Date.now() - startedAtMs : 0;
      const chunks: Blob[] = [];

      let recorder: MediaRecorder;
      try {
        recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      } catch {
        return;
      }
      active.add(recorder);
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };
      recorder.onstop = () => {
        active.delete(recorder);
        if (active.size === 0) setIsCapturing(false);
        uploadChunk(new Blob(chunks, { type: recorder.mimeType || mimeType }), chunkOffsetMs);
      };
      recorder.start();
      setIsCapturing(true);

      rotateTimer = setTimeout(() => {
        // The replacement starts BEFORE this one stops. Stopping first and starting after
        // (even a few hundred ms later) drops whatever is said in between, every chunk, for
        // the whole call — and because the cut lands mid-word, it also corrupts the words on
        // either side of it. Overlapping by a few ms costs at most a duplicated syllable.
        startChunk();
        if (recorder.state !== "inactive") recorder.stop();
      }, CHUNK_DURATION_MS);
    }

    navigator.mediaDevices
      .getUserMedia({
        // Requested explicitly rather than left to per-browser defaults: this is a second,
        // independent capture of the same mic that is simultaneously playing the other
        // participant's voice out of the speakers. Without echo cancellation that voice
        // bleeds into this stream and gets transcribed under THIS speaker's label, which is
        // what makes the two columns read as if both people said everything.
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      })
      .then((s) => {
        if (cancelled) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        stream = s;
        startChunk();
      })
      .catch(() => {
        // No mic access for this capture — the live transcript for this speaker just won't
        // populate. Every other feature (main recording, signals) requests its own mic
        // access separately and isn't affected by this failing.
      });

    return () => {
      cancelled = true;
      clearTimeout(rotateTimer);
      active.forEach((recorder) => {
        if (recorder.state !== "inactive") recorder.stop();
      });
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [enabled, sessionId, speaker, startedAtMs, authToken, tokenHeaderKey]);

  return { liveItems, isCapturing, setLiveItems };
}
