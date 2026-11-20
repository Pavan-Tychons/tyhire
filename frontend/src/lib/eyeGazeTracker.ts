import { FaceLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";
import {
  createGazeStabilizer,
  estimateGaze,
  type GazeDirection,
  type GazeEstimate,
} from "@/lib/gazeEstimation";

const WASM_PATH = "/wasm";
const MODEL_PATH = "/models/face_landmarker.task";

// MediaPipe's WASM runtime logs its own startup diagnostics (delegate selection, backend
// info) through console.error/console.info rather than stdout — harmless, but Next.js's dev
// overlay treats any console.error call as a crash and shows its red error screen for it.
// Filtering by this known-benign substring (rather than silencing console.error outright)
// keeps real errors from the tracker visible while dropping just this noise.
const BENIGN_MEDIAPIPE_LOG = /xnnpack|tensorflow lite|inference_feedback_manager/i;

if (typeof window !== "undefined" && !(window as unknown as { __mediapipeLogPatched?: boolean }).__mediapipeLogPatched) {
  (window as unknown as { __mediapipeLogPatched: boolean }).__mediapipeLogPatched = true;
  for (const method of ["error", "info", "warn", "log"] as const) {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]) => {
      if (typeof args[0] === "string" && BENIGN_MEDIAPIPE_LOG.test(args[0])) return;
      original(...args);
    };
  }
}

let landmarkerPromise: Promise<FaceLandmarker> | null = null;

export function getFaceLandmarker(): Promise<FaceLandmarker> {
  if (!landmarkerPromise) {
    landmarkerPromise = FilesetResolver.forVisionTasks(WASM_PATH).then((fileset) =>
      FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL_PATH, delegate: "CPU" },
        runningMode: "VIDEO",
        numFaces: 2,
        // The eye-direction channel. These are the model's own ARKit-style coefficients
        // (eyeLookIn/Out/Up/Down, eyeBlink) with head pose already factored out, which is
        // what makes eyeball direction separable from "the head turned". Without this flag
        // the estimator silently falls back to iris geometry — still eye-based, but less
        // reliable at the extremes. See lib/gazeEstimation.ts.
        outputFaceBlendshapes: true,
      })
    );
  }
  return landmarkerPromise;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type GazeStatus =
  | "focused"
  | "looking_down"
  | "looking_up"
  | "turned_away"
  | "teleprompter_reading"
  | "no_face";

export interface EyeGazeTrackingResult {
  faceDetected: boolean;
  faceCount: number;
  isLookingAtCamera: boolean;
  teleprompterReading: boolean;
  teleprompterConfidence: number;
  gazeStatus: GazeStatus;
  gazeLabel: string;
  /** Stabilised eye direction, for callers that want the raw finding rather than a label. */
  gazeDirection: GazeDirection;
  /** Null only when no face was found. Carries the per-frame numbers behind the verdict. */
  gaze: GazeEstimate | null;
  leftEyeBox: Box | null;
  rightEyeBox: Box | null;
  faceBox: Box | null;
  yawRatio: number;
  pitchRatio: number;
}

// MediaPipe 468 landmark indices
const NOSE_TIP = 1;
const RIGHT_EYE_INDICES = [33, 133, 158, 159, 160, 144, 145, 153];
const LEFT_EYE_INDICES = [263, 362, 385, 386, 387, 373, 374, 380];
const RIGHT_EYE_OUTER = 33;
const LEFT_EYE_OUTER = 263;
// The iris indices that used to live here now sit in lib/gazeEstimation.ts, paired with
// the eye each one actually belongs to.

function computeBox(
  landmarks: { x: number; y: number }[],
  indices: number[],
  padX = 0.025,
  padY = 0.025
): Box {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  for (const idx of indices) {
    const pt = landmarks[idx];
    if (!pt) continue;
    if (pt.x < minX) minX = pt.x;
    if (pt.x > maxX) maxX = pt.x;
    if (pt.y < minY) minY = pt.y;
    if (pt.y > maxY) maxY = pt.y;
  }

  const width = Math.max(0.012, maxX - minX + padX * 2);
  const height = Math.max(0.012, maxY - minY + padY * 2);
  const x = Math.max(0, minX - padX);
  const y = Math.max(0, minY - padY);

  return { x, y, width, height };
}

