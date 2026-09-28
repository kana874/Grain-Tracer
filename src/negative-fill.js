import { dilateBinaryMask } from "./evaluation.js";

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeSeed(seed, width, height) {
  return {
    x: clamp(Math.round(seed.x), 0, width - 1),
    y: clamp(Math.round(seed.y), 0, height - 1),
    safetyMargin: Math.max(1, Math.round(seed.safetyMargin ?? 3)),
  };
}

export function computeClosedNegativeFill(
  referenceCenterline,
  width,
  height,
  seedInput,
  options = {},
) {
  if (!referenceCenterline?.length || width <= 0 || height <= 0) {
    return { ok: false, reason: "invalid-input", message: "粒界お手本がありません。" };
  }

  const seed = normalizeSeed(seedInput, width, height);
  const wallRadius = Math.max(0, Math.round(options.wallRadius ?? 1));
  const safetyMargin = Math.max(wallRadius + 1, seed.safetyMargin);
  const maxAreaFraction = Math.max(0.01, Math.min(0.8, Number(options.maxAreaFraction ?? 0.35)));
  const minAreaPixels = Math.max(1, Math.round(options.minAreaPixels ?? 12));
  const exclusionMask = options.exclusionMask ?? null;

  const wallMask = wallRadius > 0
    ? dilateBinaryMask(referenceCenterline, width, height, wallRadius)
    : referenceCenterline.slice();
  const seedIndex = seed.y * width + seed.x;

  if (wallMask[seedIndex]) {
    return {
      ok: false,
      reason: "seed-on-boundary",
      message: "お手本線の上ではなく、閉じた粒の内側をクリックしてください。",
      seed,
    };
  }

  const maxAreaPixels = Math.max(
    minAreaPixels,
    Math.floor(width * height * maxAreaFraction),
  );
  const visited = new Uint8Array(width * height);
  const queue = new Int32Array(Math.min(width * height, maxAreaPixels + 1));
  let head = 0;
  let tail = 0;
  let touchesEdge = false;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  visited[seedIndex] = 1;
  queue[tail++] = seedIndex;

  while (head < tail) {
    const p = queue[head++];
    const x = p % width;
    const y = Math.floor(p / width);

    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);

    if (x === 0 || y === 0 || x === width - 1 || y === height - 1) {
      touchesEdge = true;
      break;
    }

    const neighbors = [p - 1, p + 1, p - width, p + width];
    for (const np of neighbors) {
      if (visited[np] || wallMask[np]) continue;
      visited[np] = 1;
      if (tail >= queue.length) {
        return {
          ok: false,
          reason: "too-large",
          message: "閉領域が大きすぎます。粒界が閉じているか確認してください。",
          seed,
          maxAreaPixels,
        };
      }
      queue[tail++] = np;
    }
  }

  if (touchesEdge) {
    return {
      ok: false,
      reason: "open-region",
      message: "画像端までつながっています。お手本線が閉じているか確認してください。",
      seed,
    };
  }

  if (tail < minAreaPixels) {
    return {
      ok: false,
      reason: "too-small",
      message: "閉領域が小さすぎます。",
      seed,
      regionPixels: tail,
    };
  }

  const safetyMask = dilateBinaryMask(referenceCenterline, width, height, safetyMargin);
  const fillIndicesBuffer = new Int32Array(tail);
  let fillPixels = 0;
  let excludedPixels = 0;

  for (let i = 0; i < tail; i += 1) {
    const p = queue[i];
    if (safetyMask[p]) continue;
    if (exclusionMask?.[p]) {
      excludedPixels += 1;
      continue;
    }
    fillIndicesBuffer[fillPixels++] = p;
  }

  if (fillPixels < minAreaPixels) {
    return {
      ok: false,
      reason: "no-safe-interior",
      message: "境界から安全距離を取ると非粒界領域が残りません。",
      seed,
      regionPixels: tail,
      fillPixels,
    };
  }

  const fillIndices = fillIndicesBuffer.slice(0, fillPixels);
  let fillMask = null;
  if (options.returnMask !== false) {
    fillMask = new Uint8Array(width * height);
    for (const p of fillIndices) fillMask[p] = 1;
  }

  return {
    ok: true,
    seed,
    fillMask,
    fillIndices,
    regionPixels: tail,
    fillPixels,
    excludedPixels,
    safetyMargin,
    wallRadius,
    bounds: { x0: minX, y0: minY, x1: maxX, y1: maxY },
  };
}

export function rebuildClosedNegativeFillMask(
  referenceCenterline,
  seeds,
  width,
  height,
  options = {},
) {
  const mask = new Uint8Array(width * height);
  const results = [];
  let validSeeds = 0;
  let invalidSeeds = 0;

  for (let index = 0; index < (seeds?.length ?? 0); index += 1) {
    const result = computeClosedNegativeFill(
      referenceCenterline,
      width,
      height,
      seeds[index],
      { ...options, returnMask: false },
    );
    results.push({
      index,
      ok: result.ok,
      reason: result.reason ?? null,
      message: result.message ?? null,
      seed: result.seed ?? normalizeSeed(seeds[index], width, height),
      regionPixels: result.regionPixels ?? 0,
      fillPixels: result.fillPixels ?? 0,
      bounds: result.bounds ?? null,
    });
    if (!result.ok) {
      invalidSeeds += 1;
      continue;
    }
    validSeeds += 1;
    for (const p of result.fillIndices) mask[p] = 1;
  }

  let fillPixels = 0;
  for (let p = 0; p < mask.length; p += 1) fillPixels += mask[p] ? 1 : 0;

  return {
    mask,
    results,
    seedCount: seeds?.length ?? 0,
    validSeeds,
    invalidSeeds,
    fillPixels,
  };
}

export function countNewFillPixels(candidateMask, existingMask) {
  let count = 0;
  for (let p = 0; p < candidateMask.length; p += 1) {
    if (candidateMask[p] && !existingMask?.[p]) count += 1;
  }
  return count;
}
