/**
 * Eyeball-level gaze estimation shared by the candidate-side proctoring detector
 * (faceDetection.ts) and the interviewer's live HUD (eyeGazeTracker.ts).
 *
 * Why this exists: both of those previously decided "is the candidate looking at the
 * screen?" from head pose alone — the nose tip's offset from the eye midpoint. That
 * answers "has the head turned", which is a different question. Someone can hold their
 * head square to the camera and read a phone propped below the monitor, and head pose
 * calls that focused. Eye direction is the part that was missing.
 *
 * Two independent sources are combined, so neither has to carry the decision alone:
 *
 *  1. MediaPipe's ARKit-style eye blendshapes (eyeLookIn/Out/Up/Down per eye). These come
 *     from the model rather than from arithmetic on landmark pixels, and the model has
 *     already factored out head pose — which is exactly the decoupling this needs.
 *  2. Iris-centre geometry: where each iris sits inside its own eye opening. Cheap,
 *     explainable, and a sanity check on the above. Also the fallback when a model build
 *     returns no blendshapes, so gaze never silently degrades to head-pose-only again.
 *
 * Head pose is then added back deliberately: what matters is where the eyes are pointing
 * in the room, which is head direction plus eye deviation within the head.
 *
 * Deliberately NOT claimed: a screen coordinate. Without per-person calibration you cannot
 * say which part of the screen someone is looking at, and anything built on that pretence
 * would be confidently wrong. What is claimed is coarse and defensible — eyes roughly
 * forward, or deviated far enough that they are off the screen entirely, and in which
 * direction. "Looking down" is reported as exactly that, not as "looking at a phone".
 */

export interface Pt {
  x: number;
  y: number;
}

/** One entry of MediaPipe's faceBlendshapes[].categories. */
export interface BlendshapeCategory {
  categoryName?: string;
  displayName?: string;
  score: number;
}

export type GazeDirection = "center" | "down" | "up" | "sideways";

export interface GazeEstimate {
  /** Eyes are shut far enough that iris position means nothing this frame. */
  eyesClosed: boolean;
  /** Signed eye deviation inside the head, -1..1. Sign is image-space, so left/right is
   * not meaningful to show a human when the preview may be mirrored — magnitude is. */
  eyeYaw: number;
  /** Signed eye deviation, -1..1, positive = looking up. Mirroring never flips this. */
  eyePitch: number;
  /** Signed head yaw, normalised against interocular distance. Magnitude only, as above. */
  headYaw: number;
  /** Signed head pitch, positive = tilted up. */
  headPitch: number;
  /** Head plus eye: where the gaze points in the room rather than within the face. */
  combinedYaw: number;
  combinedPitch: number;
  direction: GazeDirection;
  /** False when the gaze is far enough off-axis to be off the screen. */
  onScreen: boolean;
  /** Which sources agreed, for the reviewer and for debugging a disputed flag. */
  usedBlendshapes: boolean;
  /** Mean iris-centre horizontal position across both eyes, 0..1 within the eye opening.
   * 0.5 is centred. Exposed for the teleprompter sweep heuristic. */
  irisRatio: number;
}

// MediaPipe's 478-point mesh. The last ten points (468-477) are the iris refinement.
//
// These pairings are the ones the old code got wrong: it took landmark 468 — which belongs
// to the RIGHT iris — and measured it against the LEFT eye's corners (362/263), so the
// "iris ratio" that fed the teleprompter detector was one eye's pupil expressed as a
// fraction of the other eye's socket. Routinely outside 0..1 and unrelated to gaze.
const RIGHT_EYE = { outer: 33, inner: 133, upper: 159, lower: 145, iris: 468 };
const LEFT_EYE = { outer: 263, inner: 362, upper: 386, lower: 374, iris: 473 };

const NOSE_TIP = 1;

/** Nose-to-eye-midpoint vertical ratio when the head is level. Measured as the centre of
 * the band the previous head-pose check treated as "natural eye level" (0.12–0.70). */
const LEVEL_PITCH_RATIO = 0.41;
const PITCH_RATIO_HALF_RANGE = 0.29;

// Thresholds, applied to the head+eye sum rather than to either part alone.
//
// Summing matters and is not a detail: turning your head to one side while keeping your
// eyes on the person you are talking to is ordinary, and it puts the eyes far off-axis
// *within the head* while the gaze itself never leaves the screen. A rule that tripped on
// eye deviation by itself would call that looking away — and would do it to anyone who
// sits at an angle to their webcam, every time they spoke.
//
// Both terms are roughly -1..1 over a comparable angular range, so adding them is a decent
// approximation of gaze direction in the room. It is not a calibrated angle, and nothing
// downstream should treat it as one.
//
// Values sit well outside ordinary conversational movement. People glance around
// constantly while thinking, and a detector that fires on that is worse than none: the
// reviewer stops reading it, including on the day it is right.
/** Matches the sensitivity the head-only check already had (it called anything past 0.32
 * "not looking at the camera"), so adding eye tracking never made head turns *harder* to
 * detect than they were before. */
