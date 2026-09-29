function clampInt(value, min, max) {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function dilateSquare(mask, width, height, radius) {
  const r = Math.max(0, Math.round(radius ?? 0));
  if (!r) return mask.slice();
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < height; y += 1) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(height - 1, y + r);
    for (let x = 0; x < width; x += 1) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(width - 1, x + r);
      let found = false;
      for (let sy = y0; sy <= y1 && !found; sy += 1) {
        const base = sy * width;
        for (let sx = x0; sx <= x1; sx += 1) {
          if (mask[base + sx]) {
            found = true;
            break;
          }
        }
      }
      if (found) out[y * width + x] = 1;
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

export function fillClosedNegativeRegion(referenceMask, width, height, seed, options = {}) {
  validateInputs(referenceMask, width, height);
  const x = clampInt(seed?.x ?? -1, -1, width);
  const y = clampInt(seed?.y ?? -1, -1, height);
  if (x < 0 || y < 0 || x >= width || y >= height) {
    return { accepted: false, reason: "seed-outside", seed: { x, y }, mask: null, regionPixels: 0, fillPixels: 0 };
  }

  const start = y * width + x;
  if (referenceMask[start]) {
    return { accepted: false, reason: "seed-on-boundary", seed: { x, y }, mask: null, regionPixels: 0, fillPixels: 0 };
  }

  const totalPixels = width * height;
  const maxAreaFraction = Math.max(0.01, Math.min(0.90, Number(options.maxAreaFraction ?? 0.35)));
  const maxPixels = Math.max(1, Math.floor(totalPixels * maxAreaFraction));
  const minPixels = Math.max(1, Math.round(options.minPixels ?? 12));
  const safetyRadius = Math.max(0, Math.round(options.safetyRadius ?? 3));

  const visited = new Uint8Array(totalPixels);
  const queue = new Int32Array(totalPixels);
  let head = 0;
  let tail = 0;
  let reachedEdge = false;
  queue[tail++] = start;
  visited[start] = 1;

  while (head < tail) {
    const p = queue[head++];
    const px = p % width;
    const py = Math.floor(p / width);

    if (px === 0 || py === 0 || px === width - 1 || py === height - 1) {
      reachedEdge = true;
      break;
    }
    if (tail > maxPixels) {
      return {
        accepted: false,
        reason: "region-too-large",
        seed: { x, y },
        mask: null,
        regionPixels: tail,
        fillPixels: 0,
        maxPixels,
      };
    }

    const left = p - 1;
    const right = p + 1;
    const up = p - width;
    const down = p + width;
    for (const np of [left, right, up, down]) {
      if (visited[np] || referenceMask[np]) continue;
      visited[np] = 1;
      queue[tail++] = np;
    }
  }

  if (reachedEdge) {
    return {
      accepted: false,
      reason: "open-region",
      seed: { x, y },
      mask: null,
      regionPixels: tail,
      fillPixels: 0,
    };
  }

  const safetyMask = safetyRadius ? dilateSquare(referenceMask, width, height, safetyRadius) : referenceMask;
  const mask = new Uint8Array(totalPixels);
  let fillPixels = 0;
  for (let i = 0; i < tail; i += 1) {
    const p = queue[i];
    if (safetyMask[p]) continue;
    mask[p] = 1;
    fillPixels += 1;
  }

  if (fillPixels < minPixels) {
    return {
      accepted: false,
      reason: "region-too-small",
      seed: { x, y },
      mask: null,
      regionPixels: tail,
      fillPixels,
    };
  }

  return {
    accepted: true,
    reason: null,
    seed: { x, y },
    mask,
    regionPixels: tail,
    fillPixels,
    safetyRadius,
  };
}

export function rebuildClosedNegativeMask(referenceMask, width, height, seeds = [], options = {}) {
  validateInputs(referenceMask, width, height);
  const mask = new Uint8Array(width * height);
  const results = [];
  const seen = new Set();

  for (const rawSeed of seeds ?? []) {
    const seed = {
      x: clampInt(rawSeed?.x ?? -1, -1, width),
      y: clampInt(rawSeed?.y ?? -1, -1, height),
    };
    const key = `${seed.x},${seed.y}`;
    if (seen.has(key)) {
      results.push({ accepted: false, reason: "duplicate-seed", seed, mask: null, regionPixels: 0, fillPixels: 0 });
      continue;
    }
    seen.add(key);

    const result = fillClosedNegativeRegion(referenceMask, width, height, seed, options);
    results.push({ ...result, mask: undefined });
    if (!result.accepted || !result.mask) continue;
    for (let p = 0; p < mask.length; p += 1) {
      if (result.mask[p]) mask[p] = 1;
    }
  }

  return {
    mask,
    results,
    validCount: results.filter(item => item.accepted).length,
    invalidCount: results.filter(item => !item.accepted).length,
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
