"use client";

import { useEffect, useRef, useState } from "react";
import {
  createEyeGazeTracker,
  type EyeGazeTrackingResult,
  type GazeStatus,
} from "@/lib/eyeGazeTracker";

interface EyeTrackingOverlayProps {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  mirrored?: boolean;
  objectFit?: "contain" | "cover";
  /** `status` is the specific finding — "looking_down" is the one worth acting on, and it
   * is lost if the caller only looks at the boolean. */
  onGazeChange?: (isFocused: boolean, isTeleprompter?: boolean, status?: GazeStatus) => void;
  showHudBadge?: boolean;
}

export default function EyeTrackingOverlay({
  videoRef,
  onGazeChange,
  showHudBadge = false,
}: EyeTrackingOverlayProps) {
  const [gazeState, setGazeState] = useState<EyeGazeTrackingResult | null>(null);

  // The callback is read through a ref so it stays out of the effect's dependencies.
  //
  // This is not a micro-optimisation, it was the bug: onGazeChange arrives as a fresh
  // closure on every render of the parent, and the interviewer page re-renders once a
  // second from its own elapsed-time timer. With it in the deps the effect tore down and
  // rebuilt on that cadence, and the tracker — created inside it — went with it. Every
  // rebuild starts a new stabiliser needing 4 consecutive samples at 150ms, and a new
  // 4-second iris history for the teleprompter sweep. Neither could ever reach its
  // threshold, so the gaze state sat on "focused" no matter where the candidate looked.
  const onGazeChangeRef = useRef(onGazeChange);
  // Updated in an effect rather than during render: a ref write during render is a lint
  // error and, under concurrent rendering, a render that React discards would still have
  // mutated it. Landing one commit later costs nothing here — the value is only read from
  // a timer callback, never during the render that sets it.
  useEffect(() => {
    onGazeChangeRef.current = onGazeChange;
  }, [onGazeChange]);

  useEffect(() => {
    const tracker = createEyeGazeTracker();
    let isCancelled = false;
    let animFrame: number;
    let lastTrackTime = 0;
    const TRACK_INTERVAL_MS = 150;

    async function loop(time: number) {
      if (isCancelled) return;

      const video = videoRef.current;
      if (video && video.readyState >= 2 && video.videoWidth > 0) {
        if (time - lastTrackTime >= TRACK_INTERVAL_MS) {
          lastTrackTime = time;
          try {
            const result = await tracker(video);
            if (!isCancelled && result) {
              setGazeState(result);
              // Exposed for live diagnosis: `__gaze` in the browser console shows exactly
              // what the detector is seeing right now — which axis is deviating and by how
              // much, and whether the model's eye blendshapes are arriving at all. Reading
              // those numbers beats guessing at thresholds from the outside.
              (window as unknown as { __gaze?: unknown }).__gaze = result;
              onGazeChangeRef.current?.(
                result.isLookingAtCamera,
                result.teleprompterReading,
                result.gazeStatus
              );
            }
          } catch {
            // Ignore frame blips
          }
        }
      }

      animFrame = requestAnimationFrame(loop);
    }

    animFrame = requestAnimationFrame(loop);

    return () => {
      isCancelled = true;
      cancelAnimationFrame(animFrame);
    };
    // videoRef alone: a ref object is stable for the component's life, so this now runs
    // exactly once and the tracker lives as long as the call does.
  }, [videoRef]);

  if (!showHudBadge || !gazeState || !gazeState.faceDetected) return null;

  const tone = GAZE_TONE[gazeState.gazeStatus];

  return (
    <div className="absolute top-2 left-2 pointer-events-none flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold backdrop-blur-md bg-white/95 shadow-md border border-zinc-200 transition-all duration-300 z-10">
      <span className={`w-2.5 h-2.5 rounded-full ${tone.dot}`} />
      <span className={tone.text}>{gazeState.gazeLabel}</span>
    </div>
  );
}

/** One place deciding how each finding reads, so the badge here, the border in WebRTCRoom
 * and the header pill on the interviewer page cannot drift apart and describe the same
 * moment three different ways. */
export const GAZE_TONE: Record<GazeStatus, { dot: string; text: string }> = {
  focused: {
    dot: "bg-emerald-500 shadow-[0_0_6px_#10b981]",
    text: "text-emerald-700",
  },
  // Red, like a head turned away. Eyes held below the screen is the case this feature was
  // built for, so it gets the colour that reads as "look at the candidate now" — the label
  // beside it still says which of the two it is. (The softer treatment stays where it does
  // not cost visibility: this never flags a session on its own, see LOW_SIGNAL_ALONE in
  // backend/app/services/integrity.py.)
  looking_down: {
    dot: "bg-red-500 animate-pulse shadow-[0_0_6px_#ef4444]",
    text: "text-red-600 font-bold",
  },
  // Amber, not red. Glancing up while thinking is close to a universal human tell and means
  // nothing about malpractice; drawing it as an alarm would have the border red for most of
  // every interview, which is how a reviewer learns to ignore it.
  looking_up: {
    dot: "bg-amber-500",
    text: "text-amber-700 font-semibold",
  },
  turned_away: {
    dot: "bg-red-500 animate-pulse shadow-[0_0_6px_#ef4444]",
    text: "text-red-600 font-bold",
  },
  teleprompter_reading: {
    dot: "bg-purple-600 animate-pulse shadow-[0_0_8px_#9333ea]",
    text: "text-purple-700 font-bold",
  },
  no_face: {
    dot: "bg-zinc-400",
    text: "text-zinc-600",
  },
};
