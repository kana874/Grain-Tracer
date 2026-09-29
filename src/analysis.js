import { buildLuminance, computeMultiScaleDarkRidge } from "./ridge.js";
import { computeDirectionalColorDifference } from "./color.js";
import { computeLocalLuminanceNormalization, normalizeFeatureLocally } from "./local-adaptive.js";
import { compareBoundaryMasks, computeFullEvaluationRoiMetrics, computeRegionalMetrics, dilateBinaryMask } from "./evaluation.js";
import { interpolateSensitivityDelta } from "./local-tune.js";
import { computeDendriteDifference, computeDendriteOrientation } from "./dendrite.js";

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function thresholdFromSensitivity(sensitivity) {
  return 0.76 - (sensitivity / 100) * 0.50;
}

function normalizeWeights(darkWeightRaw, ridgeWeightRaw, colorWeightRaw, dendriteWeightRaw = 0) {
  const total = Math.max(1, darkWeightRaw + ridgeWeightRaw + colorWeightRaw + dendriteWeightRaw);
  return {
    dark: darkWeightRaw / total,
    ridge: ridgeWeightRaw / total,
    color: colorWeightRaw / total,
    dendrite: dendriteWeightRaw / total,
  };
}

export async function computeBoundaryFeatures(imageData, options = {}) {
  const onProgress = options.onProgress ?? (() => {});
  const localEnabled = options.localEnabled ?? true;
  const localStrength = localEnabled ? (options.localStrength ?? 0.7) : 0;
  const localWindow = Math.max(48, Math.round(options.localWindow ?? 320));
  const localRadius = Math.max(24, Math.round(localWindow / 2));
  const ridgeScales = options.ridgeScales ?? [1, 2, 4];
  const colorDistances = options.colorDistances ?? [2, 4, 6];
  const dendriteRadius = options.dendriteRadius ?? 7;
  const dendriteDistances = options.dendriteDistances ?? [5, 9, 13];
  const { width, height } = imageData;

  onProgress(0.02);
  const luma = buildLuminance(imageData);

  const dark = await computeLocalLuminanceNormalization(luma, width, height, {
    radius: localRadius,
    strength: localStrength,
    onProgress: ratio => onProgress(0.02 + ratio * 0.20),
  });

  const ridgeResult = await computeMultiScaleDarkRidge(luma, width, height, {
    scales: ridgeScales,
    onProgress: ratio => onProgress(0.22 + ratio * 0.31),
  });

  const directionalColor = await computeDirectionalColorDifference(imageData, ridgeResult.orientation, {
    distances: colorDistances,
    onProgress: ratio => onProgress(0.53 + ratio * 0.17),
  });

  const dendriteOrientation = await computeDendriteOrientation(luma, width, height, {
    radius: dendriteRadius,
    onProgress: ratio => onProgress(0.70 + ratio * 0.14),
  });
  const dendrite = await computeDendriteDifference(
    dendriteOrientation.orientation,
    dendriteOrientation.coherence,
    ridgeResult.orientation,
    width,
    height,
    {
      distances: dendriteDistances,
      onProgress: ratio => onProgress(0.84 + ratio * 0.14),
    },
  );

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
    dendrite,
    dendriteOrientation: dendriteOrientation.orientation,
    dendriteCoherence: dendriteOrientation.coherence,
    orientation: ridgeResult.orientation,
    ridgeScale: ridgeResult.bestScale,
    featureMargins: {
      dark: 0,
      ridge: Math.max(...ridgeScales) + 1,
      color: Math.max(...colorDistances) + 1,
      dendrite: Math.max(...dendriteDistances) + 1,
    },
    local: {
      enabled: localEnabled,
      strength: localStrength,
      window: localWindow,
    },
  };
}

