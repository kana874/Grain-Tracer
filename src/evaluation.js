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

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function countMask(mask) {
  let count = 0;
  for (let p = 0; p < mask.length; p += 1) count += mask[p] ? 1 : 0;
  return count;
}

function buildRectMask(rects, width, height) {
  const mask = new Uint8Array(width * height);
  for (const rect of rects ?? []) {
    const x0 = clamp(Math.round(Math.min(rect.x0, rect.x1)), 0, width - 1);
    const x1 = clamp(Math.round(Math.max(rect.x0, rect.x1)), 0, width - 1);
    const y0 = clamp(Math.round(Math.min(rect.y0, rect.y1)), 0, height - 1);
    const y1 = clamp(Math.round(Math.max(rect.y0, rect.y1)), 0, height - 1);
    for (let y = y0; y <= y1; y += 1) {
      mask.fill(1, y * width + x0, y * width + x1 + 1);
    }
  }
  return mask;
}

export function computeChebyshevDistanceToMask(mask, width, height, exclusionMask = null) {
  const maxDistance = width + height + 1;
  const distance = new Uint32Array(mask.length);
  for (let p = 0; p < distance.length; p += 1) {
    distance[p] = mask[p] && !exclusionMask?.[p] ? 0 : maxDistance;
  }

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const p = y * width + x;
      if (distance[p] === 0 || exclusionMask?.[p]) continue;
      let best = distance[p];
      if (x > 0) best = Math.min(best, distance[p - 1] + 1);
      if (y > 0) {
        best = Math.min(best, distance[p - width] + 1);
        if (x > 0) best = Math.min(best, distance[p - width - 1] + 1);
        if (x + 1 < width) best = Math.min(best, distance[p - width + 1] + 1);
      }
      distance[p] = best;
    }
  }

  for (let y = height - 1; y >= 0; y -= 1) {
    for (let x = width - 1; x >= 0; x -= 1) {
      const p = y * width + x;
      if (distance[p] === 0 || exclusionMask?.[p]) continue;
      let best = distance[p];
      if (x + 1 < width) best = Math.min(best, distance[p + 1] + 1);
      if (y + 1 < height) {
        best = Math.min(best, distance[p + width] + 1);
        if (x > 0) best = Math.min(best, distance[p + width - 1] + 1);
        if (x + 1 < width) best = Math.min(best, distance[p + width + 1] + 1);
      }
      distance[p] = best;
    }
  }
  return distance;
}

function summarizeAlignment(referenceCenterline, distance, exclusionMask, maxDistance) {
  const values = [];
  let unmatched = 0;
  for (let p = 0; p < referenceCenterline.length; p += 1) {
    if (!referenceCenterline[p] || exclusionMask?.[p]) continue;
    const d = distance[p];
    if (d <= maxDistance) values.push(d);
    else unmatched += 1;
  }
  values.sort((a, b) => a - b);
  const count = values.length;
  const sum = values.reduce((total, value) => total + value, 0);
  const percentile = q => {
    if (!count) return null;
    const index = Math.min(count - 1, Math.max(0, Math.round((count - 1) * q)));
    return values[index];
  };
  return {
    mean: count ? sum / count : null,
    median: percentile(0.5),
    p90: percentile(0.9),
    matchedPixels: count,
    unmatchedPixels: unmatched,
    maxDistance,
  };
}

