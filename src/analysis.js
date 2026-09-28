import { buildLuminance, computeMultiScaleDarkRidge } from "./ridge.js";
import { computeDirectionalColorDifference } from "./color.js";
import { computeLocalLuminanceNormalization, normalizeFeatureLocally } from "./local-adaptive.js";
import { compareBoundaryMasks, computeRegionalMetrics, dilateBinaryMask } from "./evaluation.js";
import { interpolateSensitivityDelta } from "./local-tune.js";

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function thresholdFromSensitivity(sensitivity) {
  return 0.76 - (sensitivity / 100) * 0.50;
}

function normalizeWeights(darkWeightRaw, ridgeWeightRaw, colorWeightRaw) {
  const total = Math.max(1, darkWeightRaw + ridgeWeightRaw + colorWeightRaw);
  return {
    dark: darkWeightRaw / total,
    ridge: ridgeWeightRaw / total,
    color: colorWeightRaw / total,
  };
}

export async function computeBoundaryFeatures(imageData, options = {}) {
  const onProgress = options.onProgress ?? (() => {});
  const localEnabled = options.localEnabled ?? true;
  const localStrength = localEnabled ? (options.localStrength ?? 0.7) : 0;
  const localWindow = Math.max(48, Math.round(options.localWindow ?? 320));
  const localRadius = Math.max(24, Math.round(localWindow / 2));
  const { width, height } = imageData;

  onProgress(0.02);
  const luma = buildLuminance(imageData);

  const dark = await computeLocalLuminanceNormalization(luma, width, height, {
    radius: localRadius,
    strength: localStrength,
    onProgress: ratio => onProgress(0.02 + ratio * 0.20),
  });

  const ridgeResult = await computeMultiScaleDarkRidge(luma, width, height, {
    scales: options.ridgeScales ?? [1, 2, 4],
    onProgress: ratio => onProgress(0.22 + ratio * 0.31),
  });

  const directionalColor = await computeDirectionalColorDifference(imageData, ridgeResult.orientation, {
    distances: options.colorDistances ?? [2, 4, 6],
    onProgress: ratio => onProgress(0.53 + ratio * 0.30),
  });

  const ridge = localStrength > 0
    ? normalizeFeatureLocally(ridgeResult.ridge, width, height, { radius: localRadius, strength: localStrength * 0.45 })
    : ridgeResult.ridge;
  const color = localStrength > 0
    ? normalizeFeatureLocally(directionalColor, width, height, { radius: localRadius, strength: localStrength })
    : directionalColor;

  onProgress(1);
  return {
    width,
    height,
    dark,
    ridge,
    color,
    orientation: ridgeResult.orientation,
    ridgeScale: ridgeResult.bestScale,
    local: {
      enabled: localEnabled,
      strength: localStrength,
      window: localWindow,
    },
  };
}

export function buildRawBoundaryMask(features, options = {}) {
  const sensitivity = options.sensitivity ?? 62;
  const weights = normalizeWeights(
    options.darkWeight ?? 20,
    options.ridgeWeight ?? 55,
    options.colorWeight ?? 25,
  );
  const calibration = options.localCalibration ?? null;
  const mask = new Uint8Array(features.width * features.height);

  if (!calibration?.values?.length) {
    const threshold = thresholdFromSensitivity(sensitivity);
    for (let p = 0; p < mask.length; p += 1) {
      const score = (features.dark[p] / 255) * weights.dark
        + (features.ridge[p] / 255) * weights.ridge
        + (features.color[p] / 255) * weights.color;
      if (score >= threshold) mask[p] = 1;
    }
    return mask;
  }

  for (let y = 0; y < features.height; y += 1) {
    const base = y * features.width;
    for (let x = 0; x < features.width; x += 1) {
      const p = base + x;
      const delta = interpolateSensitivityDelta(
        calibration,
        x,
        y,
        features.width,
        features.height,
      );
      const localSensitivity = Math.max(1, Math.min(100, sensitivity + delta));
      const threshold = thresholdFromSensitivity(localSensitivity);
      const score = (features.dark[p] / 255) * weights.dark
        + (features.ridge[p] / 255) * weights.ridge
        + (features.color[p] / 255) * weights.color;
      if (score >= threshold) mask[p] = 1;
    }
  }
  return mask;
}