export function buildRawBoundaryMask(features, options = {}) {
  const sensitivity = options.sensitivity ?? 62;
  const rawWeights = {
    dark: Math.max(0, Number(options.darkWeight ?? 15)),
    ridge: Math.max(0, Number(options.ridgeWeight ?? 40)),
    color: Math.max(0, Number(options.colorWeight ?? 25)),
    dendrite: Math.max(0, Number(options.dendriteWeight ?? 20)),
  };
  const calibration = options.localCalibration ?? null;
  const mask = new Uint8Array(features.width * features.height);
  const margins = features.featureMargins ?? {
    dark: 0,
    ridge: 5,
    color: 7,
    dendrite: 14,
  };
  const frameGuard = Math.max(0, Math.round(options.edgeFrameGuard ?? 1));

  const available = (margin, x, y) =>
    x >= margin && y >= margin
    && x < features.width - margin
    && y < features.height - margin;

  const scoreAt = (p, x, y) => {
    let scoreSum = 0;
    let weightSum = 0;

    if (rawWeights.dark > 0) {
      scoreSum += (features.dark[p] / 255) * rawWeights.dark;
      weightSum += rawWeights.dark;
    }
    if (rawWeights.ridge > 0 && available(margins.ridge ?? 0, x, y)) {
      scoreSum += (features.ridge[p] / 255) * rawWeights.ridge;
      weightSum += rawWeights.ridge;
    }
    if (rawWeights.color > 0 && available(margins.color ?? 0, x, y)) {
      scoreSum += (features.color[p] / 255) * rawWeights.color;
      weightSum += rawWeights.color;
    }
    if (rawWeights.dendrite > 0 && available(margins.dendrite ?? 0, x, y)) {
      scoreSum += ((features.dendrite?.[p] ?? 0) / 255) * rawWeights.dendrite;
      weightSum += rawWeights.dendrite;
    }

    return weightSum > 0 ? scoreSum / weightSum : 0;
  };

  for (let y = frameGuard; y < features.height - frameGuard; y += 1) {
    const base = y * features.width;
    for (let x = frameGuard; x < features.width - frameGuard; x += 1) {
      const p = base + x;
      const localSensitivity = calibration?.values?.length
        ? Math.max(1, Math.min(100, sensitivity + interpolateSensitivityDelta(
          calibration,
          x,
          y,
          features.width,
          features.height,
        )))
        : sensitivity;
      const threshold = thresholdFromSensitivity(localSensitivity);
      if (scoreAt(p, x, y) >= threshold) mask[p] = 1;
    }
  }
  return mask;
}
function neighborSupport(mask, width, height) {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const p = y * width + x;
      if (!mask[p]) continue;
      let count = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          count += mask[ny * width + nx] ? 1 : 0;
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

function applyExclusionInPlace(mask, exclusionMask) {
  if (!exclusionMask) return mask;
  for (let p = 0; p < mask.length; p += 1) {
    if (exclusionMask[p]) mask[p] = 0;
  }
  return mask;
}

export async function buildBoundaryMask(features, options = {}) {
  const onProgress = options.onProgress ?? (() => {});
  onProgress(0.12);
  await new Promise(resolve => setTimeout(resolve, 0));
  const raw = buildRawBoundaryMask(features, options);
  applyExclusionInPlace(raw, options.exclusionMask);
  onProgress(0.5);
  await new Promise(resolve => setTimeout(resolve, 0));
  const result = applyMinComponent(raw, features.width, features.height, options.minComponent ?? 24);
  applyExclusionInPlace(result, options.exclusionMask);
  onProgress(1);
  return result;
}

function clampInt(value, min, max) {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function uniqueSorted(values, min, max) {
  return [...new Set(values.map(value => clampInt(value, min, max)))].sort((a, b) => a - b);
}

function buildCompleteRoiMask(rects, width, height, exclusionMask = null) {
  if (!rects?.length) return null;
  const mask = new Uint8Array(width * height);
  for (const rect of rects) {
    const x0 = clampInt(Math.min(rect.x0, rect.x1), 0, width - 1);
    const x1 = clampInt(Math.max(rect.x0, rect.x1), 0, width - 1);
    const y0 = clampInt(Math.min(rect.y0, rect.y1), 0, height - 1);
    const y1 = clampInt(Math.max(rect.y0, rect.y1), 0, height - 1);
    for (let y = y0; y <= y1; y += 1) {
      const base = y * width;
      for (let x = x0; x <= x1; x += 1) {
        const p = base + x;
        if (!exclusionMask?.[p]) mask[p] = 1;
      }
    }
  }
  return mask;
}

function buildFastEvaluationHelpers(
  referenceCenterline,
  width,
  height,
  tolerance,
  negativeMask = null,
  exclusionMask = null,
  fullEvaluationRois = null,
) {
  const referenceTolerance = dilateBinaryMask(referenceCenterline, width, height, tolerance);
  const referenceIndices = [];
  const positiveBandIndices = [];
  const negativeIndices = [];

  for (let p = 0; p < referenceCenterline.length; p += 1) {
    if (exclusionMask?.[p]) continue;
    if (referenceCenterline[p]) referenceIndices.push(p);
    if (referenceTolerance[p]) positiveBandIndices.push(p);
    else if (negativeMask?.[p]) negativeIndices.push(p);
  }

  const negativeRegionIndices = Array.from({ length: 16 }, () => []);
  for (const p of negativeIndices) {
    const x = p % width;
    const y = Math.floor(p / width);
    const rx = Math.min(3, Math.floor(x * 4 / width));
    const ry = Math.min(3, Math.floor(y * 4 / height));
    negativeRegionIndices[ry * 4 + rx].push(p);
  }

  const roiMask = buildCompleteRoiMask(fullEvaluationRois, width, height, exclusionMask);
  let roiReferenceTolerance = null;
  const roiPixelIndices = [];
  const roiReferenceIndices = [];

  if (roiMask) {
    const roiReference = new Uint8Array(referenceCenterline.length);
    for (let p = 0; p < referenceCenterline.length; p += 1) {
      if (!roiMask[p]) continue;
      roiPixelIndices.push(p);
      if (referenceCenterline[p]) {
        roiReference[p] = 1;
        roiReferenceIndices.push(p);
      }
    }
    roiReferenceTolerance = dilateBinaryMask(roiReference, width, height, tolerance);
  }

  return {
    referenceTolerance,
    referenceIndices,
    positiveBandIndices,
    negativeIndices,
    negativeRegionIndices,
    tolerance,
    exclusionMask,
    roiMask,
    roiReferenceTolerance,
    roiPixelIndices,
    roiReferenceIndices,
    objectiveMode: roiPixelIndices.length ? "complete-roi-f1" : "partial-label-region-balanced",
  };
}

function partialBalancedScore(positiveRecall, negativeLeakage, hasNegativeLabels) {
  if (!hasNegativeLabels) return positiveRecall;
  const negativeSpecificity = Math.max(0, 1 - negativeLeakage);
  return positiveRecall + negativeSpecificity
    ? (2 * positiveRecall * negativeSpecificity) / (positiveRecall + negativeSpecificity)
    : 0;
}

function scorePredictionFunction(features, helpers, scoreIsPrediction) {
  let matchedPrediction = 0;
  let negativePrediction = 0;

  for (const p of helpers.positiveBandIndices) {
    if (scoreIsPrediction(p)) matchedPrediction += 1;
  }
  for (const p of helpers.negativeIndices) {
    if (scoreIsPrediction(p)) negativePrediction += 1;
  }

  let matchedReference = 0;
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
        const np = ny * width + nx;
        if (helpers.exclusionMask?.[np]) continue;
        if (scoreIsPrediction(np)) {
          found = true;
          break;
        }
      }
    }
    if (found) matchedReference += 1;
  }

  const positiveRecall = helpers.referenceIndices.length
    ? matchedReference / helpers.referenceIndices.length
    : 0;
  const negativeLeakage = helpers.negativeIndices.length
    ? negativePrediction / helpers.negativeIndices.length
    : 0;
  const labelPrecision = matchedPrediction + negativePrediction
    ? matchedPrediction / (matchedPrediction + negativePrediction)
    : 0;
  const labelF1 = labelPrecision + positiveRecall
    ? (2 * labelPrecision * positiveRecall) / (labelPrecision + positiveRecall)
    : 0;
  const activeNegativeRegions = helpers.negativeRegionIndices
    .filter(indices => indices.length > 0)
    .map(indices => {
      let predicted = 0;
      for (const p of indices) {
        if (scoreIsPrediction(p)) predicted += 1;
      }
      return predicted / indices.length;
    });
  const macroNegativeLeakage = activeNegativeRegions.length
    ? activeNegativeRegions.reduce((sum, value) => sum + value, 0) / activeNegativeRegions.length
    : 0;
  const partialScore = partialBalancedScore(
    positiveRecall,
    macroNegativeLeakage,
    helpers.negativeIndices.length > 0,
  );

  let roiPrecision = null;
  let roiRecall = null;
  let roiF1 = null;
  if (helpers.roiPixelIndices.length) {
    let roiMatchedPrediction = 0;
    let roiFalsePositive = 0;
    for (const p of helpers.roiPixelIndices) {
      if (!scoreIsPrediction(p)) continue;
      if (helpers.roiReferenceTolerance[p]) roiMatchedPrediction += 1;
      else roiFalsePositive += 1;
    }

    let roiMatchedReference = 0;
    for (const p of helpers.roiReferenceIndices) {
      const x = p % width;
      const y = Math.floor(p / width);
      let found = false;
      for (let dy = -tolerance; dy <= tolerance && !found; dy += 1) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -tolerance; dx <= tolerance; dx += 1) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const np = ny * width + nx;
          if (!helpers.roiMask[np] || helpers.exclusionMask?.[np]) continue;
          if (scoreIsPrediction(np)) {
            found = true;
            break;
          }
        }
      }
      if (found) roiMatchedReference += 1;
    }

    roiPrecision = roiMatchedPrediction + roiFalsePositive
      ? roiMatchedPrediction / (roiMatchedPrediction + roiFalsePositive)
      : 0;
    roiRecall = helpers.roiReferenceIndices.length
      ? roiMatchedReference / helpers.roiReferenceIndices.length
      : 0;
    roiF1 = roiPrecision + roiRecall
      ? (2 * roiPrecision * roiRecall) / (roiPrecision + roiRecall)
      : 0;
  }

  return {
    objectiveMode: helpers.objectiveMode,
    score: helpers.objectiveMode === "complete-roi-f1" ? (roiF1 ?? 0) : partialScore,
    positiveRecall,
    negativeLeakage,
    macroNegativeLeakage,
    negativeRegionCount: activeNegativeRegions.length,
    labelPrecision,
    labelF1,
    roiPrecision,
    roiRecall,
    roiF1,
  };
}

