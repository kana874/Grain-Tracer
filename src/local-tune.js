import { dilateBinaryMask } from "./evaluation.js";

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function thresholdFromSensitivity(sensitivity) {
  return 0.76 - (sensitivity / 100) * 0.50;
}

function normalizedWeights(options) {
  const dark = options.darkWeight ?? 15;
  const ridge = options.ridgeWeight ?? 40;
  const color = options.colorWeight ?? 25;
  const dendrite = options.dendriteWeight ?? 20;
  const total = Math.max(1, dark + ridge + color + dendrite);
  return {
    dark: dark / total,
    ridge: ridge / total,
    color: color / total,
    dendrite: dendrite / total,
  };
}

function featureScore(features, p, weights) {
  return (features.dark[p] / 255) * weights.dark
    + (features.ridge[p] / 255) * weights.ridge
    + (features.color[p] / 255) * weights.color
    + ((features.dendrite?.[p] ?? 0) / 255) * weights.dendrite;
}

function buildRegionBounds(width, height, cols, rows, rx, ry) {
  return {
    x0: Math.floor(rx * width / cols),
    x1: Math.floor((rx + 1) * width / cols),
    y0: Math.floor(ry * height / rows),
    y1: Math.floor((ry + 1) * height / rows),
  };
}

function evaluateRegionSensitivity(features, reference, helpers, bounds, sensitivity, options) {
  const threshold = thresholdFromSensitivity(sensitivity);
  const weights = options.weights;
  const tolerance = helpers.tolerance;
  let matchedPrediction = 0;
  let falsePositive = 0;
  let matchedReference = 0;
  let falseNegative = 0;

  for (let y = bounds.y0; y < bounds.y1; y += 1) {
    const base = y * features.width;
    for (let x = bounds.x0; x < bounds.x1; x += 1) {
      const p = base + x;
      if (helpers.exclusionMask?.[p] || !helpers.evaluationMask[p]) continue;
      if (featureScore(features, p, weights) < threshold) continue;
      if (helpers.referenceTolerance[p]) matchedPrediction += 1;
      else falsePositive += 1;
    }
  }

  for (let y = bounds.y0; y < bounds.y1; y += 1) {
    const base = y * features.width;
    for (let x = bounds.x0; x < bounds.x1; x += 1) {
      const p = base + x;
      if (!reference[p] || helpers.exclusionMask?.[p]) continue;
      let found = false;
      for (let dy = -tolerance; dy <= tolerance && !found; dy += 1) {
        const ny = y + dy;
        if (ny < 0 || ny >= features.height) continue;
        for (let dx = -tolerance; dx <= tolerance; dx += 1) {
          const nx = x + dx;
          if (nx < 0 || nx >= features.width) continue;
          const np = ny * features.width + nx;
          if (helpers.exclusionMask?.[np]) continue;
          if (featureScore(features, np, weights) >= threshold) {
            found = true;
            break;
          }
        }
      }
      if (found) matchedReference += 1;
      else falseNegative += 1;
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
    referencePixels: matchedReference + falseNegative,
  };
}

function smoothMeasuredGrid(raw, measured, cols, rows) {
  const out = new Float32Array(raw.length);
  for (let ry = 0; ry < rows; ry += 1) {
    for (let rx = 0; rx < cols; rx += 1) {
      const index = ry * cols + rx;
      let weighted = 0;
      // Zero is the global-setting prior. This prevents one annotated region from
      // imposing the same sensitivity correction on the entire image.
      let weightSum = measured[index] ? 0.35 : 1.8;
      for (let sy = 0; sy < rows; sy += 1) {
        for (let sx = 0; sx < cols; sx += 1) {
          const si = sy * cols + sx;
          if (!measured[si]) continue;
          const distance = Math.hypot(rx - sx, ry - sy);
          const weight = measured[index] && si === index
            ? 4
            : 1 / ((distance + 0.75) ** 2);
          weighted += raw[si] * weight;
          weightSum += weight;
        }
      }
      out[index] = weightSum ? weighted / weightSum : 0;
    }
  }

  const smoothed = new Float32Array(out.length);
  for (let ry = 0; ry < rows; ry += 1) {
    for (let rx = 0; rx < cols; rx += 1) {
      let sum = 0;
      let count = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        const ny = ry + dy;
        if (ny < 0 || ny >= rows) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = rx + dx;
          if (nx < 0 || nx >= cols) continue;
          const w = dx === 0 && dy === 0 ? 2 : 1;
          sum += out[ny * cols + nx] * w;
          count += w;
        }
      }
      smoothed[ry * cols + rx] = count ? sum / count : 0;
    }
  }
  return smoothed;
}