function neighborSupport(mask, width, height) {
  const out = new Uint8Array(mask.length);
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const p = y * width + x;
      if (!mask[p]) continue;
      let count = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          count += mask[(y + dy) * width + (x + dx)] ? 1 : 0;
        }
      }
      if (count >= 2) out[p] = 1;
    }
  }
  return out;
}

function computeComponentSizeMap(mask, width, height) {
  const size = width * height;
  const visited = new Uint8Array(size);
  const componentSize = new Uint32Array(size);
  const queue = new Int32Array(size);

  for (let start = 0; start < size; start += 1) {
    if (!mask[start] || visited[start]) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    visited[start] = 1;

    while (head < tail) {
      const current = queue[head++];
      const x = current % width;
      const y = Math.floor(current / width);
      for (let dy = -1; dy <= 1; dy += 1) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const next = ny * width + nx;
          if (mask[next] && !visited[next]) {
            visited[next] = 1;
            queue[tail++] = next;
          }
        }
      }
    }
    for (let i = 0; i < tail; i += 1) componentSize[queue[i]] = tail;
  }
  return componentSize;
}

function applyMinComponent(mask, width, height, minSize) {
  const supported = neighborSupport(mask, width, height);
  if (minSize <= 1) return supported;
  const sizes = computeComponentSizeMap(supported, width, height);
  const out = new Uint8Array(mask.length);
  for (let p = 0; p < out.length; p += 1) {
    if (supported[p] && sizes[p] >= minSize) out[p] = 1;
  }
  return out;
}

export async function buildBoundaryMask(features, options = {}) {
  const onProgress = options.onProgress ?? (() => {});
  onProgress(0.12);
  await new Promise(resolve => setTimeout(resolve, 0));
  const raw = buildRawBoundaryMask(features, options);
  onProgress(0.5);
  await new Promise(resolve => setTimeout(resolve, 0));
  const result = applyMinComponent(raw, features.width, features.height, options.minComponent ?? 24);
  onProgress(1);
  return result;
}

function betterScore(candidate, best) {
  if (!best) return true;
  if (candidate.f1 !== best.f1) return candidate.f1 > best.f1;
  if (candidate.recall !== best.recall) return candidate.recall > best.recall;
  return candidate.precision > best.precision;
}

