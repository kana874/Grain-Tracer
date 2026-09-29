function clampInt(value, min, max) {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function dilateSquare(mask, width, height, radius) {
  const r = Math.max(0, Math.round(radius ?? 0));
  if (!r) return mask.slice();

  // Separable sliding-window max filter: O(width*height), independent of r^2.
  const horizontal = new Uint8Array(mask.length);
  const out = new Uint8Array(mask.length);

  for (let y = 0; y < height; y += 1) {
    const base = y * width;
    let active = 0;
    for (let sx = 0; sx <= Math.min(width - 1, r); sx += 1) {
      if (mask[base + sx]) active += 1;
    }
    for (let x = 0; x < width; x += 1) {
      if (x > 0) {
        const addX = x + r;
        if (addX < width && mask[base + addX]) active += 1;
        const removeX = x - r - 1;
        if (removeX >= 0 && mask[base + removeX]) active -= 1;
      }
      if (active > 0) horizontal[base + x] = 1;
    }
  }

  for (let x = 0; x < width; x += 1) {
    let active = 0;
    for (let sy = 0; sy <= Math.min(height - 1, r); sy += 1) {
      if (horizontal[sy * width + x]) active += 1;
    }
    for (let y = 0; y < height; y += 1) {
      if (y > 0) {
        const addY = y + r;
        if (addY < height && horizontal[addY * width + x]) active += 1;
        const removeY = y - r - 1;
        if (removeY >= 0 && horizontal[removeY * width + x]) active -= 1;
      }
      if (active > 0) out[y * width + x] = 1;
    }
  }

  return out;
}

function validateInputs(referenceMask, width, height) {
  if (!referenceMask || referenceMask.length !== width * height) {
    throw new Error("閉領域Fill用のお手本マスクが不正です。");
  }
  if (width <= 0 || height <= 0) throw new Error("プレビュー寸法が不正です。");
}

export function buildClosedNegativeRegionIndex(referenceMask, width, height, options = {}) {
  validateInputs(referenceMask, width, height);
  const totalPixels = width * height;
  const safetyRadius = Math.max(0, Math.round(options.safetyRadius ?? 3));
  const labels = new Uint32Array(totalPixels);
  const queue = new Int32Array(totalPixels);
  const componentSizes = [0];
  const componentTouchesEdge = [false];
  let componentCount = 0;

  for (let start = 0; start < totalPixels; start += 1) {
    if (referenceMask[start] || labels[start]) continue;
    componentCount += 1;
    let head = 0;
    let tail = 0;
    let touchesEdge = false;
    queue[tail++] = start;
    labels[start] = componentCount;

    while (head < tail) {
      const p = queue[head++];
      const x = p % width;
      const y = Math.floor(p / width);
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) touchesEdge = true;

      if (x > 0) {
        const np = p - 1;
        if (!referenceMask[np] && !labels[np]) {
          labels[np] = componentCount;
          queue[tail++] = np;
        }
      }
      if (x + 1 < width) {
        const np = p + 1;
        if (!referenceMask[np] && !labels[np]) {
          labels[np] = componentCount;
          queue[tail++] = np;
        }
      }
      if (y > 0) {
        const np = p - width;
        if (!referenceMask[np] && !labels[np]) {
          labels[np] = componentCount;
          queue[tail++] = np;
        }
      }
      if (y + 1 < height) {
        const np = p + width;
        if (!referenceMask[np] && !labels[np]) {
          labels[np] = componentCount;
          queue[tail++] = np;
        }
      }
    }

    componentSizes[componentCount] = tail;
    componentTouchesEdge[componentCount] = touchesEdge;
  }

  const safetyMask = safetyRadius ? dilateSquare(referenceMask, width, height, safetyRadius) : referenceMask.slice();
  const safeComponentSizes = new Uint32Array(componentCount + 1);
  for (let p = 0; p < totalPixels; p += 1) {
    const label = labels[p];
    if (label && !safetyMask[p]) safeComponentSizes[label] += 1;
  }

  return {
    labels,
    safetyMask,
    componentSizes,
    componentTouchesEdge,
    safeComponentSizes,
    componentCount,
    safetyRadius,
    width,
    height,
  };
}