const COMBINED_YAW_OFF_SCREEN = 0.35;
/** Higher than the sideways threshold, and deliberately so. Almost every webcam sits above
 * the screen, which means looking at the middle of the screen is already looking somewhat
 * down — a symmetric threshold would mark an attentive candidate as off-screen for the
 * whole interview. Reading something in the lap or on the desk is far steeper than reading
 * the top of a monitor, and this sits in the gap between them. */
const COMBINED_PITCH_DOWN = 0.55;
const COMBINED_PITCH_UP = 0.5;
/** Above this on both eyes the lids are closed far enough that iris position is noise. */
const BLINK_SCORE = 0.6;

function score(shapes: Map<string, number>, name: string): number {
  return shapes.get(name) ?? 0;
}

function clamp(v: number, lo = -1, hi = 1): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Where one iris sits inside its own eye opening, as 0..1 on each axis. 0.5 is centred.
 * Returns null when the eye opening is too small to divide by — a blink, or a face too
 * small in frame for the iris points to be meaningful. */
function irisOffset(
  landmarks: Pt[],
  eye: { outer: number; inner: number; upper: number; lower: number; iris: number }
): { x: number; y: number } | null {
  const outer = landmarks[eye.outer];
  const inner = landmarks[eye.inner];
  const upper = landmarks[eye.upper];
  const lower = landmarks[eye.lower];
  const iris = landmarks[eye.iris];
  if (!outer || !inner || !upper || !lower || !iris) return null;

  const spanX = Math.abs(outer.x - inner.x);
  const spanY = Math.abs(lower.y - upper.y);
  // 0.004 of frame width/height: below this the eye is either shut or a handful of pixels
  // across, and the division amplifies landmark jitter into a confident wrong answer.
  if (spanX < 0.004 || spanY < 0.004) return null;

  const minX = Math.min(outer.x, inner.x);
  const minY = Math.min(upper.y, lower.y);
  return {
    x: clamp((iris.x - minX) / spanX, 0, 1),
    y: clamp((iris.y - minY) / spanY, 0, 1),
  };
}

/**
 * Turns one frame's landmarks and blendshapes into a gaze estimate.
 *
 * `blendshapes` is optional on purpose: a model build that does not emit them, or an
 * options object that forgot to ask for them, falls back to iris geometry rather than
 * quietly reverting to head-pose-only — which is the failure this whole module exists to
 * remove, and the one that would be hardest to notice had happened.
 */