export function compareBoundaryMasks(prediction, referenceCenterline, width, height, options = {}) {
  const tolerance = options.tolerance ?? 4;
  const reviewRadius = Math.max(tolerance + 1, options.reviewRadius ?? 18);
  const negativeMask = options.negativeMask ?? null;
  const exclusionMask = options.exclusionMask ?? null;

  const referenceTolerance = dilateBinaryMask(referenceCenterline, width, height, tolerance);
  const reviewMask = dilateBinaryMask(referenceCenterline, width, height, reviewRadius);
  const evaluationMask = new Uint8Array(prediction.length);
  const unknownMask = new Uint8Array(prediction.length);
  const cleanPrediction = exclusionMask ? prediction.slice() : prediction;

  if (exclusionMask) {
    for (let p = 0; p < cleanPrediction.length; p += 1) {
      if (exclusionMask[p]) cleanPrediction[p] = 0;
    }
  }
  const predictionTolerance = dilateBinaryMask(cleanPrediction, width, height, tolerance);

  let matchedPrediction = 0;
  let falsePositive = 0;
  let unknownPrediction = 0;
  let matchedReference = 0;
  let falseNegative = 0;
  let negativePrediction = 0;
  let negativePixels = 0;
  let excludedPixels = 0;

  for (let p = 0; p < prediction.length; p += 1) {
    if (exclusionMask?.[p]) {
      excludedPixels += 1;
      referenceTolerance[p] = 0;
      reviewMask[p] = 0;
      continue;
    }

    const isPositive = Boolean(referenceTolerance[p]);
    const isNegative = Boolean(negativeMask?.[p] && !isPositive);
    if (isPositive || isNegative) evaluationMask[p] = 1;
    else unknownMask[p] = 1;

    if (isNegative) negativePixels += 1;

    if (cleanPrediction[p]) {
      if (isPositive) {
        matchedPrediction += 1;
      } else if (isNegative) {
        falsePositive += 1;
        negativePrediction += 1;
      } else {
        unknownPrediction += 1;
      }
    }

    if (referenceCenterline[p]) {
      if (predictionTolerance[p]) matchedReference += 1;
      else falseNegative += 1;
    }
  }

  const positiveDen = matchedReference + falseNegative;
  const positiveRecall = positiveDen ? matchedReference / positiveDen : 0;
  const negativeLeakage = negativePixels ? negativePrediction / negativePixels : 0;

  // Compatibility proxy used by the current v0.3.x tuning code only.
  // It is not a true whole-image Precision/F1 because Unknown pixels are deliberately ignored.
  const labelPrecisionDen = matchedPrediction + falsePositive;
  const labelPrecision = labelPrecisionDen ? matchedPrediction / labelPrecisionDen : 0;
  const labelF1 = labelPrecision + positiveRecall
    ? (2 * labelPrecision * positiveRecall) / (labelPrecision + positiveRecall)
    : 0;

  const alignmentDistance = options.skipAlignment
    ? null
    : computeChebyshevDistanceToMask(cleanPrediction, width, height, exclusionMask);
  const alignmentError = alignmentDistance
    ? summarizeAlignment(referenceCenterline, alignmentDistance, exclusionMask, reviewRadius)
    : null;

  return {
    evaluationMode: "partial-label",
    positiveRecall,
    negativeLeakage,
    alignmentError,
    labelPrecision,
    labelF1,
    // Legacy aliases retained for the current tuning/history code.
    precision: labelPrecision,
    recall: positiveRecall,
    f1: labelF1,
    matchedPrediction,
    falsePositive,
    unknownPrediction,
    matchedReference,
    falseNegative,
    negativePrediction,
    negativePixels,
    negativeHitRate: negativeLeakage,
    excludedPixels,
    referencePixels: matchedReference + falseNegative,
    reviewedPredictionPixels: matchedPrediction + falsePositive,
    referenceTolerance,
    reviewMask,
    evaluationMask,
    unknownMask,
    predictionTolerance,
    alignmentDistance,
    negativeMask,
    exclusionMask,
  };
}