function evaluateRawConfiguration(features, helpers, config) {
  const threshold = thresholdFromSensitivity(config.sensitivity);
  const rawWeights = {
    dark: Math.max(0, Number(config.darkWeight ?? 0)),
    ridge: Math.max(0, Number(config.ridgeWeight ?? 0)),
    color: Math.max(0, Number(config.colorWeight ?? 0)),
    dendrite: Math.max(0, Number(config.dendriteWeight ?? 0)),
  };
  const interiorWeights = normalizeWeights(
    rawWeights.dark,
    rawWeights.ridge,
    rawWeights.color,
    rawWeights.dendrite,
  );
  const margins = features.featureMargins ?? { dark: 0, ridge: 5, color: 7, dendrite: 14 };
  const maxMargin = Math.max(margins.ridge ?? 0, margins.color ?? 0, margins.dendrite ?? 0);
  const scoreIsPrediction = p => {
    const x = p % features.width;
    const y = Math.floor(p / features.width);
    if (x < 1 || y < 1 || x >= features.width - 1 || y >= features.height - 1) return false;

    if (x >= maxMargin && y >= maxMargin
      && x < features.width - maxMargin
      && y < features.height - maxMargin) {
      return ((features.dark[p] / 255) * interiorWeights.dark
        + (features.ridge[p] / 255) * interiorWeights.ridge
        + (features.color[p] / 255) * interiorWeights.color
        + ((features.dendrite?.[p] ?? 0) / 255) * interiorWeights.dendrite) >= threshold;
    }

    let scoreSum = 0;
    let weightSum = 0;
    if (rawWeights.dark > 0) {
      scoreSum += (features.dark[p] / 255) * rawWeights.dark;
      weightSum += rawWeights.dark;
    }
    if (rawWeights.ridge > 0
      && x >= (margins.ridge ?? 0) && y >= (margins.ridge ?? 0)
      && x < features.width - (margins.ridge ?? 0)
      && y < features.height - (margins.ridge ?? 0)) {
      scoreSum += (features.ridge[p] / 255) * rawWeights.ridge;
      weightSum += rawWeights.ridge;
    }
    if (rawWeights.color > 0
      && x >= (margins.color ?? 0) && y >= (margins.color ?? 0)
      && x < features.width - (margins.color ?? 0)
      && y < features.height - (margins.color ?? 0)) {
      scoreSum += (features.color[p] / 255) * rawWeights.color;
      weightSum += rawWeights.color;
    }
    if (rawWeights.dendrite > 0
      && x >= (margins.dendrite ?? 0) && y >= (margins.dendrite ?? 0)
      && x < features.width - (margins.dendrite ?? 0)
      && y < features.height - (margins.dendrite ?? 0)) {
      scoreSum += ((features.dendrite?.[p] ?? 0) / 255) * rawWeights.dendrite;
      weightSum += rawWeights.dendrite;
    }
    return weightSum > 0 && scoreSum / weightSum >= threshold;
  };
  return scorePredictionFunction(features, helpers, scoreIsPrediction);
}

