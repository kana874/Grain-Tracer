// Feedback Learning v2: exact, short, branch-safe partial labels.
// Do NOT flood-fill a connected boundary network: touching/parallel lines can
// share 8-neighbour connections and receive the wrong label.
export function selectFeedbackSegment(mask, width, height, point, options = {}) {
  if (!mask || mask.length !== width * height || !point ||
      !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
  if (point.x < 0 || point.y < 0 || point.x >= width || point.y >= height) return null;

  const searchRadius = Math.max(0, Math.min(3, Math.round(options.searchRadius ?? 2)));
  const maxPixels = Math.max(1, Math.min(9, Math.round(options.maxPixels ?? 3)));
  const exclusionMask = options.exclusionMask ?? null;
  const cx = Math.round(point.x), cy = Math.round(point.y);
  let seed = -1, best = Infinity;
  for (let dy = -searchRadius; dy <= searchRadius; dy++) {
    for (let dx = -searchRadius; dx <= searchRadius; dx++) {
      const x = cx + dx, y = cy + dy;
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      const d2 = dx * dx + dy * dy;
      if (d2 > searchRadius * searchRadius || d2 >= best) continue;
      const p = y * width + x;
      if (mask[p] && !exclusionMask?.[p]) { seed = p; best = d2; }
    }
  }
  if (seed < 0) return null;
  const neighbors = index => {
    const x = index % width, y = Math.floor(index / width), out = [];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const next = ny * width + nx;
        if (mask[next] && !exclusionMask?.[next]) out.push(next);
      }
    }
    return out;
  };
  const indices = [seed];
  // A seed on a junction, thick area or touching neighbour is only a
  // single-pixel judgment. Never cross a branch or guess which way to turn.
  const roots = neighbors(seed);
  if (maxPixels > 1 && roots.length <= 2) {
    const arms = roots.map(next => ({ current: next, previous: seed, stopped: false }));
    while (indices.length < maxPixels && arms.some(arm => !arm.stopped)) {
      for (const arm of arms) {
        if (arm.stopped || indices.length >= maxPixels) continue;
        if (indices.includes(arm.current)) { arm.stopped = true; continue; }
        // Do not include a junction pixel: even its first step is ambiguous.
        const adjacent = neighbors(arm.current);
        if (adjacent.length > 2 || !adjacent.includes(arm.previous)) {
          arm.stopped = true;
          continue;
        }
        indices.push(arm.current);
        const onward = adjacent.filter(next => next !== arm.previous && !indices.includes(next));
        if (onward.length !== 1) {
          arm.stopped = true;
        } else {
          arm.previous = arm.current;
          arm.current = onward[0];
        }
      }
    }
  }
  return { indices, anchor: { x: seed % width, y: Math.floor(seed / width) },
    snappedDistance: Math.sqrt(best), truncated: false };
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