export function estimateGaze(landmarks: Pt[], blendshapes?: BlendshapeCategory[]): GazeEstimate | null {
  const nose = landmarks[NOSE_TIP];
  const rightOuter = landmarks[RIGHT_EYE.outer];
  const leftOuter = landmarks[LEFT_EYE.outer];
  if (!nose || !rightOuter || !leftOuter) return null;

  // Every ratio below is divided by interocular distance so none of this depends on how
  // close the candidate sits to the camera.
  const eyeDist = Math.hypot(leftOuter.x - rightOuter.x, leftOuter.y - rightOuter.y) || 0.1;
  const midEyeX = (leftOuter.x + rightOuter.x) / 2;
  const midEyeY = (leftOuter.y + rightOuter.y) / 2;

  const headYaw = clamp((nose.x - midEyeX) / eyeDist);
  const pitchRatio = (nose.y - midEyeY) / eyeDist;
  // Tilting the chin down foreshortens the face, so the nose rises toward the eye line and
  // this ratio falls. Negated so that, like eyePitch, positive means up.
  const headPitch = clamp((pitchRatio - LEVEL_PITCH_RATIO) / PITCH_RATIO_HALF_RANGE);

  const rightIris = irisOffset(landmarks, RIGHT_EYE);
  const leftIris = irisOffset(landmarks, LEFT_EYE);

  const shapes = new Map<string, number>();
  for (const c of blendshapes ?? []) {
    const name = c.categoryName ?? c.displayName;
    if (name) shapes.set(name, c.score);
  }
  const usedBlendshapes = shapes.size > 0;

  const blinkLeft = score(shapes, "eyeBlinkLeft");
  const blinkRight = score(shapes, "eyeBlinkRight");
  // Both eyes, not either: a wink or one eye mis-tracked for a frame should not blank the
  // signal, and looking sharply down lowers the lids enough to lift one of these on its own.
  const eyesClosed = usedBlendshapes
    ? blinkLeft > BLINK_SCORE && blinkRight > BLINK_SCORE
    : rightIris === null && leftIris === null;

  let eyeYaw = 0;
  let eyePitch = 0;

  if (usedBlendshapes) {
    // ARKit naming: "out" is toward that eye's own side of the face, "in" is toward the
    // nose. Both eyes move together, so looking to the subject's left is the left eye
    // moving out and the right eye moving in — averaging the pair cancels the per-eye
    // asymmetry the model produces at the extremes.
    const toSubjectLeft = (score(shapes, "eyeLookOutLeft") + score(shapes, "eyeLookInRight")) / 2;
    const toSubjectRight = (score(shapes, "eyeLookInLeft") + score(shapes, "eyeLookOutRight")) / 2;
    eyeYaw = clamp(toSubjectLeft - toSubjectRight);

    const up = (score(shapes, "eyeLookUpLeft") + score(shapes, "eyeLookUpRight")) / 2;
    const down = (score(shapes, "eyeLookDownLeft") + score(shapes, "eyeLookDownRight")) / 2;
    eyePitch = clamp(up - down);
  } else if (rightIris || leftIris) {
    // Geometric fallback. Less linear than the blendshapes near the extremes, but it moves
    // in the right direction and keeps the detector eye-based rather than head-based.
    const xs = [rightIris?.x, leftIris?.x].filter((v): v is number => v !== undefined);
    const ys = [rightIris?.y, leftIris?.y].filter((v): v is number => v !== undefined);
    const meanX = xs.reduce((a, b) => a + b, 0) / xs.length;
    const meanY = ys.reduce((a, b) => a + b, 0) / ys.length;
    // Centre is 0.5; scaled by 2 so a pupil hard against one corner reads as ±1.
    eyeYaw = clamp((meanX - 0.5) * 2);
    eyePitch = clamp(-(meanY - 0.5) * 2);
  }

  const irisXs = [rightIris?.x, leftIris?.x].filter((v): v is number => v !== undefined);
  const irisRatio = irisXs.length > 0 ? irisXs.reduce((a, b) => a + b, 0) / irisXs.length : 0.5;

  // Head direction plus where the eyes point within it. A head turned 30° away with the
  // eyes rolled back toward the camera is someone still watching you; the two partially
  // cancel, and summing them is what represents that.
  const combinedYaw = clamp(headYaw + eyeYaw);
  const combinedPitch = clamp(headPitch + eyePitch);

  let direction: GazeDirection = "center";
  let onScreen = true;

  if (eyesClosed) {
    // Lids shut: report the last thing that can still be trusted — the head — and let the
    // caller's dwell counter decide. Treating a blink as "looking away" would fire this on
    // everyone, several times a minute.
    direction = Math.abs(headYaw) > COMBINED_YAW_OFF_SCREEN ? "sideways" : "center";
    onScreen = Math.abs(headYaw) <= COMBINED_YAW_OFF_SCREEN;
  } else {
    // Whichever axis has travelled furthest past its own threshold wins, rather than a
    // fixed order of tests. Order mattered more than it looks: checking "down" first meant
    // the webcam-above-the-screen bias could hold the verdict on "down" and mask a head
    // turned right away from the machine. Expressing each axis as a multiple of its own
    // threshold makes them comparable despite those thresholds being different numbers.
    const sideways = Math.abs(combinedYaw) / COMBINED_YAW_OFF_SCREEN;
    const down = -combinedPitch / COMBINED_PITCH_DOWN;
    const up = combinedPitch / COMBINED_PITCH_UP;
    const worst = Math.max(sideways, down, up);

    if (worst > 1) {
      onScreen = false;
      if (worst === down) direction = "down";
      else if (worst === sideways) direction = "sideways";
      else direction = "up";
    }
  }

  return {
    eyesClosed,
    eyeYaw,
    eyePitch,
    headYaw,
    headPitch,
    combinedYaw,
    combinedPitch,
    direction,
    onScreen,
    usedBlendshapes,
    irisRatio,
  };
}

/**
 * Holds a gaze state until it has been seen enough times in a row to be believed.
 *
 * Raw per-frame output flickers — one blurred frame, one blink caught mid-close, one
 * landmark slip — and a border that strobes red on every glance teaches the interviewer to
 * ignore it. Entering a state is deliberately slower than leaving it: a false "looking
 * away" is a quiet accusation, while a false "focused" merely misses a moment.
 */
export function createGazeStabilizer(enterSamples = 3, exitSamples = 2) {
  let stable: GazeDirection = "center";
  let candidate: GazeDirection = "center";
  let streak = 0;

  return function push(next: GazeDirection): GazeDirection {
    if (next === stable) {
      candidate = stable;
      streak = 0;
      return stable;
    }
    if (next !== candidate) {
      candidate = next;
      streak = 1;
    } else {
      streak++;
    }
    const needed = next === "center" ? exitSamples : enterSamples;
    if (streak >= needed) {
      stable = next;
      streak = 0;
    }
    return stable;
  };
}
