"use client";

import { useEffect, useRef } from "react";
import type { LiveTranscriptItem } from "@/lib/useLiveSpeech";

interface LiveTranscriptFeedProps {
  items: LiveTranscriptItem[];
  /** True while the interviewer's own next chunk is actively being recorded — there's no
   * live partial transcript text to show anymore (see useLiveSpeech), just a status. */
  interviewerCapturing?: boolean;
  className?: string;
}

function formatOffset(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export default function LiveTranscriptFeed({
  items,
  interviewerCapturing = false,
  className = "",
}: LiveTranscriptFeedProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const hasInterim = Boolean(interims.candidate || interims.interviewer);

  useEffect(() => {
    // TYH-017: scroll ONLY this transcript panel, never the page. The previous
    // bottomRef.scrollIntoView() scrolled the nearest scrollable ancestor — i.e. the whole
    // interviewer Command Center page — up on every incoming line. Setting scrollTop on the
    // panel's own container keeps the rest of the page fixed.
    const el = scrollRef.current;
    if (!el) return;
    // Only auto-follow when the viewer is already at/near the bottom, so scrolling up to
    // re-read earlier dialogue isn't yanked back down the moment the next chunk arrives.
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (nearBottom) {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    }
  }, [items, interviewerCapturing, interims.candidate, interims.interviewer]);

  return (
    <div className={`flex flex-col bg-surface border border-zinc-200 rounded-xl p-3.5 text-sm text-zinc-900 shadow-sm ${className}`}>
      <div className="flex items-center justify-between pb-2 mb-2 border-b border-zinc-200">
        <div className="flex items-center gap-2">
          <span className="relative flex h-2.5 w-2.5">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
            <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500"></span>
          </span>
          <h3 className="text-xs font-bold uppercase tracking-wider text-zinc-700">Live Transcription Stream</h3>
        </div>
        <span className="text-[11px] text-zinc-400 font-mono">Real-time STT</span>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto space-y-2.5 max-h-[360px] pr-1">
        {items.length === 0 && !interviewerCapturing && !hasInterim ? (
          <div className="flex flex-col items-center justify-center py-12 text-center text-zinc-400">
            <p className="text-xs font-medium">🎙️ Listening to conversation…</p>
            <p className="text-[11px] text-zinc-400 mt-1">
              Spoken candidate and interviewer dialogue appears here — each side is
              transcribed in short chunks, so expect a few seconds of delay.
            </p>
          </div>
        ) : (
          items.map((item) => (
            <div
              key={item.id}
              className={`p-2.5 rounded-xl text-xs border transition-all ${
                item.speaker === "candidate"
                  ? "bg-blue-50/80 border-blue-200 text-blue-950"
                  : "bg-purple-50/80 border-purple-200 text-purple-950"
              }`}
            >
              <div className="flex items-center justify-between mb-1">
                <span
                  className={`font-bold uppercase text-[10px] px-2 py-0.5 rounded-full ${
                    item.speaker === "candidate"
                      ? "bg-blue-600 text-white"
                      : "bg-purple-600 text-white"
                  }`}
                >
                  {item.speaker === "candidate" ? "Candidate" : "Interviewer"}
                </span>
                <span className="text-[10px] text-zinc-400 font-mono">{formatOffset(item.offsetMs)}</span>
              </div>
              <p className="leading-relaxed whitespace-pre-wrap font-medium">{item.text}</p>
            </div>
          ))
        )}

        {interviewerCapturing && (
          <div className="p-2 rounded-xl text-xs bg-purple-50/50 border border-purple-300 text-purple-900 animate-pulse flex items-center gap-1.5">
            <span className="font-bold uppercase text-[10px] px-2 py-0.5 rounded-full bg-purple-600 text-white">
              You
            </span>
            <span className="italic font-medium">Recording…</span>
          </div>
        )}
      </div>
    </div>
  );
}
