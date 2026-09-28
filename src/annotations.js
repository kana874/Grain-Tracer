function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function normalizeRect(start, end, width, height) {
  const x0 = clamp(Math.floor(Math.min(start.x, end.x)), 0, width - 1);
  const y0 = clamp(Math.floor(Math.min(start.y, end.y)), 0, height - 1);
  const x1 = clamp(Math.ceil(Math.max(start.x, end.x)), 0, width - 1);
  const y1 = clamp(Math.ceil(Math.max(start.y, end.y)), 0, height - 1);
  return { x0, y0, x1, y1 };
}

export function rectArea(rect) {
  if (!rect) return 0;
  return Math.max(0, rect.x1 - rect.x0 + 1) * Math.max(0, rect.y1 - rect.y0 + 1);
}

export function buildExclusionMask(rects, width, height) {
  const mask = new Uint8Array(width * height);
  for (const rect of rects ?? []) {
    const x0 = clamp(Math.round(rect.x0), 0, width - 1);
    const x1 = clamp(Math.round(rect.x1), 0, width - 1);
    const y0 = clamp(Math.round(rect.y0), 0, height - 1);
    const y1 = clamp(Math.round(rect.y1), 0, height - 1);
    for (let y = y0; y <= y1; y += 1) {
      mask.fill(1, y * width + x0, y * width + x1 + 1);
    }
  }
  return mask;
}

export function applyExclusionMask(mask, exclusionMask) {
  if (!mask || !exclusionMask) return mask;
  for (let p = 0; p < mask.length; p += 1) {
    if (exclusionMask[p]) mask[p] = 0;
  }
  return mask;
}

export function renderExclusionCanvas(canvas, rects, width, height, previewRect = null) {
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, width, height);

  const draw = (rect, preview = false) => {
    if (!rect) return;
    const x = rect.x0;
    const y = rect.y0;
    const w = rect.x1 - rect.x0 + 1;
    const h = rect.y1 - rect.y0 + 1;
    ctx.save();
    ctx.fillStyle = preview ? "rgba(150, 160, 175, 0.20)" : "rgba(120, 130, 145, 0.28)";
    ctx.strokeStyle = preview ? "rgba(220, 225, 235, 0.95)" : "rgba(190, 198, 210, 0.78)";
    ctx.lineWidth = preview ? 2 : 1;
    ctx.setLineDash(preview ? [8, 5] : [5, 4]);
    ctx.fillRect(x, y, w, h);
    ctx.strokeRect(x + 0.5, y + 0.5, Math.max(0, w - 1), Math.max(0, h - 1));
    ctx.restore();
  };

  for (const rect of rects ?? []) draw(rect, false);
  if (previewRect) draw(previewRect, true);
}

export function countMaskPixels(mask) {
  if (!mask) return 0;
  let count = 0;
  for (let i = 0; i < mask.length; i += 1) count += mask[i] ? 1 : 0;
  return count;
}