export function computeRegionalMetrics(prediction, referenceCenterline, width, height, options = {}) {
  const cols = options.cols ?? 4;
  const rows = options.rows ?? 4;
  const tolerance = options.tolerance ?? 4;
  const reviewRadius = options.reviewRadius ?? 18;
  const global = compareBoundaryMasks(prediction, referenceCenterline, width, height, {
    tolerance,
    reviewRadius,
    negativeMask: options.negativeMask ?? null,
    exclusionMask: options.exclusionMask ?? null,
  });
  const regions = [];

  for (let ry = 0; ry < rows; ry += 1) {
    for (let rx = 0; rx < cols; rx += 1) {
      const x0 = Math.floor(rx * width / cols);
      const x1 = Math.floor((rx + 1) * width / cols);
      const y0 = Math.floor(ry * height / rows);
      const y1 = Math.floor((ry + 1) * height / rows);
      let matchedPrediction = 0;
      let falsePositive = 0;
      let unknownPrediction = 0;
      let matchedReference = 0;
      let falseNegative = 0;
      let negativePrediction = 0;
      let negativePixels = 0;
      let excludedPixels = 0;
      let alignmentSum = 0;
      let alignmentMatched = 0;

      for (let y = y0; y < y1; y += 1) {
        const base = y * width;
        for (let x = x0; x < x1; x += 1) {
          const p = base + x;
          if (global.exclusionMask?.[p]) {
            excludedPixels += 1;
            continue;
          }

          const isPositive = Boolean(global.referenceTolerance[p]);
          const isNegative = Boolean(global.negativeMask?.[p] && !isPositive);
          if (isNegative) negativePixels += 1;

          if (prediction[p]) {
            if (isPositive) matchedPrediction += 1;
            else if (isNegative) {
              falsePositive += 1;
              negativePrediction += 1;
            } else {
              unknownPrediction += 1;
            }
          }

          if (referenceCenterline[p]) {
            if (global.predictionTolerance[p]) matchedReference += 1;
            else falseNegative += 1;
            const d = global.alignmentDistance?.[p];
            if (d != null && d <= reviewRadius) {
              alignmentSum += d;
              alignmentMatched += 1;
            }
          }
        }
      }

      const labelPrecision = matchedPrediction + falsePositive
        ? matchedPrediction / (matchedPrediction + falsePositive)
        : 0;
      const positiveRecall = matchedReference + falseNegative
        ? matchedReference / (matchedReference + falseNegative)
        : 0;
      const labelF1 = labelPrecision + positiveRecall
        ? (2 * labelPrecision * positiveRecall) / (labelPrecision + positiveRecall)
        : 0;
      regions.push({
        rx, ry, x0, y0, x1, y1,
        evaluationMode: "partial-label",
        positiveRecall,
        negativeLeakage: negativePixels ? negativePrediction / negativePixels : 0,
        alignmentError: alignmentMatched ? alignmentSum / alignmentMatched : null,
        labelPrecision,
        labelF1,
        precision: labelPrecision,
        recall: positiveRecall,
        f1: labelF1,
        referencePixels: matchedReference + falseNegative,
        matchedReference,
        falseNegative,
        matchedPrediction,
        predictionPixels: matchedPrediction + negativePrediction + unknownPrediction,
        negativePixels,
        negativePrediction,
        negativeHitRate: negativePixels ? negativePrediction / negativePixels : 0,
        unknownPrediction,
        excludedPixels,
      });
    }
  }
  const negativeRegions = regions.filter(region => region.negativePixels > 0);
  const macroNegativeLeakage = negativeRegions.length
    ? negativeRegions.reduce((sum, region) => sum + region.negativeLeakage, 0) / negativeRegions.length
    : 0;
  const totalNegativePixels = negativeRegions.reduce((sum, region) => sum + region.negativePixels, 0);
  const maxNegativeRegionShare = totalNegativePixels
    ? Math.max(...negativeRegions.map(region => region.negativePixels / totalNegativePixels))
    : 0;

  return {
    ...global,
    regions,
    cols,
    rows,
    macroNegativeLeakage,
    negativeRegionCount: negativeRegions.length,
    maxNegativeRegionShare,
  };
}

