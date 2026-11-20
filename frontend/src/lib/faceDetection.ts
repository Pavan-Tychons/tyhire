import { FaceLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";
import { createGazeStabilizer, estimateGaze, type GazeDirection } from "@/lib/gazeEstimation";

// MediaPipe's WASM runtime logs its own benign INFO-level startup messages (e.g. "Created
// TensorFlow Lite XNNPACK delegate for CPU") through console.error internally — not our
// code's choice, a quirk of that library. Next's dev overlay treats every console.error as
// a blocking error, so without this filter a completely successful init looks like a crash.
// Narrowly matched to this one known message pattern — every other console.error still
// reaches the overlay normally.
if (typeof window !== "undefined") {
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    const first = args[0];
    if (typeof first === "string" && /TensorFlow Lite|XNNPACK delegate/.test(first)) {
      return;
    }
    originalConsoleError(...args);
  };
}

// Model + WASM runtime are self-hosted under /public (models/, wasm/) rather than pulled
// from Google's CDN at runtime — one less external dependency for this to silently break on.
const WASM_PATH = "/wasm";
const MODEL_PATH = "/models/face_landmarker.task";

let landmarkerPromise: Promise<FaceLandmarker> | null = null;

function getFaceLandmarker(): Promise<FaceLandmarker> {
  if (!landmarkerPromise) {
    landmarkerPromise = FilesetResolver.forVisionTasks(WASM_PATH).then((fileset) =>
      FaceLandmarker.createFromOptions(fileset, {
        // CPU, not GPU: this runs alongside a live Jitsi call and the MediaRecorder's own
        // video encoding, both already using the GPU — adding a GPU-delegated inference
        // graph on top is a real source of contention/instability. Slower, but this only
        // needs to run a few times a second, not every frame.
        baseOptions: { modelAssetPath: MODEL_PATH, delegate: "CPU" },
        runningMode: "VIDEO",
        numFaces: 2,
        // Eye-direction coefficients from the model itself. The cost is a second small
        // output head on an inference that is already running; the gain is that
        // gaze_off_screen stops meaning "the head turned" and starts meaning "the eyes
        // left the screen". See lib/gazeEstimation.ts.
        outputFaceBlendshapes: true,
      })
    );
  }
  return landmarkerPromise;
}

export interface FaceSignalResult {
  faceCount: number;
  gazeOffScreen: boolean;
  excessiveMotion: boolean;
  /** Eyes held below the screen line — the posture of reading something on the desk or in
   * the lap. Reported separately from gazeOffScreen because it is the specific case worth
   * telling the interviewer about while the interview is still running, and because it
   * has an innocent explanation (paper notes) that the reviewer must be free to accept. */
  downwardGaze: boolean;
  /** Stabilised direction, carried into the signal's meta so a disputed flag can be read
   * back later as "eyes down" rather than just "gaze off screen". */
  gazeDirection: GazeDirection;
  /** False when the model returned no blendshapes and the estimate fell back to iris
   * geometry — recorded so a quieter detector can be explained rather than puzzled over. */
  usedBlendshapes: boolean;
}

// Landmark indices from MediaPipe's 468-point face mesh: nose tip and the two outer eye
// corners. Using relative landmark positions (all in normalized 0-1 image coordinates)
// instead of decoding the transformation matrix's rotation convention — simpler to get
// right and easy to sanity-check by inspection.
const NOSE_TIP = 1;
const RIGHT_EYE_OUTER = 33;
const LEFT_EYE_OUTER = 263;

const YAW_RATIO_THRESHOLD = 0.35;
const MOTION_RATIO_THRESHOLD = 0.12;

export function createFaceSignalDetector() {
  let lastNose: { x: number; y: number } | null = null;
  let busy = false;
  // This detector is driven on an 800ms interval (interview/[token]/page.tsx), so 3 samples
  // is ~2.4s of agreement before a direction is believed and ~1.6s before it clears. Slow
  // on purpose: what comes out of here is written to a permanent integrity record, and the
  // cost of a wrong entry there is carried by the candidate.
  const stabilize = createGazeStabilizer(3, 2);

  return async function detect(video: HTMLVideoElement): Promise<FaceSignalResult | null> {
    if (video.readyState < 2 || busy) return null;

    let landmarker: FaceLandmarker;
    try {
      landmarker = await getFaceLandmarker();
    } catch {
      return null; // model/WASM failed to load — not treated as a hard requirement
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
        lastNose = null;
        return {
          faceCount: 0,
          gazeOffScreen: true,
          excessiveMotion: false,
          downwardGaze: false,
          gazeDirection: "center",
          usedBlendshapes: false,
        };
      }

      const landmarks = faces[0];
      const nose = landmarks[NOSE_TIP];
      const rightEye = landmarks[RIGHT_EYE_OUTER];
      const leftEye = landmarks[LEFT_EYE_OUTER];
      const eyeDist = Math.hypot(leftEye.x - rightEye.x, leftEye.y - rightEye.y) || 1;
      const midX = (leftEye.x + rightEye.x) / 2;
      const yawRatio = Math.abs(nose.x - midX) / eyeDist;

      let excessiveMotion = false;
      if (lastNose) {
        const motionRatio = Math.hypot(nose.x - lastNose.x, nose.y - lastNose.y) / eyeDist;
        excessiveMotion = motionRatio > MOTION_RATIO_THRESHOLD;
      }
      lastNose = { x: nose.x, y: nose.y };

      const gaze = estimateGaze(landmarks, result.faceBlendshapes?.[0]?.categories);
      const direction = stabilize(gaze?.direction ?? "center");

      return {
        faceCount: faces.length,
        // Still true for a hard head turn even if the eyes cannot be resolved — that was
        // the whole of this check before and it is a real finding on its own. What is new
        // is the other half: eyes off the screen while the head stays square to it, which
        // the yaw test could never see.
        gazeOffScreen: yawRatio > YAW_RATIO_THRESHOLD || direction !== "center",
        excessiveMotion,
        downwardGaze: direction === "down",
        gazeDirection: direction,
        usedBlendshapes: gaze?.usedBlendshapes ?? false,
      };
    } finally {
      busy = false;
    }
  };
}
