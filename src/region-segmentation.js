import { dilateBinaryMask } from './evaluation.js';

// Marker-controlled minimax watershed: crossing a strong boundary costs more
// than growing within a grain. Labels are inferred, never treated as truth.
export async function segmentSeededRegions(width, height, options = {}) {
  const size = width * height;
  if (!Number.isInteger(size) || size <= 0) throw new Error('画像サイズが不正です。');
  const exclusion = options.exclusionMask;
  const fill = options.closedNegativeMask;
  const labels = new Int32Array(size), levels = new Uint16Array(size).fill(256);
  const markers = new Uint8Array(size), queue = new Int32Array(size);
  const buckets = Array.from({ length: 256 }, () => []);
  const evidence = p => Math.max(0, Math.min(1, Math.max(
    Number(options.ridge?.[p] ?? 0), Number(options.color?.[p] ?? 0),
    Number(options.boundaryProbability?.[p] ?? 0)) * (1 - 0.5 * Number(options.dendritePenalty?.[p] ?? 0))));
  const neighbors = p => {
    const x = p % width, y = Math.floor(p / width), out = [];
    if (x > 0) out.push(p - 1);
    if (x + 1 < width) out.push(p + 1);
    if (y > 0) out.push(p - width);
    if (y + 1 < height) out.push(p + width);
    return out;
  };
  let seedCount = 0;
  for (const seed of options.seeds ?? []) {
    if (seed.borderAssisted) continue;
    const x = Math.round(seed.x), y = Math.round(seed.y);
    if (x < 0 || x >= width || y < 0 || y >= height) continue;
    const p = y * width + x;
    if (exclusion?.[p] || labels[p]) continue;
    seedCount++;
    let head = 0, tail = 0;
    queue[tail++] = p; labels[p] = seedCount;
    while (head < tail) {
      const q = queue[head++]; markers[q] = 1; levels[q] = 0; buckets[0].push(q);
      if (!fill?.[p]) continue;
      for (const np of neighbors(q)) if (fill[np] && !exclusion?.[np] && !labels[np]) {
        labels[np] = seedCount; queue[tail++] = np;
      }
    }
  }
  if (seedCount < 2) throw new Error('領域分割には別々の粒内種点が2個以上必要です。');
  let processed = 0;
  for (let level = 0; level < 256; level++) {
    const bucket = buckets[level];
    for (let head = 0; head < bucket.length; head++) {
      const p = bucket[head];
      if (levels[p] !== level) continue;
      for (const np of neighbors(p)) {
        if (exclusion?.[np] || markers[np]) continue;
        const next = Math.max(level, Math.round(evidence(np) * 255));
        if (next >= levels[np]) continue;
        levels[np] = next; labels[np] = labels[p]; buckets[next].push(np);
      }
      if (++processed % 20000 === 0) {
        options.onProgress?.(Math.min(0.99, processed / size));
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }
    buckets[level] = null;
  }
  const rawBoundary = new Uint8Array(size), mask = new Uint8Array(size);
  const negative = options.negativeMask?.length === size
    ? dilateBinaryMask(options.negativeMask, width, height, 1) : null;
  let rawPixels = 0, supportedPixels = 0;
  for (let p = 0; p < size; p++) {
    if (!labels[p]) continue;
    const x = p % width, y = Math.floor(p / width);
    for (const q of [x + 1 < width ? p + 1 : -1, y + 1 < height ? p + width : -1]) {
      if (q < 0 || !labels[q] || labels[p] === labels[q]) continue;
      const b = evidence(p) >= evidence(q) ? p : q;
      rawBoundary[b] = 1;
    }
  }
  for (let p = 0; p < size; p++) if (rawBoundary[p]) {
    rawPixels++;
    const x = p % width, y = Math.floor(p / width);
    if (x === 0 || y === 0 || x === width - 1 || y === height - 1 || exclusion?.[p] || negative?.[p]) continue;
    if (evidence(p) < (options.minEvidence ?? 0.15)) continue;
    mask[p] = 1; supportedPixels++;
  }
  return { mask, rawBoundary, labels, summary: { revision: '1.0-marker-minimax-watershed',
    seedCount, rawBoundaryPixels: rawPixels, supportedBoundaryPixels: supportedPixels,
    unsupportedOrProtectedPixels: rawPixels - supportedPixels, processedPixels: processed,
    minEvidence: options.minEvidence ?? 0.15 } };
}