export function computeMultiToleranceMetrics(prediction, referenceCenterline, width, height, options = {}) {
  const tolerances = options.tolerances ?? [1, 2, 3, 4];
  return tolerances.map(tolerance => {
    const metrics = compareBoundaryMasks(prediction, referenceCenterline, width, height, {
      ...options,
      tolerance,
      skipAlignment: true,
    });
    return {
      tolerance,
      positiveRecall: metrics.positiveRecall,
      negativeLeakage: metrics.negativeLeakage,
      labelPrecision: metrics.labelPrecision,
      labelF1: metrics.labelF1,
      matchedReference: metrics.matchedReference,
      falseNegative: metrics.falseNegative,
      negativePrediction: metrics.negativePrediction,
      negativePixels: metrics.negativePixels,
      unknownPrediction: metrics.unknownPrediction,
    };
  });
}

function computeFullMetricsForMask(prediction, referenceCenterline, roiMask, width, height, options = {}) {
  const tolerance = options.tolerance ?? 1;
  const exclusionMask = options.exclusionMask ?? null;
  const reference = new Uint8Array(referenceCenterline.length);
  const roiPrediction = new Uint8Array(prediction.length);

  for (let p = 0; p < reference.length; p += 1) {
    if (!roiMask[p] || exclusionMask?.[p]) continue;
    if (referenceCenterline[p]) reference[p] = 1;
    if (prediction[p]) roiPrediction[p] = 1;
  }

  const referenceTolerance = dilateBinaryMask(reference, width, height, tolerance);
  const predictionTolerance = dilateBinaryMask(roiPrediction, width, height, tolerance);

  let truePositivePrediction = 0;
  let falsePositive = 0;
  let matchedReference = 0;
  let falseNegative = 0;
  let evaluatedPixels = 0;

  for (let p = 0; p < roiMask.length; p += 1) {
    if (!roiMask[p] || exclusionMask?.[p]) continue;
    evaluatedPixels += 1;
    if (roiPrediction[p]) {
      if (referenceTolerance[p]) truePositivePrediction += 1;
      else falsePositive += 1;
    }
    if (reference[p]) {
      if (predictionTolerance[p]) matchedReference += 1;
      else falseNegative += 1;
    }
  }

  const precision = truePositivePrediction + falsePositive
    ? truePositivePrediction / (truePositivePrediction + falsePositive)
    : 0;
  const recall = matchedReference + falseNegative
    ? matchedReference / (matchedReference + falseNegative)
    : 0;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return {
    precision,
    recall,
    f1,
    truePositivePrediction,
    falsePositive,
    matchedReference,
    falseNegative,
    referencePixels: matchedReference + falseNegative,
    predictionPixels: truePositivePrediction + falsePositive,
    evaluatedPixels,
  };
}

export function computeFullEvaluationRoiMetrics(
  prediction,
  referenceCenterline,
  width,
  height,
  rects,
  options = {},
) {
  const cleanRects = (rects ?? []).map(rect => ({
    x0: clamp(Math.round(Math.min(rect.x0, rect.x1)), 0, width - 1),
    y0: clamp(Math.round(Math.min(rect.y0, rect.y1)), 0, height - 1),
    x1: clamp(Math.round(Math.max(rect.x0, rect.x1)), 0, width - 1),
    y1: clamp(Math.round(Math.max(rect.y0, rect.y1)), 0, height - 1),
  }));
  const unionMask = buildRectMask(cleanRects, width, height);
  const aggregate = computeFullMetricsForMask(
    prediction,
    referenceCenterline,
    unionMask,
    width,
    height,
    options,
  );
  const regions = cleanRects.map((rect, index) => {
    const mask = buildRectMask([rect], width, height);
    return {
      index,
      rect,
      ...computeFullMetricsForMask(prediction, referenceCenterline, mask, width, height, options),
    };
  });
  return {
    mode: "complete-label-roi",
    roiCount: cleanRects.length,
    roiPixels: countMask(unionMask),
    tolerance: options.tolerance ?? 1,
    ...aggregate,
    regions,
  };
}

