function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function includePoint(bounds, x, y) {
  if (!bounds) return { x0: x, y0: y, x1: x, y1: y };
  bounds.x0 = Math.min(bounds.x0, x);
  bounds.y0 = Math.min(bounds.y0, y);
  bounds.x1 = Math.max(bounds.x1, x);
  bounds.y1 = Math.max(bounds.y1, y);
  return bounds;
}

export function createReferenceEditTracker() {
  return {
    before: new Map(),
    bounds: null,
    segmentBounds: null,
  };
}

function setCenterlinePixel(mask, width, height, x, y, value, tracker) {
  const sx = Math.round(x);
  const sy = Math.round(y);
  if (sx < 0 || sy < 0 || sx >= width || sy >= height) return false;
  const index = sy * width + sx;
  const previous = mask[index];
  if (previous === value) return false;
  if (!tracker.before.has(index)) tracker.before.set(index, previous);
  mask[index] = value;
  tracker.bounds = includePoint(tracker.bounds, sx, sy);
  tracker.segmentBounds = includePoint(tracker.segmentBounds, sx, sy);
  return true;
}

function eraseDisk(mask, width, height, cx, cy, radius, tracker) {
  const r = Math.max(0, radius);
  const x0 = Math.max(0, Math.floor(cx - r));
  const x1 = Math.min(width - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const y1 = Math.min(height - 1, Math.ceil(cy + r));
  const rr = r * r;
  let changed = false;
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy > rr) continue;
      if (setCenterlinePixel(mask, width, height, x, y, 0, tracker)) changed = true;
    }
  }
  return changed;
}

export function paintReferenceCenterlineSegment(mask, width, height, from, to, options, tracker) {
  tracker.segmentBounds = null;
  const erase = Boolean(options?.erase);
  const eraseRadius = Math.max(1, Number(options?.eraseRadius ?? 1));
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) * 1.5));
  let changed = false;

  for (let step = 0; step <= steps; step += 1) {
    const t = step / steps;
    const x = from.x + dx * t;
    const y = from.y + dy * t;
    if (erase) {
      if (eraseDisk(mask, width, height, x, y, eraseRadius, tracker)) changed = true;
    } else if (setCenterlinePixel(mask, width, height, x, y, 1, tracker)) {
      changed = true;
    }
  }
  return changed && tracker.segmentBounds ? { ...tracker.segmentBounds } : null;
}

export function finalizeReferenceEdit(mask, tracker) {
  if (!tracker?.before?.size || !tracker.bounds) return null;
  const indices = [];
  const before = [];
  const after = [];
  for (const [index, previous] of tracker.before) {
    const current = mask[index];
    if (current === previous) continue;
    indices.push(index);
    before.push(previous);
    after.push(current);
  }
  if (!indices.length) return null;
  return {
    indices: Int32Array.from(indices),
    before: Uint8Array.from(before),
    after: Uint8Array.from(after),
    bounds: { ...tracker.bounds },
  };
}

export function applyReferenceHistoryEntry(mask, entry, direction = "undo") {
  const values = direction === "redo" ? entry.after : entry.before;
  for (let i = 0; i < entry.indices.length; i += 1) {
    mask[entry.indices[i]] = values[i];
  }
  return { ...entry.bounds };
}

export function buildClearReferenceEntry(mask, width, height) {
  const indices = [];
  let bounds = null;
  for (let index = 0; index < mask.length; index += 1) {
    if (!mask[index]) continue;
    indices.push(index);
    const x = index % width;
    const y = Math.floor(index / width);
    bounds = includePoint(bounds, x, y);
  }
  if (!indices.length || !bounds) return null;
  return {
    indices: Int32Array.from(indices),
    before: new Uint8Array(indices.length).fill(1),
    after: new Uint8Array(indices.length),
    bounds,
  };
}

export function expandBounds(bounds, padding, width, height) {
  if (!bounds) return null;
  const p = Math.max(0, Math.ceil(padding));
  return {
    x0: clamp(Math.floor(bounds.x0) - p, 0, width - 1),
    y0: clamp(Math.floor(bounds.y0) - p, 0, height - 1),
    x1: clamp(Math.ceil(bounds.x1) + p, 0, width - 1),
    y1: clamp(Math.ceil(bounds.y1) + p, 0, height - 1),
  };
}

export function rebuildReferenceMaskRegion(centerline, mask, width, height, radius, changedBounds) {
  if (!changedBounds) return null;
  const r = Math.max(0, Math.round(radius));
  const target = expandBounds(changedBounds, r, width, height);
  if (!target) return null;

  for (let y = target.y0; y <= target.y1; y += 1) {
    for (let x = target.x0; x <= target.x1; x += 1) {
      let found = false;
      const sy0 = Math.max(0, y - r);
      const sy1 = Math.min(height - 1, y + r);
      const sx0 = Math.max(0, x - r);
      const sx1 = Math.min(width - 1, x + r);
      for (let sy = sy0; sy <= sy1 && !found; sy += 1) {
        const base = sy * width;
        for (let sx = sx0; sx <= sx1; sx += 1) {
          if (centerline[base + sx]) {
            found = true;
            break;
          }
        }
      }
      mask[y * width + x] = found ? 1 : 0;
    }
  }
  return target;
}

export function renderReferenceMaskRegion(canvas, mask, width, bounds, opacity = 0.5, color = [255, 216, 74]) {
  if (!bounds) return;
  const x0 = bounds.x0;
  const y0 = bounds.y0;
  const regionWidth = bounds.x1 - bounds.x0 + 1;
  const regionHeight = bounds.y1 - bounds.y0 + 1;
  const rgba = new Uint8ClampedArray(regionWidth * regionHeight * 4);
  const alpha = Math.round(255 * clamp(opacity, 0.05, 1));

  for (let ry = 0; ry < regionHeight; ry += 1) {
    const y = y0 + ry;
    for (let rx = 0; rx < regionWidth; rx += 1) {
      const x = x0 + rx;
      if (!mask[y * width + x]) continue;
      const i = (ry * regionWidth + rx) * 4;
      rgba[i] = color[0] ?? 255;
      rgba[i + 1] = color[1] ?? 216;
      rgba[i + 2] = color[2] ?? 74;
      rgba[i + 3] = alpha;
    }
  }

  const ctx = canvas.getContext("2d");
  ctx.clearRect(x0, y0, regionWidth, regionHeight);
  ctx.putImageData(new ImageData(rgba, regionWidth, regionHeight), x0, y0);
}


export function renderBinaryMaskCanvas(canvas, mask, width, height, opacity = 0.5, color = [255, 216, 74]) {
  const bounds = { x0: 0, y0: 0, x1: width - 1, y1: height - 1 };
  renderReferenceMaskRegion(canvas, mask, width, bounds, opacity, color);
}
