import { computeRegionalMetrics, dilateBinaryMask, splitReferenceCenterline } from "./evaluation.js";

function quantile(sorted, q) {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  const t = pos - lo;
  return sorted[lo] * (1 - t) + sorted[hi] * t;
}

function summarizeValues(values) {
  if (!values.length) {
    return { count: 0, mean: 0, std: 0, p10: 0, p25: 0, p50: 0, p75: 0, p90: 0 };
  }
  values.sort((a, b) => a - b);
  let sum = 0;
  let sumSq = 0;
  for (const value of values) {
    sum += value;
    sumSq += value * value;
  }
  const mean = sum / values.length;
  const variance = Math.max(0, sumSq / values.length - mean * mean);
  return {
    count: values.length,
    mean,
    std: Math.sqrt(variance),
    p10: quantile(values, 0.10),
    p25: quantile(values, 0.25),
    p50: quantile(values, 0.50),
    p75: quantile(values, 0.75),
    p90: quantile(values, 0.90),
  };
}

function featureStatistics(features, selector) {
  const result = {};
  for (const name of ["dark", "ridge", "color", "dendrite"]) {
    const source = features[name];
    if (!source) continue;
    const values = [];
    for (let p = 0; p < selector.length; p += 1) {
      if (selector[p]) values.push(source[p] / 255);
    }
    result[name] = summarizeValues(values);
  }
  return result;
}

function buildErrorMasks(prediction, referenceCenterline, width, height, options) {
  const metrics = computeRegionalMetrics(
    prediction,
    referenceCenterline,
    width,
    height,
    {
      ...options,
      cols: 4,
      rows: 4,
    },
  );
  const tp = new Uint8Array(prediction.length);
  const fp = new Uint8Array(prediction.length);
  const fn = new Uint8Array(prediction.length);
  const negativeViolation = new Uint8Array(prediction.length);

  for (let p = 0; p < prediction.length; p += 1) {
    if (metrics.exclusionMask?.[p]) continue;
    if (prediction[p] && metrics.evaluationMask[p]) {
      if (metrics.referenceTolerance[p]) {
        tp[p] = 1;
      } else {
        fp[p] = 1;
        if (metrics.negativeMask?.[p]) negativeViolation[p] = 1;
      }
    }
    if (referenceCenterline[p] && !metrics.predictionTolerance[p]) fn[p] = 1;
  }
  return { tp, fp, fn, negativeViolation, metrics };
}

function hotspotComponents(mask, width, height, features, type, limit = 16) {
  const visited = new Uint8Array(mask.length);
  const queue = new Int32Array(mask.length);
  const components = [];

  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || visited[start]) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    visited[start] = 1;
    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;
    let dark = 0;
    let ridge = 0;
    let color = 0;
    let dendrite = 0;

    while (head < tail) {
      const p = queue[head++];
      const x = p % width;
      const y = Math.floor(p / width);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      dark += features.dark[p] / 255;
      ridge += features.ridge[p] / 255;
      color += features.color[p] / 255;
      dendrite += (features.dendrite?.[p] ?? 0) / 255;

      for (let dy = -1; dy <= 1; dy += 1) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const np = ny * width + nx;
          if (mask[np] && !visited[np]) {
            visited[np] = 1;
            queue[tail++] = np;
          }
        }
      }
    }

    components.push({
      type,
      pixels: tail,
      x: minX,
      y: minY,
      width: maxX - minX + 1,
      height: maxY - minY + 1,
      meanFeatures: {
        dark: dark / tail,
        ridge: ridge / tail,
        color: color / tail,
        dendrite: dendrite / tail,
      },
    });
  }

  components.sort((a, b) => b.pixels - a.pixels);
  return components.slice(0, limit);
}

function regionFeatureSummary(features, width, region) {
  let count = 0;
  let dark = 0;
  let ridge = 0;
  let color = 0;
  let dendrite = 0;
  for (let y = region.y0; y < region.y1; y += 1) {
    const base = y * width;
    for (let x = region.x0; x < region.x1; x += 1) {
      const p = base + x;
      count += 1;
      dark += features.dark[p] / 255;
      ridge += features.ridge[p] / 255;
      color += features.color[p] / 255;
      dendrite += (features.dendrite?.[p] ?? 0) / 255;
    }
  }
  const den = Math.max(1, count);
  return {
    darkMean: dark / den,
    ridgeMean: ridge / den,
    colorMean: color / den,
    dendriteMean: dendrite / den,
  };
}