function splitReferenceSpatialBalanced(referenceCenterline, width, height, options = {}) {
  const validationFraction = Math.max(0.05, Math.min(0.45, options.validationFraction ?? 0.20));
  const cols = Math.max(2, Math.min(8, Math.round(options.cols ?? 4)));
  const rows = Math.max(2, Math.min(8, Math.round(options.rows ?? 4)));
  const tuneMask = new Uint8Array(referenceCenterline.length);
  const validationMask = new Uint8Array(referenceCenterline.length);
  const cellPixels = Array.from({ length: cols * rows }, () => []);

  let totalPixels = 0;
  for (let p = 0; p < referenceCenterline.length; p += 1) {
    if (!referenceCenterline[p]) continue;
    totalPixels += 1;
    const x = p % width;
    const y = Math.floor(p / width);
    const cx = Math.min(cols - 1, Math.floor(x * cols / width));
    const cy = Math.min(rows - 1, Math.floor(y * rows / height));
    cellPixels[cy * cols + cx].push(p);
  }

  const activeCells = cellPixels
    .map((pixels, index) => ({ index, pixels, size: pixels.length }))
    .filter(cell => cell.size > 0);

  if (activeCells.length < 2 || totalPixels === 0) {
    tuneMask.set(referenceCenterline);
    return {
      tuneMask,
      validationMask,
      componentCount: activeCells.length,
      tuningPixels: totalPixels,
      validationPixels: 0,
      validationFraction: 0,
      requestedValidationFraction: validationFraction,
      mode: "spatial-balanced-insufficient-cells",
      cols,
      rows,
      tuningCellCount: activeCells.length,
      validationCellCount: 0,
    };
  }

  const targetPixels = Math.max(1, Math.round(totalPixels * validationFraction));
  const targetCells = Math.max(1, Math.round(activeCells.length * validationFraction));
  const count = activeCells.length;
  let bestMask = 0;
  let bestPixelError = Infinity;
  let bestCellError = Infinity;
  let bestTie = Infinity;

  // At 4x4 this is at most 65,536 deterministic subsets. This happens only
  // when the annotation holdout is rebuilt, not per extraction pixel.
  const subsetLimit = 1 << count;
  for (let subset = 1; subset < subsetLimit - 1; subset += 1) {
    let pixels = 0;
    let cells = 0;
    let tie = 2166136261 >>> 0;
    for (let i = 0; i < count; i += 1) {
      if (!(subset & (1 << i))) continue;
      const cell = activeCells[i];
      pixels += cell.size;
      cells += 1;
      tie ^= (cell.index + 1) * 16777619;
      tie = Math.imul(tie, 16777619) >>> 0;
    }
    const pixelError = Math.abs(pixels - targetPixels);
    const cellError = Math.abs(cells - targetCells);
    if (pixelError < bestPixelError
      || (pixelError === bestPixelError && cellError < bestCellError)
      || (pixelError === bestPixelError && cellError === bestCellError && tie < bestTie)) {
      bestMask = subset;
      bestPixelError = pixelError;
      bestCellError = cellError;
      bestTie = tie;
    }
  }

  const validationCells = new Set();
  for (let i = 0; i < count; i += 1) {
    if (bestMask & (1 << i)) validationCells.add(activeCells[i].index);
  }

  let validationPixels = 0;
  for (const cell of activeCells) {
    const destination = validationCells.has(cell.index) ? validationMask : tuneMask;
    for (const p of cell.pixels) destination[p] = 1;
    if (validationCells.has(cell.index)) validationPixels += cell.size;
  }

  const tuningPixels = totalPixels - validationPixels;
  return {
    tuneMask,
    validationMask,
    componentCount: activeCells.length,
    tuningPixels,
    validationPixels,
    validationFraction: validationPixels / Math.max(1, totalPixels),
    requestedValidationFraction: validationFraction,
    mode: "spatial-grid-pixel-balanced-holdout",
    cols,
    rows,
    tuningCellCount: activeCells.length - validationCells.size,
    validationCellCount: validationCells.size,
  };
}

export function splitReferenceCenterline(referenceCenterline, width, height, options = {}) {
  if (options.strategy === "spatial-balanced") {
    return splitReferenceSpatialBalanced(referenceCenterline, width, height, options);
  }
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