export function interpolateSensitivityDelta(calibration, x, y, width, height) {
  if (!calibration?.values?.length) return 0;
  const { cols, rows, values } = calibration;
  const gx = clamp((x / Math.max(1, width - 1)) * cols - 0.5, 0, cols - 1);
  const gy = clamp((y / Math.max(1, height - 1)) * rows - 0.5, 0, rows - 1);
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const x1 = Math.min(cols - 1, x0 + 1);
  const y1 = Math.min(rows - 1, y0 + 1);
  const tx = gx - x0;
  const ty = gy - y0;
  const v00 = values[y0 * cols + x0] ?? 0;
  const v10 = values[y0 * cols + x1] ?? v00;
  const v01 = values[y1 * cols + x0] ?? v00;
  const v11 = values[y1 * cols + x1] ?? v01;
  const top = v00 * (1 - tx) + v10 * tx;
  const bottom = v01 * (1 - tx) + v11 * tx;
  return top * (1 - ty) + bottom * ty;
}

export async function tuneLocalSensitivity(features, referenceCenterline, options = {}) {
  const cols = options.cols ?? 4;
  const rows = options.rows ?? 4;
  const tolerance = options.tolerance ?? 4;
  const reviewRadius = Math.max(tolerance + 1, options.reviewRadius ?? 18);
  const baseSensitivity = options.sensitivity ?? 62;
  const minReferencePixels = options.minReferencePixels ?? 20;
  const maxDelta = options.maxDelta ?? 18;
  const regularization = options.regularization ?? 0.035;
  const onProgress = options.onProgress ?? (() => {});
  const candidates = [...new Set([
    -maxDelta,
    -Math.round(maxDelta * 0.55),
    0,
    Math.round(maxDelta * 0.55),
    maxDelta,
  ])].sort((a, b) => a - b);
  const weights = normalizedWeights(options);
  const referenceTolerance = dilateBinaryMask(referenceCenterline, features.width, features.height, tolerance);
  const reviewMask = dilateBinaryMask(referenceCenterline, features.width, features.height, reviewRadius);
  const negativeMask = options.negativeMask ?? null;
  const exclusionMask = options.exclusionMask ?? null;
  const evaluationMask = reviewMask.slice();
  if (negativeMask) {
    for (let p = 0; p < evaluationMask.length; p += 1) {
      if (!exclusionMask?.[p] && negativeMask[p] && !referenceTolerance[p]) evaluationMask[p] = 1;
    }
  }
  const helpers = { tolerance, referenceTolerance, reviewMask, evaluationMask, negativeMask, exclusionMask };

  const raw = new Float32Array(cols * rows);
  const measured = new Uint8Array(cols * rows);
  const regionMetrics = [];
  let completed = 0;
  const total = cols * rows;

  for (let ry = 0; ry < rows; ry += 1) {
    for (let rx = 0; rx < cols; rx += 1) {
      const index = ry * cols + rx;
      const bounds = buildRegionBounds(features.width, features.height, cols, rows, rx, ry);
      let referencePixels = 0;
      for (let y = bounds.y0; y < bounds.y1; y += 1) {
        const base = y * features.width;
        for (let x = bounds.x0; x < bounds.x1; x += 1) {
          const p = base + x;
          if (!exclusionMask?.[p]) referencePixels += referenceCenterline[p] ? 1 : 0;
        }
      }

      let best = null;
      if (referencePixels >= minReferencePixels) {
        for (const delta of candidates) {
          const sensitivity = clamp(baseSensitivity + delta, 1, 100);
          const metrics = evaluateRegionSensitivity(
            features,
            referenceCenterline,
            helpers,
            bounds,
            sensitivity,
            { weights },
          );
          const adjusted = metrics.f1 - regularization * Math.abs(delta) / Math.max(1, maxDelta);
          if (!best || adjusted > best.adjusted || (adjusted === best.adjusted && metrics.recall > best.metrics.recall)) {
            best = { delta: sensitivity - baseSensitivity, sensitivity, metrics, adjusted };
          }
        }
        measured[index] = 1;
        raw[index] = best.delta;
      }

      regionMetrics.push({
        rx,
        ry,
        referencePixels,
        measured: Boolean(measured[index]),
        rawDelta: raw[index],
        bestF1: best?.metrics.f1 ?? null,
        bestPrecision: best?.metrics.precision ?? null,
        bestRecall: best?.metrics.recall ?? null,
      });
      completed += 1;
      onProgress(completed / total);
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }

  const measuredCount = measured.reduce((sum, value) => sum + (value ? 1 : 0), 0);
  if (!measuredCount) {
    throw new Error("局所調整に使えるお手本が不足しています。複数の粒界をもう少し長く描いてください。");
  }

  const values = smoothMeasuredGrid(raw, measured, cols, rows);
  for (let i = 0; i < values.length; i += 1) values[i] = clamp(values[i], -maxDelta, maxDelta);

  return {
    version: 1,
    kind: "sensitivity-grid",
    cols,
    rows,
    baseSensitivity,
    maxDelta,
    values: Array.from(values),
    measured: Array.from(measured),
    regions: regionMetrics,
    createdAt: new Date().toISOString(),
  };
}