function classifySeed(index, width, height, seed, options = {}, selectedLabels = null) {
  const x = clampInt(seed?.x ?? -1, -1, width);
  const y = clampInt(seed?.y ?? -1, -1, height);
  if (x < 0 || y < 0 || x >= width || y >= height) {
    return { accepted: false, reason: "seed-outside", seed: { x, y }, label: 0, regionPixels: 0, fillPixels: 0 };
  }

  const p = y * width + x;
  const label = index.labels[p];
  if (!label) {
    return { accepted: false, reason: "seed-on-boundary", seed: { x, y }, label: 0, regionPixels: 0, fillPixels: 0 };
  }

  const totalPixels = width * height;
  const maxAreaFraction = Math.max(0.01, Math.min(0.90, Number(options.maxAreaFraction ?? 0.35)));
  const maxPixels = Math.max(1, Math.floor(totalPixels * maxAreaFraction));
  const minPixels = Math.max(1, Math.round(options.minPixels ?? 12));
  const regionPixels = index.componentSizes[label] ?? 0;
  const fillPixels = index.safeComponentSizes[label] ?? 0;

  if (index.componentTouchesEdge[label]) {
    return { accepted: false, reason: "open-region", seed: { x, y }, label, regionPixels, fillPixels: 0 };
  }
  if (regionPixels > maxPixels) {
    return { accepted: false, reason: "region-too-large", seed: { x, y }, label, regionPixels, fillPixels: 0, maxPixels };
  }
  if (fillPixels < minPixels) {
    return { accepted: false, reason: "region-too-small", seed: { x, y }, label, regionPixels, fillPixels };
  }
  if (selectedLabels?.has(label)) {
    return { accepted: false, reason: "duplicate-region", seed: { x, y }, label, regionPixels, fillPixels: 0 };
  }

  return {
    accepted: true,
    reason: null,
    seed: { x, y },
    label,
    regionPixels,
    fillPixels,
    safetyRadius: index.safetyRadius,
  };
}

export function fillClosedNegativeRegion(referenceMask, width, height, seed, options = {}) {
  const index = buildClosedNegativeRegionIndex(referenceMask, width, height, options);
  const result = classifySeed(index, width, height, seed, options);
  if (!result.accepted) return { ...result, mask: null };

  const mask = new Uint8Array(width * height);
  for (let p = 0; p < mask.length; p += 1) {
    if (index.labels[p] === result.label && !index.safetyMask[p]) mask[p] = 1;
  }
  return { ...result, mask };
}

export function rebuildClosedNegativeMask(referenceMask, width, height, seeds = [], options = {}, regionIndex = null) {
  const startedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
  const requestedSafetyRadius = Math.max(0, Math.round(options.safetyRadius ?? 3));
  const index = regionIndex
    && regionIndex.width === width
    && regionIndex.height === height
    && regionIndex.safetyRadius === requestedSafetyRadius
    ? regionIndex
    : buildClosedNegativeRegionIndex(referenceMask, width, height, options);
  const mask = new Uint8Array(width * height);
  const results = [];
  const selectedLabels = new Set();
  const seenSeeds = new Set();

  for (const rawSeed of seeds ?? []) {
    const seed = {
      x: clampInt(rawSeed?.x ?? -1, -1, width),
      y: clampInt(rawSeed?.y ?? -1, -1, height),
    };
    const key = `${seed.x},${seed.y}`;
    if (seenSeeds.has(key)) {
      results.push({ accepted: false, reason: "duplicate-seed", seed, label: 0, regionPixels: 0, fillPixels: 0 });
      continue;
    }
    seenSeeds.add(key);

    const result = classifySeed(index, width, height, seed, options, selectedLabels);
    results.push(result);
    if (result.accepted) selectedLabels.add(result.label);
  }

  let fillPixels = 0;
  if (selectedLabels.size) {
    const selectedFlags = new Uint8Array(index.componentCount + 1);
    for (const label of selectedLabels) selectedFlags[label] = 1;
    for (let p = 0; p < mask.length; p += 1) {
      if (!index.safetyMask[p] && selectedFlags[index.labels[p]]) {
        mask[p] = 1;
        fillPixels += 1;
      }
    }
  }

  const finishedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
  return {
    mask,
    results,
    validCount: results.filter(item => item.accepted).length,
    invalidCount: results.filter(item => !item.accepted).length,
    fillPixels,
    componentCount: index.componentCount,
    elapsedMs: Math.max(0, finishedAt - startedAt),
    regionIndex: index,
  };
}

