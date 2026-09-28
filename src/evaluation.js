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

export function compareBoundaryMasks(prediction, referenceCenterline, width, height, options = {}) {
  const tolerance = options.tolerance ?? 4;
  const reviewRadius = Math.max(tolerance + 1, options.reviewRadius ?? 18);
  const referenceTolerance = dilateBinaryMask(referenceCenterline, width, height, tolerance);
  const reviewMask = dilateBinaryMask(referenceCenterline, width, height, reviewRadius);
  const predictionTolerance = dilateBinaryMask(prediction, width, height, tolerance);

  let matchedPrediction = 0;
  let falsePositive = 0;
  let matchedReference = 0;
  let falseNegative = 0;

  for (let p = 0; p < prediction.length; p += 1) {
    if (reviewMask[p] && prediction[p]) {
      if (referenceTolerance[p]) matchedPrediction += 1;
      else falsePositive += 1;
    }
    if (referenceCenterline[p]) {
      if (predictionTolerance[p]) matchedReference += 1;
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
    matchedPrediction,
    falsePositive,
    matchedReference,
    falseNegative,
    referencePixels: matchedReference + falseNegative,
    reviewedPredictionPixels: matchedPrediction + falsePositive,
    referenceTolerance,
    reviewMask,
    predictionTolerance,
  };
}

export function computeRegionalMetrics(prediction, referenceCenterline, width, height, options = {}) {
  const cols = options.cols ?? 4;
  const rows = options.rows ?? 4;
  const tolerance = options.tolerance ?? 4;
  const reviewRadius = options.reviewRadius ?? 18;
  const global = compareBoundaryMasks(prediction, referenceCenterline, width, height, { tolerance, reviewRadius });
  const regions = [];

  for (let ry = 0; ry < rows; ry += 1) {
    for (let rx = 0; rx < cols; rx += 1) {
      const x0 = Math.floor(rx * width / cols);
      const x1 = Math.floor((rx + 1) * width / cols);
      const y0 = Math.floor(ry * height / rows);
      const y1 = Math.floor((ry + 1) * height / rows);
      let tp = 0; let fp = 0; let tr = 0; let fn = 0;
      for (let y = y0; y < y1; y += 1) {
        const base = y * width;
        for (let x = x0; x < x1; x += 1) {
          const p = base + x;
          if (global.reviewMask[p] && prediction[p]) {
            if (global.referenceTolerance[p]) tp += 1;
            else fp += 1;
          }
          if (referenceCenterline[p]) {
            if (global.predictionTolerance[p]) tr += 1;
            else fn += 1;
          }
        }
      }
      const precision = tp + fp ? tp / (tp + fp) : 0;
      const recall = tr + fn ? tr / (tr + fn) : 0;
      const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
      regions.push({ rx, ry, x0, y0, x1, y1, precision, recall, f1, referencePixels: tr + fn });
    }
  }
  return { ...global, regions, cols, rows };
}