function compactHistory(history) {
  return (history ?? []).slice(-40).map(item => ({
    timestamp: item.timestamp,
    kind: item.kind,
    algorithmVersion: item.algorithmVersion,
    parameters: item.parameters,
    local: item.local,
    localCalibration: item.localCalibration,
    metrics: item.metrics ? {
      precision: item.metrics.precision,
      recall: item.metrics.recall,
      f1: item.metrics.f1,
      matchedPrediction: item.metrics.matchedPrediction,
      falsePositive: item.metrics.falsePositive,
      matchedReference: item.metrics.matchedReference,
      falseNegative: item.metrics.falseNegative,
      negativePrediction: item.metrics.negativePrediction ?? 0,
      negativePixels: item.metrics.negativePixels ?? 0,
      negativeHitRate: item.metrics.negativeHitRate ?? 0,
      excludedPixels: item.metrics.excludedPixels ?? 0,
    } : null,
    note: item.note ?? "",
  }));
}

export function buildDiagnosticReport(input) {
  const {
    source,
    preview,
    settings,
    features,
    prediction,
    referenceCenterline,
    negativeMask,
    negativeCenterline,
    exclusionMask,
    exclusionRects,
    localCalibration,
    history,
    algorithmVersion,
    appVersion,
  } = input;

  const comparison = settings.comparison;
  const metrics = computeRegionalMetrics(
    prediction,
    referenceCenterline,
    preview.width,
    preview.height,
    {
      tolerance: comparison.tolerance,
      reviewRadius: comparison.reviewRadius,
      negativeMask,
      exclusionMask,
      cols: 4,
      rows: 4,
    },
  );
  const masks = buildErrorMasks(
    prediction,
    referenceCenterline,
    preview.width,
    preview.height,
    {
      ...comparison,
      negativeMask,
      exclusionMask,
    },
  );

  const regionsWithReference = metrics.regions.filter(region => region.referencePixels > 0);
  const macroRegionF1 = regionsWithReference.length
    ? regionsWithReference.reduce((sum, region) => sum + region.f1, 0) / regionsWithReference.length
    : 0;

  const split = splitReferenceCenterline(
    referenceCenterline,
    preview.width,
    preview.height,
    { validationFraction: 0.20, minComponentPixels: 8 },
  );
  const negativeSplit = negativeCenterline
    ? splitReferenceCenterline(
      negativeCenterline,
      preview.width,
      preview.height,
      { validationFraction: 0.20, minComponentPixels: 8 },
    )
    : null;
  const tuningNegativeMask = negativeSplit?.validationPixels > 0
    ? dilateBinaryMask(negativeSplit.tuneMask, preview.width, preview.height, comparison.tolerance)
    : negativeMask;
  const validationNegativeMask = negativeSplit?.validationPixels > 0
    ? dilateBinaryMask(negativeSplit.validationMask, preview.width, preview.height, comparison.tolerance)
    : null;
  const tuningMetrics = computeRegionalMetrics(
    prediction,
    split.tuneMask,
    preview.width,
    preview.height,
    {
      tolerance: comparison.tolerance,
      reviewRadius: comparison.reviewRadius,
      negativeMask: tuningNegativeMask,
      exclusionMask,
      cols: 4,
      rows: 4,
    },
  );
  const validationMetrics = split.validationPixels > 0
    ? computeRegionalMetrics(
      prediction,
      split.validationMask,
      preview.width,
      preview.height,
      {
        tolerance: comparison.tolerance,
        reviewRadius: comparison.reviewRadius,
        negativeMask: validationNegativeMask,
        exclusionMask,
        cols: 4,
        rows: 4,
      },
    )
    : null;

  const regions = metrics.regions.map(region => ({
    rx: region.rx,
    ry: region.ry,
    x0: region.x0,
    y0: region.y0,
    x1: region.x1,
    y1: region.y1,
    referencePixels: region.referencePixels,
    negativePixels: region.negativePixels ?? 0,
    negativePrediction: region.negativePrediction ?? 0,
    negativeHitRate: region.negativeHitRate ?? 0,
    excludedPixels: region.excludedPixels ?? 0,
    precision: region.precision,
    recall: region.recall,
    f1: region.f1,
    ...regionFeatureSummary(features, preview.width, region),
  }));

  return {
    schema: "graintracer-diagnostic-v2",
    generatedAt: new Date().toISOString(),
    appVersion,
    algorithmVersion,
    source,
    preview: {
      width: preview.width,
      height: preview.height,
      scale: preview.scale,
    },
    settings,
    algorithmInternals: {
      ridgeScales: [1, 2, 4],
      colorSampleDistances: [2, 4, 6],
      dendriteTensorRadius: 7,
      dendriteSampleDistances: [5, 9, 13],
      neighborSupportMinimum: 2,
      localCalibrationGrid: "4x4",
    },
    localCalibration: localCalibration ?? null,
    evaluation: {
      precision: metrics.precision,
      recall: metrics.recall,
      f1: metrics.f1,
      macroRegionF1,
      matchedPrediction: metrics.matchedPrediction,
      falsePositive: metrics.falsePositive,
      matchedReference: metrics.matchedReference,
      falseNegative: metrics.falseNegative,
      negativePrediction: metrics.negativePrediction,
      negativePixels: metrics.negativePixels,
      negativeHitRate: metrics.negativeHitRate,
      excludedPixels: metrics.excludedPixels,
      tuning: {
        precision: tuningMetrics.precision,
        recall: tuningMetrics.recall,
        f1: tuningMetrics.f1,
        negativePrediction: tuningMetrics.negativePrediction,
        negativePixels: tuningMetrics.negativePixels,
        negativeHitRate: tuningMetrics.negativeHitRate,
      },
      validation: validationMetrics ? {
        precision: validationMetrics.precision,
        recall: validationMetrics.recall,
        f1: validationMetrics.f1,
        negativePrediction: validationMetrics.negativePrediction,
        negativePixels: validationMetrics.negativePixels,
        negativeHitRate: validationMetrics.negativeHitRate,
      } : null,
    },
    validationSplit: {
      mode: split.mode,
      componentCount: split.componentCount,
      tuningPixels: split.tuningPixels,
      validationPixels: split.validationPixels,
      validationFraction: split.validationFraction,
      negative: negativeSplit ? {
        mode: negativeSplit.mode,
        componentCount: negativeSplit.componentCount,
        tuningPixels: negativeSplit.tuningPixels,
        validationPixels: negativeSplit.validationPixels,
        validationFraction: negativeSplit.validationFraction,
      } : null,
    },
    referenceCoverage: {
      regionsWithReference: regionsWithReference.length,
      totalRegions: metrics.regions.length,
      referencePixels: metrics.referencePixels,
      reviewedPredictionPixels: metrics.reviewedPredictionPixels,
      nonBoundaryPixels: metrics.negativePixels,
      nonBoundaryPredictionPixels: metrics.negativePrediction,
      exclusionRectCount: (exclusionRects ?? []).length,
      excludedPixels: metrics.excludedPixels,
    },
    featureStatistics: {
      truePositive: featureStatistics(features, masks.tp),
      falsePositive: featureStatistics(features, masks.fp),
      falseNegative: featureStatistics(features, masks.fn),
      nonBoundaryReference: negativeMask ? featureStatistics(features, negativeMask) : {},
      nonBoundaryViolation: featureStatistics(features, masks.negativeViolation),
    },
    annotations: {
      nonBoundaryCenterlinePixels: negativeCenterline
        ? negativeCenterline.reduce((sum, value) => sum + (value ? 1 : 0), 0)
        : 0,
      nonBoundaryMaskPixels: negativeMask
        ? negativeMask.reduce((sum, value) => sum + (value ? 1 : 0), 0)
        : 0,
      exclusionRects: (exclusionRects ?? []).map(rect => ({ ...rect })),
      excludedPixels: exclusionMask
        ? exclusionMask.reduce((sum, value) => sum + (value ? 1 : 0), 0)
        : 0,
    },
    regions,
    hotspots: [
      ...hotspotComponents(masks.fp, preview.width, preview.height, features, "falsePositive"),
      ...hotspotComponents(masks.fn, preview.width, preview.height, features, "falseNegative"),
      ...hotspotComponents(masks.negativeViolation, preview.width, preview.height, features, "nonBoundaryViolation"),
    ].sort((a, b) => b.pixels - a.pixels).slice(0, 24),
    tuningTrace: compactHistory(history),
    notes: [
      "Feature values are normalized to 0..1.",
      "False-positive statistics use predicted pixels inside the positive review area or user-labelled non-boundary area, excluding exclusion regions.",
      "Non-boundary reference pixels are explicit negative examples; predictions inside them count as false positives.",
      "Exclusion rectangles are removed from both boundary output and evaluation.",
      "False-negative statistics use reference centerline pixels without a prediction inside the judgement radius.",
      "Dendrite statistics represent cross-boundary orientation/coherence change estimated from a local structure tensor.",
    ],
  };
}

export function featureMapImageData(feature, width, height) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let p = 0; p < feature.length; p += 1) {
    const value = feature[p];
    const i = p * 4;
    rgba[i] = value;
    rgba[i + 1] = value;
    rgba[i + 2] = value;
    rgba[i + 3] = 255;
  }
  return new ImageData(rgba, width, height);
}

export function downloadJson(value, fileName) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });
  downloadBlob(blob, fileName);
}

export function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

export async function imageDataToBlob(imageData, type = "image/png", quality = 0.92) {
  const canvas = document.createElement("canvas");
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  canvas.getContext("2d").putImageData(imageData, 0, 0);
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("画像の書き出しに失敗しました。")), type, quality);
  });
}