function betterTuneScore(candidate, best) {
  if (!best) return true;
  const epsilon = 1e-9;
  if (candidate.score > best.score + epsilon) return true;
  if (candidate.score < best.score - epsilon) return false;

  if (candidate.objectiveMode === "complete-roi-f1") {
    const candidateRecall = candidate.roiRecall ?? 0;
    const bestRecall = best.roiRecall ?? 0;
    if (candidateRecall > bestRecall + epsilon) return true;
    if (candidateRecall < bestRecall - epsilon) return false;
  }

  if (candidate.positiveRecall > best.positiveRecall + epsilon) return true;
  if (candidate.positiveRecall < best.positiveRecall - epsilon) return false;
  const candidateMacroLeakage = candidate.macroNegativeLeakage ?? candidate.negativeLeakage;
  const bestMacroLeakage = best.macroNegativeLeakage ?? best.negativeLeakage;
  if (candidateMacroLeakage < bestMacroLeakage - epsilon) return true;
  return false;
}

function coordinateCandidates(name, value, round) {
  if (name === "sensitivity") {
    const step = [12, 6, 3][Math.min(round, 2)];
    const broad = round === 0 ? [35, 50, 65, 80, 95] : [];
    return uniqueSorted(
      [value - 2 * step, value - step, value, value + step, value + 2 * step, ...broad],
      1,
      100,
    );
  }

  const step = [25, 10, 5][Math.min(round, 2)];
  const broad = round === 0 ? [0, 10, 25, 50, 75, 100] : [0];
  return uniqueSorted(
    [value - 2 * step, value - step, value, value + step, value + 2 * step, ...broad],
    0,
    100,
  );
}