function deterministicRegionHash(seed, label, fillPixels) {
  return (
    ((Math.round(seed.x) + 1) * 73856093)
    ^ ((Math.round(seed.y) + 1) * 19349663)
    ^ ((label + 1) * 83492791)
    ^ ((fillPixels + 1) * 2654435761)
  ) >>> 0;
}

export function splitClosedNegativeRegions(
  referenceMask,
  width,
  height,
  seeds = [],
  options = {},
  regionIndex = null,
) {
  validateInputs(referenceMask, width, height);
  const validationFraction = Math.max(0.05, Math.min(0.45, Number(options.validationFraction ?? 0.20)));
  const requestedSafetyRadius = Math.max(0, Math.round(options.safetyRadius ?? 3));
  const index = regionIndex
    && regionIndex.width === width
    && regionIndex.height === height
    && regionIndex.safetyRadius === requestedSafetyRadius
    ? regionIndex
    : buildClosedNegativeRegionIndex(referenceMask, width, height, options);

  const selectedLabels = new Set();
  const regions = [];
  const results = [];
  for (const rawSeed of seeds ?? []) {
    const result = classifySeed(index, width, height, rawSeed, options, selectedLabels);
    results.push(result);
    if (!result.accepted) continue;
    selectedLabels.add(result.label);
    regions.push({
      label: result.label,
      seed: { ...result.seed },
      fillPixels: result.fillPixels,
      hash: deterministicRegionHash(result.seed, result.label, result.fillPixels),
    });
  }

  const tuningMask = new Uint8Array(width * height);
  const validationMask = new Uint8Array(width * height);
  if (!regions.length) {
    return {
      tuningMask,
      validationMask,
      regionCount: 0,
      tuningRegionCount: 0,
      validationRegionCount: 0,
      tuningPixels: 0,
      validationPixels: 0,
      validationFraction: 0,
      requestedValidationFraction: validationFraction,
      mode: "no-valid-closed-fill-regions",
      results,
      regionIndex: index,
    };
  }

  let validationLabels = new Set();
  if (regions.length >= 2) {
    const desired = Math.max(
      1,
      Math.min(regions.length - 1, Math.round(regions.length * validationFraction)),
    );
    validationLabels = new Set(
      [...regions]
        .sort((a, b) => a.hash - b.hash || a.label - b.label)
        .slice(0, desired)
        .map(region => region.label),
    );
  }

  const selectedFlags = new Uint8Array(index.componentCount + 1);
  const validationFlags = new Uint8Array(index.componentCount + 1);
  for (const region of regions) {
    selectedFlags[region.label] = 1;
    if (validationLabels.has(region.label)) validationFlags[region.label] = 1;
  }

  let tuningPixels = 0;
  let validationPixels = 0;
  for (let p = 0; p < index.labels.length; p += 1) {
    const label = index.labels[p];
    if (!label || !selectedFlags[label] || index.safetyMask[p]) continue;
    if (validationFlags[label]) {
      validationMask[p] = 1;
      validationPixels += 1;
    } else {
      tuningMask[p] = 1;
      tuningPixels += 1;
    }
  }

  return {
    tuningMask,
    validationMask,
    regionCount: regions.length,
    tuningRegionCount: regions.length - validationLabels.size,
    validationRegionCount: validationLabels.size,
    tuningPixels,
    validationPixels,
    validationFraction: validationPixels / Math.max(1, tuningPixels + validationPixels),
    requestedValidationFraction: validationFraction,
    mode: validationLabels.size ? "closed-fill-region-holdout" : "insufficient-closed-fill-regions",
    results,
    regionIndex: index,
  };
}

export function combineNegativeMasks(manualMask, closedFillMask, positiveMask = null) {
  const length = manualMask?.length ?? closedFillMask?.length ?? positiveMask?.length ?? 0;
  const out = new Uint8Array(length);
  for (let p = 0; p < length; p += 1) {
    if (positiveMask?.[p]) continue;
    if (manualMask?.[p] || closedFillMask?.[p]) out[p] = 1;
  }
  return out;
}