function weightProfiles(current) {
  const profiles = [
    [current.darkWeight, current.ridgeWeight, current.colorWeight],
    [15, 60, 25],
    [20, 55, 25],
    [15, 50, 35],
    [25, 50, 25],
    [10, 70, 20],
    [20, 45, 35],
    [30, 45, 25],
  ];
  const seen = new Set();
  return profiles.filter(profile => {
    const key = profile.join("/");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildFastEvaluationHelpers(referenceCenterline, width, height, tolerance, reviewRadius) {
  const referenceTolerance = dilateBinaryMask(referenceCenterline, width, height, tolerance);
  const reviewMask = dilateBinaryMask(referenceCenterline, width, height, reviewRadius);
  const referenceIndices = [];
  const reviewIndices = [];
  for (let p = 0; p < referenceCenterline.length; p += 1) {
    if (referenceCenterline[p]) referenceIndices.push(p);
    if (reviewMask[p]) reviewIndices.push(p);
  }
  return { referenceTolerance, referenceIndices, reviewIndices, tolerance };
}

function evaluateRawConfiguration(features, helpers, config) {
  const threshold = thresholdFromSensitivity(config.sensitivity);
  const weights = normalizeWeights(config.darkWeight, config.ridgeWeight, config.colorWeight);
  const scoreIsPrediction = p => ((features.dark[p] / 255) * weights.dark
    + (features.ridge[p] / 255) * weights.ridge
    + (features.color[p] / 255) * weights.color) >= threshold;

  let matchedPrediction = 0;
  let falsePositive = 0;
  for (const p of helpers.reviewIndices) {
    if (!scoreIsPrediction(p)) continue;
    if (helpers.referenceTolerance[p]) matchedPrediction += 1;
    else falsePositive += 1;
  }

  let matchedReference = 0;
  let falseNegative = 0;
  const { width, height } = features;
  const tolerance = helpers.tolerance;
  for (const p of helpers.referenceIndices) {
    const x = p % width;
    const y = Math.floor(p / width);
    let found = false;
    for (let dy = -tolerance; dy <= tolerance && !found; dy += 1) {
      const ny = y + dy;
      if (ny < 0 || ny >= height) continue;
      for (let dx = -tolerance; dx <= tolerance; dx += 1) {
        const nx = x + dx;
        if (nx < 0 || nx >= width) continue;
        if (scoreIsPrediction(ny * width + nx)) {
          found = true;
          break;
        }
      }
    }
    if (found) matchedReference += 1;
    else falseNegative += 1;
  }

  const precisionDen = matchedPrediction + falsePositive;
  const recallDen = matchedReference + falseNegative;
  const precision = precisionDen ? matchedPrediction / precisionDen : 0;
  const recall = recallDen ? matchedReference / recallDen : 0;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return { precision, recall, f1 };
}

export async function autoTuneBoundary(features, referenceCenterline, options = {}) {
  const tolerance = options.tolerance ?? 4;
  const reviewRadius = Math.max(tolerance + 1, options.reviewRadius ?? 18);
  const onProgress = options.onProgress ?? (() => {});
  const current = options.current ?? {
    sensitivity: 62,
    darkWeight: 20,
    ridgeWeight: 55,
    colorWeight: 25,
    minComponent: 24,
  };

  const helpers = buildFastEvaluationHelpers(
    referenceCenterline,
    features.width,
    features.height,
    tolerance,
    reviewRadius,
  );
  if (helpers.referenceIndices.length === 0) throw new Error("お手本線がありません。");

  const sensitivityCandidates = [...new Set([
    current.sensitivity - 16,
    current.sensitivity - 8,
    current.sensitivity,
    current.sensitivity + 8,
    current.sensitivity + 16,
    50, 58, 66, 74, 82, 90,
  ].map(v => Math.max(1, Math.min(100, Math.round(v)))))]
    .sort((a, b) => a - b);
  const profiles = weightProfiles(current);

  // Stage 1: tune threshold and feature weights only inside the reviewed region.
  // This avoids repeatedly allocating full-image masks for every candidate.
  let bestRaw = null;
  let rawStep = 0;
  const rawTotal = sensitivityCandidates.length * profiles.length;
  for (const sensitivity of sensitivityCandidates) {
    for (const [darkWeight, ridgeWeight, colorWeight] of profiles) {
      const metrics = evaluateRawConfiguration(features, helpers, {
        sensitivity,
        darkWeight,
        ridgeWeight,
        colorWeight,
      });
      const candidate = { sensitivity, darkWeight, ridgeWeight, colorWeight, ...metrics };
      if (betterScore(candidate, bestRaw)) bestRaw = candidate;
      rawStep += 1;
      if (rawStep % 6 === 0 || rawStep === rawTotal) {
        onProgress((rawStep / rawTotal) * 0.7);
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }
  }

  // Stage 2: build morphology/component data once for the best raw configuration,
  // then only tune the minimum connected component size.
  const raw = buildRawBoundaryMask(features, bestRaw);
  const supported = neighborSupport(raw, features.width, features.height);
  const sizes = computeComponentSizeMap(supported, features.width, features.height);
  onProgress(0.78);
  await new Promise(resolve => setTimeout(resolve, 0));

  const minCandidates = [...new Set([1, 4, 8, 16, 24, 40, 64, 96, 128, current.minComponent])]
    .filter(v => v >= 1 && v <= 300)
    .sort((a, b) => a - b);
  let best = null;
  let bestMask = null;

  for (let i = 0; i < minCandidates.length; i += 1) {
    const minComponent = minCandidates[i];
    const mask = new Uint8Array(supported.length);
    for (let p = 0; p < mask.length; p += 1) {
      if (supported[p] && sizes[p] >= minComponent) mask[p] = 1;
    }
    const metrics = compareBoundaryMasks(mask, referenceCenterline, features.width, features.height, {
      tolerance,
      reviewRadius,
    });
    const candidate = {
      sensitivity: bestRaw.sensitivity,
      darkWeight: bestRaw.darkWeight,
      ridgeWeight: bestRaw.ridgeWeight,
      colorWeight: bestRaw.colorWeight,
      minComponent,
      precision: metrics.precision,
      recall: metrics.recall,
      f1: metrics.f1,
    };
    if (betterScore(candidate, best)) {
      best = candidate;
      bestMask = mask;
    }
    onProgress(0.78 + ((i + 1) / minCandidates.length) * 0.22);
    await new Promise(resolve => setTimeout(resolve, 0));
  }

  const metrics = computeRegionalMetrics(bestMask, referenceCenterline, features.width, features.height, {
    tolerance,
    reviewRadius,
    cols: 4,
    rows: 4,
  });
  return {
    parameters: {
      sensitivity: best.sensitivity,
      darkWeight: best.darkWeight,
      ridgeWeight: best.ridgeWeight,
      colorWeight: best.colorWeight,
      minComponent: best.minComponent,
    },
    metrics,
    mask: bestMask,
  };
}

export function renderBoundaryOverlay(mask, width, height, options = {}) {
  const opacity = (options.opacity ?? 90) / 100;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let p = 0; p < mask.length; p += 1) {
    if (!mask[p]) continue;
    const i = p * 4;
    rgba[i] = 35;
    rgba[i + 1] = 245;
    rgba[i + 2] = 222;
    rgba[i + 3] = Math.round(255 * opacity);
  }
  return new ImageData(rgba, width, height);
}

export function renderComparisonOverlay(prediction, referenceCenterline, width, height, options = {}) {
  const opacity = (options.opacity ?? 90) / 100;
  const metrics = computeRegionalMetrics(prediction, referenceCenterline, width, height, {
    ...options,
    cols: 4,
    rows: 4,
  });
  const rgba = new Uint8ClampedArray(width * height * 4);
  const alpha = Math.round(255 * opacity);

  for (let p = 0; p < prediction.length; p += 1) {
    const i = p * 4;

    // Show the exact acceptance band used by Precision evaluation.
    // The visible yellow band therefore has the same width as the judgement area.
    if (metrics.referenceTolerance[p]) {
      rgba[i] = 255;
      rgba[i + 1] = 216;
      rgba[i + 2] = 74;
      rgba[i + 3] = Math.round(alpha * 0.24);
    }

    if (!metrics.reviewMask[p]) {
      if (prediction[p]) {
        rgba[i] = 35;
        rgba[i + 1] = 245;
        rgba[i + 2] = 222;
        rgba[i + 3] = Math.round(alpha * 0.22);
      }
      continue;
    }

    if (prediction[p]) {
      if (metrics.referenceTolerance[p]) {
        rgba[i] = 88;
        rgba[i + 1] = 227;
        rgba[i + 2] = 138;
      } else {
        rgba[i] = 255;
        rgba[i + 1] = 94;
        rgba[i + 2] = 103;
      }
      rgba[i + 3] = alpha;
    }
    if (referenceCenterline[p] && !metrics.predictionTolerance[p]) {
      rgba[i] = 255;
      rgba[i + 1] = 216;
      rgba[i + 2] = 74;
      rgba[i + 3] = 255;
    }
  }
  return { imageData: new ImageData(rgba, width, height), metrics };
}

export { compareBoundaryMasks, computeRegionalMetrics } from "./evaluation.js";