function buildMaskFromComponentSizes(supported, sizes, minComponent, exclusionMask) {
  const mask = new Uint8Array(supported.length);
  for (let p = 0; p < mask.length; p += 1) {
    if (supported[p] && sizes[p] >= minComponent && !exclusionMask?.[p]) mask[p] = 1;
  }
  return mask;
}

function scoreProcessedMask(mask, referenceCenterline, features, options, helpers) {
  const partialMetrics = computeRegionalMetrics(
    mask,
    referenceCenterline,
    features.width,
    features.height,
    {
      tolerance: helpers.tolerance,
      reviewRadius: options.reviewRadius ?? 18,
      negativeMask: options.negativeMask ?? null,
      exclusionMask: options.exclusionMask ?? null,
      cols: 4,
      rows: 4,
    },
  );

  const partialScore = partialBalancedScore(
    partialMetrics.positiveRecall,
    partialMetrics.macroNegativeLeakage,
    partialMetrics.negativePixels > 0,
  );

  let roiMetrics = null;
  if (options.fullEvaluationRois?.length) {
    roiMetrics = computeFullEvaluationRoiMetrics(
      mask,
      referenceCenterline,
      features.width,
      features.height,
      options.fullEvaluationRois,
      {
        tolerance: helpers.tolerance,
        exclusionMask: options.exclusionMask ?? null,
      },
    );
  }

  return {
    objectiveMode: roiMetrics?.roiCount ? "complete-roi-f1" : "partial-label-region-balanced",
    score: roiMetrics?.roiCount ? roiMetrics.f1 : partialScore,
    positiveRecall: partialMetrics.positiveRecall,
    negativeLeakage: partialMetrics.negativeLeakage,
    macroNegativeLeakage: partialMetrics.macroNegativeLeakage,
    negativeRegionCount: partialMetrics.negativeRegionCount,
    labelPrecision: partialMetrics.labelPrecision,
    labelF1: partialMetrics.labelF1,
    roiPrecision: roiMetrics?.roiCount ? roiMetrics.precision : null,
    roiRecall: roiMetrics?.roiCount ? roiMetrics.recall : null,
    roiF1: roiMetrics?.roiCount ? roiMetrics.f1 : null,
    partialMetrics,
    roiMetrics,
  };
}

