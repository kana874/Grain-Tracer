// Feedback Learning v1: local review regions are partial labels, never complete-ROI truth.
// Restrict every approval to a small connected patch to avoid accidentally labelling
// a complete grain network when the predicted boundary has junctions.
export function selectFeedbackSegment(mask, width, height, point, options = {}) {
  if (!mask || mask.length !== width * height || !point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
  const searchRadius = Math.max(0, Math.min(12, Math.round(options.searchRadius ?? 5)));
  const maxDistance = Math.max(1, Math.min(32, Math.round(options.maxDistance ?? 12)));
  const maxPixels = Math.max(1, Math.min(256, Math.round(options.maxPixels ?? 120)));
  const excluded = options.exclusionMask ?? null;
  const cx = Math.round(point.x), cy = Math.round(point.y);
  let seed = -1, best = Infinity;
  for (let dy = -searchRadius; dy <= searchRadius; dy++) {
    for (let dx = -searchRadius; dx <= searchRadius; dx++) {
      const x = cx + dx, y = cy + dy;
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      const d2 = dx * dx + dy * dy;
      if (d2 > searchRadius * searchRadius || d2 >= best) continue;
      const p = y * width + x;
      if (mask[p] && !excluded?.[p]) { seed = p; best = d2; }
    }
  }
  if (seed < 0) return null;
  const sx = seed % width, sy = Math.floor(seed / width);
  const queue = [seed], seen = new Set([seed]), indices = [];
  let head = 0;
  while (head < queue.length && indices.length < maxPixels) {
    const p = queue[head++], x = p % width, y = Math.floor(p / width);
    indices.push(p);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        if ((nx - sx) ** 2 + (ny - sy) ** 2 > maxDistance * maxDistance) continue;
        const np = ny * width + nx;
        if (seen.has(np) || !mask[np] || excluded?.[np]) continue;
        seen.add(np);
        queue.push(np);
      }
    }
  }
  return { indices, anchor: { x: sx, y: sy }, truncated: head < queue.length };
}

// Explicit two-point missing boundary correction. A sampled path through any
// excluded pixel is refused rather than modifying excluded / holdout material.
export function buildFeedbackConnection(start, end, width, height, options = {}) {
  if (!start || !end || ![start.x, start.y, end.x, end.y].every(Number.isFinite)) return null;
  const ax = Math.round(start.x), ay = Math.round(start.y);
  const bx = Math.round(end.x), by = Math.round(end.y);
  if ([ax, bx].some(x => x < 0 || x >= width) || [ay, by].some(y => y < 0 || y >= height)) return null;
  const distance = Math.hypot(bx - ax, by - ay);
  const maxLength = Math.max(2, Math.min(150, Number(options.maxLength ?? 80)));
  if (distance < 1 || distance > maxLength) return null;
  const count = Math.ceil(Math.max(Math.abs(bx - ax), Math.abs(by - ay)));
  const indices = [], visited = new Set();
  for (let i = 0; i <= count; i++) {
    const x = Math.round(ax + (bx - ax) * i / count);
    const y = Math.round(ay + (by - ay) * i / count);
    const p = y * width + x;
    if (options.exclusionMask?.[p]) return null;
    if (!visited.has(p)) { indices.push(p); visited.add(p); }
  }
  return { indices, anchor: { x: ax, y: ay }, end: { x: bx, y: by } };
}
