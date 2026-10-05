function clamp01(value) {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function clampThresholds(highThreshold, lowThreshold) {
  const high = clamp01(highThreshold ?? 0.45);
  const low = Math.min(high, clamp01(lowThreshold ?? Math.max(0, high - 0.12)));
  return { high, low };
}

function axialAngleDifference(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  let diff = Math.abs(a - b) % Math.PI;
  if (diff > Math.PI / 2) diff = Math.PI - diff;
  return Math.abs(diff);
}

function orientationAngle(features, p) {
  const continuous = features.orientationAngle?.[p];
  if (Number.isFinite(continuous)) return continuous;
  return ((features.orientation?.[p] ?? 0) % 4) * Math.PI / 4;
}

function degreeToRad(value) {
  return Math.max(0, Number(value ?? 0)) * Math.PI / 180;
}

function forbiddenAt(p, negativeMask, exclusionMask) {
  return Boolean(negativeMask?.[p] || exclusionMask?.[p]);
}

export function classifyStrongWeak(score, width, height, options = {}) {
  if (!score || score.length !== width * height) {
    throw new Error("Hysteresis分類用Boundary scoreが不正です。");
  }
  const { high, low } = clampThresholds(options.highThreshold, options.lowThreshold);
  const allowedMask = options.allowedMask ?? null;
  const negativeMask = options.negativeMask ?? null;
  const exclusionMask = options.exclusionMask ?? null;
  const strong = new Uint8Array(score.length);
  const weak = new Uint8Array(score.length);
  let strongCount = 0;
  let weakCount = 0;
  let forbiddenCount = 0;

  for (let p = 0; p < score.length; p += 1) {
    if (allowedMask && !allowedMask[p]) continue;
    if (forbiddenAt(p, negativeMask, exclusionMask)) {
      if (score[p] >= low) forbiddenCount += 1;
      continue;
    }
    const value = score[p];
    if (value >= high) {
      strong[p] = 1;
      strongCount += 1;
    } else if (value >= low) {
      weak[p] = 1;
      weakCount += 1;
    }
  }

  return {
    strong,
    weak,
    thresholds: { high, low },
    counts: { strong: strongCount, weak: weakCount, forbidden: forbiddenCount },
  };
}

export function trackWeakBoundaries(score, features, options = {}) {
  const width = features.width;
  const height = features.height;
  if (!score || score.length !== width * height) {
    throw new Error("Hysteresis追跡用Boundary scoreが不正です。");
  }

  const classified = options.classified ?? classifyStrongWeak(score, width, height, options);
  const strong = classified.strong;
  const weak = classified.weak;
  const negativeMask = options.negativeMask ?? null;
  const exclusionMask = options.exclusionMask ?? null;
  const maxTrackingDistance = Math.max(1, Number(options.maxTrackingDistance ?? 12));
  const maxScoreDelta = Math.max(0, Number(options.maxScoreDelta ?? 0.18));
  const minColorEvidence = clamp01(Number(options.minColorEvidence ?? 0.04));
  const minRidgeEvidence = clamp01(Number(options.minRidgeEvidence ?? 0.05));
  const maxDirectionDelta = degreeToRad(options.maxDirectionDeltaDeg ?? 35);
  const maxTangentMismatch = degreeToRad(options.maxTangentMismatchDeg ?? 50);
  const maxCurvature = degreeToRad(options.maxCurvatureDeg ?? 55);

  const accepted = strong.slice();
  const distance = new Float32Array(score.length);
  distance.fill(Number.POSITIVE_INFINITY);
  const parentStepAngle = new Float32Array(score.length);
  parentStepAngle.fill(Number.NaN);
  const queue = new Int32Array(score.length);
  let head = 0;
  let tail = 0;

  for (let p = 0; p < strong.length; p += 1) {
    if (!strong[p] || forbiddenAt(p, negativeMask, exclusionMask)) continue;
    distance[p] = 0;
    queue[tail++] = p;
  }

  const rejected = {
    forbidden: 0,
    distance: 0,
    score: 0,
    color: 0,
    ridge: 0,
    direction: 0,
    tangent: 0,
    curvature: 0,
  };
  let acceptedWeakCount = 0;

  const neighborSteps = [
    [-1, -1], [0, -1], [1, -1],
    [-1, 0],           [1, 0],
    [-1, 1],  [0, 1],  [1, 1],
  ];

  while (head < tail) {
    const current = queue[head++];
    const cx = current % width;
    const cy = Math.floor(current / width);
    const currentNormal = orientationAngle(features, current);
    const previousStep = parentStepAngle[current];

    for (const [dx, dy] of neighborSteps) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const next = ny * width + nx;
      if (!weak[next]) continue;

      if (forbiddenAt(next, negativeMask, exclusionMask)) {
        rejected.forbidden += 1;
        continue;
      }

      const stepLength = dx !== 0 && dy !== 0 ? Math.SQRT2 : 1;
      const nextDistance = distance[current] + stepLength;
      if (nextDistance > maxTrackingDistance + 1e-9) {
        rejected.distance += 1;
        continue;
      }

      if (Math.abs(score[next] - score[current]) > maxScoreDelta + 1e-9) {
        rejected.score += 1;
        continue;
      }

      const colorEvidence = (features.color?.[next] ?? 0) / 255;
      if (colorEvidence < minColorEvidence) {
        rejected.color += 1;
        continue;
      }

      const ridgeEvidence = (features.ridge?.[next] ?? 0) / 255;
      if (ridgeEvidence < minRidgeEvidence) {
        rejected.ridge += 1;
        continue;
      }

      const nextNormal = orientationAngle(features, next);
      if (axialAngleDifference(currentNormal, nextNormal) > maxDirectionDelta) {
        rejected.direction += 1;
        continue;
      }

      const tangent = nextNormal + Math.PI / 2;
      const stepAngle = Math.atan2(dy, dx);
      if (axialAngleDifference(tangent, stepAngle) > maxTangentMismatch) {
        rejected.tangent += 1;
        continue;
      }

      if (Number.isFinite(previousStep)
        && axialAngleDifference(previousStep, stepAngle) > maxCurvature) {
        rejected.curvature += 1;
        continue;
      }

      if (nextDistance + 1e-9 >= distance[next]) continue;
      const firstAcceptance = !accepted[next];
      distance[next] = nextDistance;
      parentStepAngle[next] = stepAngle;
      accepted[next] = 1;
      if (firstAcceptance) acceptedWeakCount += 1;
      queue[tail++] = next;
    }
  }

  let rejectedWeakCount = 0;
  for (let p = 0; p < weak.length; p += 1) {
    if (weak[p] && !accepted[p]) rejectedWeakCount += 1;
  }

  return {
    mask: accepted,
    strongMask: strong,
    weakMask: weak,
    distance,
    diagnostics: {
      thresholds: classified.thresholds,
      strongCount: classified.counts.strong,
      weakCandidateCount: classified.counts.weak,
      acceptedWeakCount,
      rejectedWeakCount,
      forbiddenCandidateCount: classified.counts.forbidden,
      rejected,
      settings: {
        maxTrackingDistance,
        maxScoreDelta,
        minColorEvidence,
        minRidgeEvidence,
        maxDirectionDeltaDeg: Number(options.maxDirectionDeltaDeg ?? 35),
        maxTangentMismatchDeg: Number(options.maxTangentMismatchDeg ?? 50),
        maxCurvatureDeg: Number(options.maxCurvatureDeg ?? 55),
      },
    },
  };
}