async function optimizeMinComponent(features, referenceCenterline, config, options, helpers, progress) {
  const raw = buildRawBoundaryMask(features, config);
  applyExclusionInPlace(raw, options.exclusionMask);
  const supported = neighborSupport(raw, features.width, features.height);
  const sizes = computeComponentSizeMap(supported, features.width, features.height);

  const minCandidates = uniqueSorted(
    [1, 4, 8, 16, 24, 40, 64, 96, 128, 192, 256, config.minComponent ?? 24],
    1,
    300,
  );
  let best = null;
  let bestMask = null;

  for (let i = 0; i < minCandidates.length; i += 1) {
    const minComponent = minCandidates[i];
    const mask = buildMaskFromComponentSizes(
      supported,
      sizes,
      minComponent,
      options.exclusionMask,
    );
    const objective = scoreProcessedMask(mask, referenceCenterline, features, options, helpers);
    const candidate = {
      ...objective,
      parameters: { ...config, minComponent },
    };
    if (betterTuneScore(candidate, best)) {
      best = candidate;
      bestMask = mask;
    }
    progress?.((i + 1) / minCandidates.length);
    if (i % 2 === 1) await new Promise(resolve => setTimeout(resolve, 0));
  }

  return { ...best, mask: bestMask };
}

function compactObjective(objective) {
  return {
    mode: objective.objectiveMode,
    score: objective.score,
    positiveRecall: objective.positiveRecall,
    negativeLeakage: objective.negativeLeakage,
    macroNegativeLeakage: objective.macroNegativeLeakage ?? objective.negativeLeakage,
    negativeRegionCount: objective.negativeRegionCount ?? 0,
    labelF1Proxy: objective.labelF1,
    roiPrecision: objective.roiPrecision,
    roiRecall: objective.roiRecall,
    roiF1: objective.roiF1,
  };
}

