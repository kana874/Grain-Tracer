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


export function splitReferenceCenterline(referenceCenterline, width, height, options = {}) {
  const validationFraction = Math.max(0.05, Math.min(0.45, options.validationFraction ?? 0.20));
  const minComponentPixels = Math.max(1, options.minComponentPixels ?? 8);
  const visited = new Uint8Array(referenceCenterline.length);
  const queue = new Int32Array(referenceCenterline.length);
  const components = [];

  for (let start = 0; start < referenceCenterline.length; start += 1) {
    if (!referenceCenterline[start] || visited[start]) continue;
    let head = 0;
    let tail = 0;
    let sx = 0;
    let sy = 0;
    queue[tail++] = start;
    visited[start] = 1;

    while (head < tail) {
      const p = queue[head++];
      const x = p % width;
      const y = Math.floor(p / width);
      sx += x;
      sy += y;
      for (let dy = -1; dy <= 1; dy += 1) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const np = ny * width + nx;
          if (referenceCenterline[np] && !visited[np]) {
            visited[np] = 1;
            queue[tail++] = np;
          }
        }
      }
    }

    if (tail >= minComponentPixels) {
      const pixels = Array.from(queue.subarray(0, tail));
      const cx = sx / tail;
      const cy = sy / tail;
      // Stable spatial hash so the same reference always produces the same split.
      const hash = (
        (Math.round(cx) * 73856093)
        ^ (Math.round(cy) * 19349663)
        ^ (tail * 83492791)
      ) >>> 0;
      components.push({ pixels, size: tail, cx, cy, hash });
    }
  }

  const tuneMask = new Uint8Array(referenceCenterline.length);
  const validationMask = new Uint8Array(referenceCenterline.length);
  const totalPixels = components.reduce((sum, component) => sum + component.size, 0);

  if (components.length < 2 || totalPixels === 0) {
    tuneMask.set(referenceCenterline);
    return {
      tuneMask,
      validationMask,
      componentCount: components.length,
      tuningPixels: referenceCenterline.reduce((sum, value) => sum + (value ? 1 : 0), 0),
      validationPixels: 0,
      validationFraction: 0,
      mode: "insufficient-components",
    };
  }

  const target = Math.max(1, Math.round(totalPixels * validationFraction));
  const ordered = [...components].sort((a, b) => a.hash - b.hash);
  let validationPixels = 0;
  const validationSet = new Set();

  for (const component of ordered) {
    if (validationPixels >= target && validationSet.size > 0) break;
    if (validationSet.size >= components.length - 1) break;
    validationSet.add(component);
    validationPixels += component.size;
  }

  for (const component of components) {
    const destination = validationSet.has(component) ? validationMask : tuneMask;
    for (const p of component.pixels) destination[p] = 1;
  }

  // Preserve tiny discarded reference fragments as tuning data rather than losing them.
  for (let p = 0; p < referenceCenterline.length; p += 1) {
    if (referenceCenterline[p] && !tuneMask[p] && !validationMask[p]) tuneMask[p] = 1;
  }

  const tuningPixels = tuneMask.reduce((sum, value) => sum + (value ? 1 : 0), 0);
  validationPixels = validationMask.reduce((sum, value) => sum + (value ? 1 : 0), 0);
  return {
    tuneMask,
    validationMask,
    componentCount: components.length,
    tuningPixels,
    validationPixels,
    validationFraction: validationPixels / Math.max(1, tuningPixels + validationPixels),
    mode: "connected-component-holdout",
  };
}
