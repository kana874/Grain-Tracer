function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function colorDistance(data, i1, i2) {
  const dr = data[i1] - data[i2];
  const dg = data[i1 + 1] - data[i2 + 1];
  const db = data[i1 + 2] - data[i2 + 2];
  return Math.sqrt(dr * dr + dg * dg + db * db) / 441.67295593;
}

function luminance(data, index) {
  return (0.2126 * data[index] + 0.7152 * data[index + 1] + 0.0722 * data[index + 2]) / 255;
}

function thresholdFromSensitivity(sensitivity) {
  return 0.74 - (sensitivity / 100) * 0.46;
}

function normalizeWeights(darkWeightRaw, colorWeightRaw) {
  const total = Math.max(1, darkWeightRaw + colorWeightRaw);
  return {
    dark: darkWeightRaw / total,
    color: colorWeightRaw / total,
  };
}

function scoreAt(features, pixel, darkWeightRaw, colorWeightRaw) {
  const weights = normalizeWeights(darkWeightRaw, colorWeightRaw);
  return (features.dark[pixel] / 255) * weights.dark
    + (features.color[pixel] / 255) * weights.color;
}

export async function computeBoundaryFeatures(imageData, options = {}) {
  const { width, height, data } = imageData;
  const onProgress = options.onProgress ?? (() => {});
  const radius = options.radius ?? Math.max(1, Math.round(Math.min(width, height) / 700));
  const size = width * height;
  const dark = new Uint8Array(size);
  const color = new Uint8Array(size);

  for (let y = radius; y < height - radius; y += 1) {
    for (let x = radius; x < width - radius; x += 1) {
      const pixel = y * width + x;
      const i = pixel * 4;
      const left = (y * width + (x - radius)) * 4;
      const right = (y * width + (x + radius)) * 4;
      const up = ((y - radius) * width + x) * 4;
      const down = ((y + radius) * width + x) * 4;

      const centerLuma = luminance(data, i);
      const leftLuma = luminance(data, left);
      const rightLuma = luminance(data, right);
      const upLuma = luminance(data, up);
      const downLuma = luminance(data, down);

      // A true Barker grain boundary is usually a narrow dark ridge between two
      // brighter neighborhoods. Absolute darkness alone over-detects pits and
      // short intragranular marks, so ridge evidence receives most of the weight.
      const absoluteDark = clamp01((0.66 - centerLuma) / 0.56);
      const ridgeLR = clamp01((((leftLuma + rightLuma) * 0.5) - centerLuma) / 0.22);
      const ridgeUD = clamp01((((upLuma + downLuma) * 0.5) - centerLuma) / 0.22);
      const ridge = Math.max(ridgeLR, ridgeUD);
      const darkLine = clamp01(absoluteDark * 0.28 + ridge * 0.72);

      const crossColor = Math.max(
        colorDistance(data, left, right),
        colorDistance(data, up, down),
      );

      dark[pixel] = Math.round(darkLine * 255);
      color[pixel] = Math.round(clamp01(crossColor) * 255);
    }

    if (y % 50 === 0 || y === height - radius - 1) {
      onProgress((y - radius + 1) / Math.max(1, height - radius * 2));
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }

  return { width, height, radius, dark, color };
}

export function buildRawBoundaryMask(features, options = {}) {
  const sensitivity = options.sensitivity ?? 58;
  const darkWeightRaw = options.darkWeight ?? 65;
  const colorWeightRaw = options.colorWeight ?? 35;
  const threshold = thresholdFromSensitivity(sensitivity);
  const weights = normalizeWeights(darkWeightRaw, colorWeightRaw);
  const mask = new Uint8Array(features.width * features.height);

  for (let p = 0; p < mask.length; p += 1) {
    const score = (features.dark[p] / 255) * weights.dark
      + (features.color[p] / 255) * weights.color;
    if (score >= threshold) mask[p] = 1;
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
  onProgress(0.1);
  await new Promise(resolve => setTimeout(resolve, 0));
  const raw = buildRawBoundaryMask(features, options);
  onProgress(0.45);
  await new Promise(resolve => setTimeout(resolve, 0));
  const result = applyMinComponent(
    raw,
    features.width,
    features.height,
    options.minComponent ?? 24,
  );
  onProgress(1);
  return result;
}

export async function extractBoundaryCandidates(imageData, options = {}) {
  const onProgress = options.onProgress ?? (() => {});
  const features = await computeBoundaryFeatures(imageData, {
    onProgress: ratio => onProgress(ratio * 0.6),
  });
  return buildBoundaryMask(features, {
    ...options,
    onProgress: ratio => onProgress(0.6 + ratio * 0.4),
  });
}

export function dilateBinaryMask(mask, width, height, radius) {
  if (radius <= 0) return mask.slice();
  const horizontal = new Uint8Array(mask.length);
  const output = new Uint8Array(mask.length);
  const r = Math.max(1, Math.round(radius));

  for (let y = 0; y < height; y += 1) {
    let sum = 0;
    const base = y * width;
    for (let x = 0; x <= Math.min(width - 1, r); x += 1) sum += mask[base + x];
    for (let x = 0; x < width; x += 1) {
      horizontal[base + x] = sum > 0 ? 1 : 0;
      const removeX = x - r;
      const addX = x + r + 1;
      if (removeX >= 0) sum -= mask[base + removeX];
      if (addX < width) sum += mask[base + addX];
    }
  }

  for (let x = 0; x < width; x += 1) {
    let sum = 0;
    for (let y = 0; y <= Math.min(height - 1, r); y += 1) sum += horizontal[y * width + x];
    for (let y = 0; y < height; y += 1) {
      output[y * width + x] = sum > 0 ? 1 : 0;
      const removeY = y - r;
      const addY = y + r + 1;
      if (removeY >= 0) sum -= horizontal[removeY * width + x];
      if (addY < height) sum += horizontal[addY * width + x];
    }
  }

  return output;
}

export function compareBoundaryMasks(prediction, reference, width, height, options = {}) {
  const tolerance = options.tolerance ?? 4;
  const reviewRadius = Math.max(tolerance + 1, options.reviewRadius ?? 18);
  const referenceTolerance = dilateBinaryMask(reference, width, height, tolerance);
  const reviewMask = dilateBinaryMask(reference, width, height, reviewRadius);
  const predictionTolerance = dilateBinaryMask(prediction, width, height, tolerance);

  let matchedPrediction = 0;
  let falsePositive = 0;
  let matchedReference = 0;
  let falseNegative = 0;
  let referencePixels = 0;
  let reviewedPredictionPixels = 0;

  for (let p = 0; p < reference.length; p += 1) {
    if (reference[p]) {
      referencePixels += 1;
      if (predictionTolerance[p]) matchedReference += 1;
      else falseNegative += 1;
    }

    if (reviewMask[p] && prediction[p]) {
      reviewedPredictionPixels += 1;
      if (referenceTolerance[p]) matchedPrediction += 1;
      else falsePositive += 1;
    }
  }

  const precisionDen = matchedPrediction + falsePositive;
  const recallDen = matchedReference + falseNegative;
  const precision = precisionDen ? matchedPrediction / precisionDen : 0;
  const recall = recallDen ? matchedReference / recallDen : 0;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;

  return {
    precision,
    recall,
    f1,
    matchedPrediction,
    falsePositive,
    matchedReference,
    falseNegative,
    referencePixels,
    reviewedPredictionPixels,
    referenceTolerance,
    reviewMask,
    predictionTolerance,
  };
}

function evaluateRawConfiguration(features, reference, helpers, config) {
  const { referenceIndices, reviewIndices, referenceTolerance, tolerance } = helpers;
  const threshold = thresholdFromSensitivity(config.sensitivity);
  const weights = normalizeWeights(config.darkWeight, config.colorWeight);
  const isPred = (p) => ((features.dark[p] / 255) * weights.dark
    + (features.color[p] / 255) * weights.color) >= threshold;

  let matchedPrediction = 0;
  let falsePositive = 0;

  for (const p of reviewIndices) {
    if (!isPred(p)) continue;
    if (referenceTolerance[p]) matchedPrediction += 1;
    else falsePositive += 1;
  }

  let matchedReference = 0;
  let falseNegative = 0;
  const width = features.width;
  const height = features.height;

  for (const p of referenceIndices) {
    const x = p % width;
    const y = Math.floor(p / width);
    let found = false;
    for (let dy = -tolerance; dy <= tolerance && !found; dy += 1) {
      const ny = y + dy;
      if (ny < 0 || ny >= height) continue;
      for (let dx = -tolerance; dx <= tolerance; dx += 1) {
        const nx = x + dx;
        if (nx < 0 || nx >= width) continue;
        if (isPred(ny * width + nx)) {
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

function buildEvaluationHelpers(reference, width, height, tolerance, reviewRadius) {
  const referenceTolerance = dilateBinaryMask(reference, width, height, tolerance);
  const reviewMask = dilateBinaryMask(reference, width, height, reviewRadius);
  const referenceIndices = [];
  const reviewIndices = [];

  for (let p = 0; p < reference.length; p += 1) {
    if (reference[p]) referenceIndices.push(p);
    if (reviewMask[p]) reviewIndices.push(p);
  }

  return { referenceTolerance, reviewMask, referenceIndices, reviewIndices, tolerance };
}

function uniqueSorted(values) {
  return [...new Set(values.map(value => Math.max(1, Math.min(100, Math.round(value)))))]
    .sort((a, b) => a - b);
}

function betterScore(candidate, best) {
  if (!best) return true;
  if (candidate.f1 !== best.f1) return candidate.f1 > best.f1;
  if (candidate.recall !== best.recall) return candidate.recall > best.recall;
  return candidate.precision > best.precision;
}

export async function autoTuneBoundary(features, reference, options = {}) {
  const tolerance = options.tolerance ?? 4;
  const reviewRadius = Math.max(tolerance + 1, options.reviewRadius ?? 18);
  const onProgress = options.onProgress ?? (() => {});
  const current = options.current ?? {
    sensitivity: 58,
    darkWeight: 65,
    colorWeight: 35,
    minComponent: 24,
  };

  const helpers = buildEvaluationHelpers(
    reference,
    features.width,
    features.height,
    tolerance,
    reviewRadius,
  );

  if (helpers.referenceIndices.length === 0) {
    throw new Error("お手本線がありません。");
  }

  const sensitivityCandidates = uniqueSorted([
    current.sensitivity - 24,
    current.sensitivity - 12,
    current.sensitivity,
    current.sensitivity + 12,
    current.sensitivity + 24,
    38, 50, 62, 74, 86,
  ]);
  const darkCandidates = uniqueSorted([
    current.darkWeight - 25,
    current.darkWeight - 12,
    current.darkWeight,
    current.darkWeight + 12,
    current.darkWeight + 25,
    35, 50, 65, 80, 92,
  ]);

  let bestRaw = null;
  const totalRaw = sensitivityCandidates.length * darkCandidates.length;
  let rawStep = 0;

  for (const sensitivity of sensitivityCandidates) {
    for (const darkWeight of darkCandidates) {
      const colorWeight = 100 - darkWeight;
      const metrics = evaluateRawConfiguration(features, reference, helpers, {
        sensitivity,
        darkWeight,
        colorWeight,
      });
      const candidate = { sensitivity, darkWeight, colorWeight, ...metrics };
      if (betterScore(candidate, bestRaw)) bestRaw = candidate;
      rawStep += 1;
      if (rawStep % 4 === 0 || rawStep === totalRaw) {
        onProgress((rawStep / totalRaw) * 0.62);
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }
  }

  const rawMask = buildRawBoundaryMask(features, bestRaw);
  const supported = neighborSupport(rawMask, features.width, features.height);
  onProgress(0.7);
  await new Promise(resolve => setTimeout(resolve, 0));
  const componentSizes = computeComponentSizeMap(supported, features.width, features.height);
  onProgress(0.78);
  await new Promise(resolve => setTimeout(resolve, 0));

  const minCandidates = [...new Set([
    1, 4, 8, 16, 24, 40, 64, 96, 128, 192, 256,
    Math.round(current.minComponent),
  ])].filter(value => value >= 1 && value <= 300).sort((a, b) => a - b);

  let bestFinal = null;
  let bestMask = null;

  for (let i = 0; i < minCandidates.length; i += 1) {
    const minComponent = minCandidates[i];
    const mask = new Uint8Array(supported.length);
    for (let p = 0; p < mask.length; p += 1) {
      if (supported[p] && componentSizes[p] >= minComponent) mask[p] = 1;
    }

    const metrics = compareBoundaryMasks(mask, reference, features.width, features.height, {
      tolerance,
      reviewRadius,
    });
    const candidate = {
      sensitivity: bestRaw.sensitivity,
      darkWeight: bestRaw.darkWeight,
      colorWeight: bestRaw.colorWeight,
      minComponent,
      precision: metrics.precision,
      recall: metrics.recall,
      f1: metrics.f1,
    };

    if (betterScore(candidate, bestFinal)) {
      bestFinal = candidate;
      bestMask = mask;
    }

    onProgress(0.78 + ((i + 1) / minCandidates.length) * 0.22);
    await new Promise(resolve => setTimeout(resolve, 0));
  }

  const finalMetrics = compareBoundaryMasks(
    bestMask,
    reference,
    features.width,
    features.height,
    { tolerance, reviewRadius },
  );

  return {
    parameters: {
      sensitivity: bestFinal.sensitivity,
      darkWeight: bestFinal.darkWeight,
      colorWeight: bestFinal.colorWeight,
      minComponent: bestFinal.minComponent,
    },
    metrics: finalMetrics,
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

export function renderComparisonOverlay(prediction, reference, width, height, options = {}) {
  const opacity = (options.opacity ?? 90) / 100;
  const metrics = compareBoundaryMasks(prediction, reference, width, height, options);
  const rgba = new Uint8ClampedArray(width * height * 4);
  const alpha = Math.round(255 * opacity);

  for (let p = 0; p < prediction.length; p += 1) {
    if (!metrics.reviewMask[p]) {
      if (prediction[p]) {
        const i = p * 4;
        rgba[i] = 35;
        rgba[i + 1] = 245;
        rgba[i + 2] = 222;
        rgba[i + 3] = Math.round(alpha * 0.28);
      }
      continue;
    }

    const i = p * 4;
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

    if (reference[p] && !metrics.predictionTolerance[p]) {
      rgba[i] = 255;
      rgba[i + 1] = 216;
      rgba[i + 2] = 74;
      rgba[i + 3] = 255;
    }
  }

  return { imageData: new ImageData(rgba, width, height), metrics };
}