export async function autoTuneBoundary(features, referenceCenterline, options = {}) {
  const tolerance = options.tolerance ?? 4;
  const onProgress = options.onProgress ?? (() => {});
  const maxRounds = clampInt(options.maxRounds ?? 3, 1, 3);
  const current = {
    sensitivity: clampInt(options.current?.sensitivity ?? 62, 1, 100),
    darkWeight: clampInt(options.current?.darkWeight ?? 15, 0, 100),
    ridgeWeight: clampInt(options.current?.ridgeWeight ?? 40, 0, 100),
    colorWeight: clampInt(options.current?.colorWeight ?? 25, 0, 100),
    dendriteWeight: clampInt(options.current?.dendriteWeight ?? 20, 0, 100),
    minComponent: clampInt(options.current?.minComponent ?? 24, 1, 300),
  };

  const helpers = buildFastEvaluationHelpers(
    referenceCenterline,
    features.width,
    features.height,
    tolerance,
    options.negativeMask ?? null,
    options.exclusionMask ?? null,
    options.fullEvaluationRois ?? null,
  );
  if (helpers.referenceIndices.length === 0) throw new Error("お手本線がありません。");
  if (helpers.objectiveMode === "complete-roi-f1" && helpers.roiReferenceIndices.length === 0) {
    throw new Error("完全評価ROI内に粒界お手本線がありません。");
  }

  const search = {
    version: 2,
    strategy: "coordinate-descent",
    objectiveMode: helpers.objectiveMode,
    rounds: [],
    ablation: [],
  };

  const totalPhases = 1 + maxRounds * 6 + 1;
  let completedPhases = 0;
  const phaseProgress = localRatio => {
    onProgress(Math.min(0.98, (completedPhases + localRatio) / totalPhases));
  };

  let globalBest = await optimizeMinComponent(
    features,
    referenceCenterline,
    current,
    options,
    helpers,
    ratio => phaseProgress(ratio),
  );
  completedPhases += 1;
  search.baseline = {
    parameters: { ...globalBest.parameters },
    objective: compactObjective(globalBest),
  };
  onProgress(completedPhases / totalPhases);

  let working = { ...globalBest.parameters };
  const coordinates = ["sensitivity", "darkWeight", "ridgeWeight", "colorWeight", "dendriteWeight"];

  for (let round = 0; round < maxRounds; round += 1) {
    const roundTrace = {
      round: round + 1,
      startParameters: { ...working },
      coordinates: [],
    };
    let anyCoordinateChanged = false;

    for (const coordinate of coordinates) {
      const values = coordinateCandidates(coordinate, working[coordinate], round);
      let bestRaw = null;
      const candidates = [];

      for (let i = 0; i < values.length; i += 1) {
        const candidateConfig = { ...working, [coordinate]: values[i] };
        const objective = evaluateRawConfiguration(features, helpers, candidateConfig);
        const candidate = {
          ...objective,
          parameters: candidateConfig,
        };
        candidates.push({
          value: values[i],
          ...compactObjective(candidate),
        });
        if (betterTuneScore(candidate, bestRaw)) bestRaw = candidate;
        phaseProgress((i + 1) / values.length);
      }

      const previousValue = working[coordinate];
      working = { ...working, [coordinate]: bestRaw.parameters[coordinate] };
      if (working[coordinate] !== previousValue) anyCoordinateChanged = true;
      roundTrace.coordinates.push({
        name: coordinate,
        previousValue,
        selectedValue: working[coordinate],
        candidates,
      });
      completedPhases += 1;
      onProgress(completedPhases / totalPhases);
      await new Promise(resolve => setTimeout(resolve, 0));
    }

    const processed = await optimizeMinComponent(
      features,
      referenceCenterline,
      working,
      options,
      helpers,
      ratio => phaseProgress(ratio),
    );
    completedPhases += 1;
    roundTrace.processed = {
      parameters: { ...processed.parameters },
      objective: compactObjective(processed),
    };

    if (betterTuneScore(processed, globalBest)) {
      globalBest = processed;
      working = { ...processed.parameters };
      roundTrace.accepted = true;
    } else {
      working = { ...globalBest.parameters };
      roundTrace.accepted = false;
      roundTrace.revertedTo = { ...working };
    }
    search.rounds.push(roundTrace);
    onProgress(completedPhases / totalPhases);

    if (!anyCoordinateChanged && !roundTrace.accepted) break;
  }

  const ablations = [
    ["full", null],
    ["-Dark", "darkWeight"],
    ["-Ridge", "ridgeWeight"],
    ["-Color", "colorWeight"],
    ["-Dendrite", "dendriteWeight"],
  ];
  for (let i = 0; i < ablations.length; i += 1) {
    const [label, feature] = ablations[i];
    const config = { ...globalBest.parameters };
    if (feature) config[feature] = 0;
    const objective = evaluateRawConfiguration(features, helpers, config);
    search.ablation.push({
      label,
      disabledFeature: feature,
      parameters: {
        darkWeight: config.darkWeight,
        ridgeWeight: config.ridgeWeight,
        colorWeight: config.colorWeight,
        dendriteWeight: config.dendriteWeight,
      },
      objective: compactObjective(objective),
    });
    phaseProgress((i + 1) / ablations.length);
  }
  completedPhases += 1;

  const metrics = computeRegionalMetrics(
    globalBest.mask,
    referenceCenterline,
    features.width,
    features.height,
    {
      tolerance,
      reviewRadius: options.reviewRadius ?? 18,
      negativeMask: options.negativeMask ?? null,
      exclusionMask: options.exclusionMask ?? null,
      cols: 4,
      rows: 4,
    },
  );
  search.final = {
    parameters: { ...globalBest.parameters },
    objective: compactObjective(globalBest),
  };
  onProgress(1);

  return {
    parameters: { ...globalBest.parameters },
    metrics,
    roiMetrics: globalBest.roiMetrics ?? null,
    mask: globalBest.mask,
    search,
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

    if (metrics.exclusionMask?.[p]) continue;

    if (metrics.referenceTolerance[p]) {
      rgba[i] = 255;
      rgba[i + 1] = 216;
      rgba[i + 2] = 74;
      rgba[i + 3] = Math.round(alpha * 0.24);
    } else if (metrics.negativeMask?.[p]) {
      rgba[i] = 255;
      rgba[i + 1] = 138;
      rgba[i + 2] = 0;
      rgba[i + 3] = Math.round(alpha * 0.24);
    }

    if (!metrics.evaluationMask[p]) {
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