export function createEyeGazeTracker() {
  let busy = false;
  const irisHistory: { time: number; irisRatio: number; yaw: number }[] = [];
  // This one drives the interviewer's live HUD at a 150ms cadence (EyeTrackingOverlay), so
  // 4 samples is ~600ms to light up and ~450ms to clear — fast enough to be worth glancing
  // at mid-question, slow enough that a blink or a dropped frame does not flash it red.
  // Nothing here is recorded; the permanent record comes from faceDetection.ts, which is
  // deliberately four times slower.
  const stabilize = createGazeStabilizer(4, 3);

  return async function track(video: HTMLVideoElement): Promise<EyeGazeTrackingResult | null> {
    if (video.readyState < 2 || busy) return null;

    let landmarker: FaceLandmarker;
    try {
      landmarker = await getFaceLandmarker();
    } catch {
      return null;
    }

    busy = true;
    try {
      let result;
      try {
        result = landmarker.detectForVideo(video, performance.now());
      } catch {
        return null;
      }

      const faces = result.faceLandmarks ?? [];
      if (faces.length === 0) {
        return {
          faceDetected: false,
          faceCount: 0,
          isLookingAtCamera: false,
          teleprompterReading: false,
          teleprompterConfidence: 0,
          gazeStatus: "no_face",
          gazeLabel: "No Face Detected",
          gazeDirection: "center",
          gaze: null,
          leftEyeBox: null,
          rightEyeBox: null,
          faceBox: null,
          yawRatio: 0,
          pitchRatio: 0,
        };
      }

      const landmarks = faces[0];
      // Blendshapes arrive on a parallel array, one entry per detected face.
      const blendshapes = result.faceBlendshapes?.[0]?.categories;
      const gaze = estimateGaze(landmarks, blendshapes);
      const nose = landmarks[NOSE_TIP];
      const rightEye = landmarks[RIGHT_EYE_OUTER];
      const leftEye = landmarks[LEFT_EYE_OUTER];

      const eyeDist = Math.hypot(leftEye.x - rightEye.x, leftEye.y - rightEye.y) || 0.1;
      const midEyeX = (leftEye.x + rightEye.x) / 2;
      const midEyeY = (leftEye.y + rightEye.y) / 2;

      const yawRatio = Math.abs(nose.x - midEyeX) / eyeDist;
      const pitchRatio = (nose.y - midEyeY) / eyeDist;

      // The verdict is now the eyes', not the head's. Head pose stays in the mix inside
      // estimateGaze — it is half of where the gaze actually points — but it can no longer
      // return "focused" on its own while the eyes are reading something off-screen, which
      // is precisely the case this feature was asked for.
      //
      // Stabilised rather than taken per-frame: at 150ms a single blurred frame would
      // otherwise flash the interviewer's border red. See createGazeStabilizer.
      const direction: GazeDirection = stabilize(gaze?.direction ?? "center");
      const isLookingAtCamera = direction === "center";

      // Mean iris position across BOTH eyes, each measured inside its own socket. The
      // previous line took landmark 468 — the right iris — and divided it by the left
      // eye's corner span, so the value fed to the reading detector below was one eye's
      // pupil as a fraction of the other eye's width.
      const irisRatio = gaze?.irisRatio ?? 0.5;

      const now = performance.now();
      irisHistory.push({ time: now, irisRatio, yaw: yawRatio });
      // Keep ~4 seconds rolling window
      while (irisHistory.length > 0 && now - irisHistory[0].time > 4000) {
        irisHistory.shift();
      }

      // Teleprompter / Script-Reading Heuristic:
      // Counts horizontal reading sweep cycles: progressive drift followed by rapid saccade reset
      let sweepCycles = 0;
      let inSweep = false;
      let sweepLength = 0;

      if (irisHistory.length >= 10) {
        for (let i = 1; i < irisHistory.length; i++) {
          const delta = irisHistory[i].irisRatio - irisHistory[i - 1].irisRatio;
          if (delta > 0.015) {
            inSweep = true;
            sweepLength++;
          } else if (delta < -0.04 && inSweep && sweepLength >= 3) {
            // Sharp saccadic jump back to start of line
            sweepCycles++;
            inSweep = false;
            sweepLength = 0;
          }
        }
      }

      // 2 or more horizontal sweep-and-snap cycles in 4s while head is relatively stationary indicates reading a teleprompter
      const teleprompterReading = sweepCycles >= 2 && yawRatio < 0.28;
      const teleprompterConfidence = teleprompterReading ? Math.min(0.95, 0.65 + sweepCycles * 0.1) : 0;

      // Extract left & right eye bounding boxes with appropriate padding
      const rightEyeBox = computeBox(landmarks, RIGHT_EYE_INDICES, 0.006, 0.008);
      const leftEyeBox = computeBox(landmarks, LEFT_EYE_INDICES, 0.006, 0.008);

      // Compute face bounding box
      let minFx = Infinity, maxFx = -Infinity, minFy = Infinity, maxFy = -Infinity;
      for (const pt of landmarks) {
        if (pt.x < minFx) minFx = pt.x;
        if (pt.x > maxFx) maxFx = pt.x;
        if (pt.y < minFy) minFy = pt.y;
        if (pt.y > maxFy) maxFy = pt.y;
      }
      const faceBox: Box = {
        x: Math.max(0, minFx - 0.02),
        y: Math.max(0, minFy - 0.03),
        width: Math.min(1, maxFx - minFx + 0.04),
        height: Math.min(1, maxFy - minFy + 0.06),
      };

      // Named by what was observed, not by what it might mean. "Looking down" is a fact
      // about the eyes; "reading their phone" is a guess about the room, and the HUD this
      // feeds sits in front of someone making a hiring decision.
      let gazeStatus: GazeStatus = "focused";
      let gazeLabel = "Focused on Screen";

      if (direction === "down") {
        gazeStatus = "looking_down";
        gazeLabel = "👁️ Eyes Down — Off-Screen";
      } else if (direction === "sideways") {
        gazeStatus = "turned_away";
        gazeLabel = "👁️ Looking Away From Screen";
      } else if (direction === "up") {
        gazeStatus = "looking_up";
        gazeLabel = "👁️ Eyes Up — Off-Screen";
      }

      if (teleprompterReading) {
        gazeStatus = "teleprompter_reading";
        gazeLabel = `⚠️ Teleprompter Script Reading (${Math.round(teleprompterConfidence * 100)}%)`;
      }

      return {
        faceDetected: true,
        faceCount: faces.length,
        isLookingAtCamera,
        teleprompterReading,
        teleprompterConfidence,
        gazeStatus,
        gazeLabel,
        gazeDirection: direction,
        gaze,
        leftEyeBox,
        rightEyeBox,
        faceBox,
        yawRatio,
        pitchRatio,
      };
    } finally {
      busy = false;
    }
  };
}
