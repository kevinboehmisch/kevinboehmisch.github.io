// Port of the scoring part of matching.py: landmarks -> features -> match score against a reference.
// Keep the numbers in sync with matching.py, the references are recorded with the Python version.

// Main knob for how forgiving the score is: 1 = strict raw score, higher = more forgiving.
export const LENIENCY = 2.0;

// Distance at which a hand counts as "completely wrong"
const HAND_POSITION_TOLERANCE = 1.5; // in face widths
const HAND_SHAPE_TOLERANCE = 0.8; // in palm lengths

// Eye gaze direction (eyeLook*) is ignored: it changes with where the player looks, not with the expression.
const IGNORED_BLENDSHAPES = [10, 18]; // slice(10, 18)

const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const mean = (values) => values.reduce((sum, v) => sum + v, 0) / values.length;

/** Turn the raw landmarks into something comparable. Returns null without a face. */
export function extractFeatures(faceResult, handResult, width, height) {
  if (!faceResult?.faceLandmarks?.length) return null;

  const face = faceResult.faceLandmarks[0].map((p) => [p.x * width, p.y * height]);
  const nose = face[1];
  const faceWidth = distance(face[234], face[454]) + 1e-6;

  const blendshapes = faceResult.faceBlendshapes[0].categories
    .filter((c) => c.categoryName !== "_neutral")
    .map((c) => c.score);

  const hands = (handResult?.landmarks ?? []).map((landmarks) => {
    const pts = landmarks.map((p) => [p.x * width, p.y * height]);
    const palm = [0, 5, 9, 13, 17].map((i) => pts[i]);
    const palmCenter = [mean(palm.map((p) => p[0])), mean(palm.map((p) => p[1]))];
    const palmLength = distance(pts[9], pts[0]) + 1e-6;
    return {
      position: [(palmCenter[0] - nose[0]) / faceWidth, (palmCenter[1] - nose[1]) / faceWidth],
      shape: pts.map((p) => [(p[0] - pts[0][0]) / palmLength, (p[1] - pts[0][1]) / palmLength]),
      pixels: pts,
    };
  });
  hands.sort((a, b) => a.position[0] - b.position[0]);

  return { blendshapes, hands };
}

function faceScore(a, b) {
  let low = 0;
  let high = 0;
  for (let i = 0; i < a.length; i++) {
    if (i >= IGNORED_BLENDSHAPES[0] && i < IGNORED_BLENDSHAPES[1]) continue;
    low += Math.min(a[i], b[i]);
    high += Math.max(a[i], b[i]);
  }
  return low / (high + 1e-6);
}

function handsScore(player, reference) {
  if (player.length !== reference.length) return 0;
  const scores = player.map((p, i) => {
    const r = reference[i];
    const positionError = distance(p.position, r.position);
    const shapeError = mean(p.shape.map((point, j) => distance(point, r.shape[j])));
    const position = Math.max(0, 1 - positionError / HAND_POSITION_TOLERANCE);
    const shape = Math.max(0, 1 - shapeError / HAND_SHAPE_TOLERANCE);
    return 0.5 * position + 0.5 * shape;
  });
  return mean(scores);
}

/** 0..1. Hands only count if the reference has hands in it. */
export function matchScore(player, reference) {
  if (!player) return 0;
  let raw = faceScore(player.blendshapes, reference.blendshapes);
  if (reference.hands.length) raw = 0.5 * raw + 0.5 * handsScore(player.hands, reference.hands);
  return raw ** (1 / LENIENCY);
}

/** Score against several references of the same meme: the closest one counts. */
export function bestMatchScore(player, references) {
  return Math.max(...references.map((reference) => matchScore(player, reference)));
}
