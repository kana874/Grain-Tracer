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

export function buildRectMask(rects, width, height) {
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

export function buildExclusionMask(rects, width, height) {
  return buildRectMask(rects, width, height);
}

export function applyExclusionMask(mask, exclusionMask) {
  if (!mask || !exclusionMask) return mask;
  for (let p = 0; p < mask.length; p += 1) {
    if (exclusionMask[p]) mask[p] = 0;
  }
  return mask;
}

export function hitTestRect(rects, point, threshold = 6) {
  const t = Math.max(1, threshold);
  for (let index = (rects?.length ?? 0) - 1; index >= 0; index -= 1) {
    const rect = rects[index];
    const nearLeft = Math.abs(point.x - rect.x0) <= t;
    const nearRight = Math.abs(point.x - rect.x1) <= t;
    const nearTop = Math.abs(point.y - rect.y0) <= t;
    const nearBottom = Math.abs(point.y - rect.y1) <= t;
    const withinX = point.x >= rect.x0 - t && point.x <= rect.x1 + t;
    const withinY = point.y >= rect.y0 - t && point.y <= rect.y1 + t;

    if (nearLeft && nearTop) return { index, mode: "nw" };
    if (nearRight && nearTop) return { index, mode: "ne" };
    if (nearRight && nearBottom) return { index, mode: "se" };
    if (nearLeft && nearBottom) return { index, mode: "sw" };
    if (nearTop && withinX) return { index, mode: "n" };
    if (nearRight && withinY) return { index, mode: "e" };
    if (nearBottom && withinX) return { index, mode: "s" };
    if (nearLeft && withinY) return { index, mode: "w" };
    if (point.x >= rect.x0 && point.x <= rect.x1 && point.y >= rect.y0 && point.y <= rect.y1) {
      return { index, mode: "move" };
    }
  }
  return null;
}

export function transformRect(original, start, current, mode, width, height) {
  const rect = { ...original };
  const dx = current.x - start.x;
  const dy = current.y - start.y;

  if (mode === "move") {
    const w = original.x1 - original.x0;
    const h = original.y1 - original.y0;
    let x0 = Math.round(original.x0 + dx);
    let y0 = Math.round(original.y0 + dy);
    x0 = clamp(x0, 0, Math.max(0, width - 1 - w));
    y0 = clamp(y0, 0, Math.max(0, height - 1 - h));
    return { x0, y0, x1: x0 + w, y1: y0 + h };
  }

  if (mode.includes("w")) rect.x0 = Math.round(original.x0 + dx);
  if (mode.includes("e")) rect.x1 = Math.round(original.x1 + dx);
  if (mode.includes("n")) rect.y0 = Math.round(original.y0 + dy);
  if (mode.includes("s")) rect.y1 = Math.round(original.y1 + dy);

  rect.x0 = clamp(rect.x0, 0, width - 1);
  rect.x1 = clamp(rect.x1, 0, width - 1);
  rect.y0 = clamp(rect.y0, 0, height - 1);
  rect.y1 = clamp(rect.y1, 0, height - 1);

  if (rect.x0 > rect.x1) [rect.x0, rect.x1] = [rect.x1, rect.x0];
  if (rect.y0 > rect.y1) [rect.y0, rect.y1] = [rect.y1, rect.y0];
  return rect;
}

function renderRectCanvas(
  canvas,
  rects,
  width,
  height,
  previewRect,
  selectedIndex,
  handleSize,
  palette,
) {
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, width, height);

  const draw = (rect, index = -1, preview = false) => {
    if (!rect) return;
    const selected = index === selectedIndex && !preview;
    const x = rect.x0;
    const y = rect.y0;
    const w = rect.x1 - rect.x0 + 1;
    const h = rect.y1 - rect.y0 + 1;
    ctx.save();
    ctx.fillStyle = preview ? palette.previewFill : selected ? palette.selectedFill : palette.fill;
    ctx.strokeStyle = preview ? palette.previewStroke : selected ? palette.selectedStroke : palette.stroke;
    ctx.lineWidth = preview || selected ? 2 : 1;
    ctx.setLineDash(preview ? [8, 5] : selected ? [] : [5, 4]);
    ctx.fillRect(x, y, w, h);
    ctx.strokeRect(x + 0.5, y + 0.5, Math.max(0, w - 1), Math.max(0, h - 1));

    if (selected) {
      const hs = Math.max(4, handleSize);
      const half = hs / 2;
      const mx = (rect.x0 + rect.x1) / 2;
      const my = (rect.y0 + rect.y1) / 2;
      const handles = [
        [rect.x0, rect.y0], [mx, rect.y0], [rect.x1, rect.y0],
        [rect.x1, my], [rect.x1, rect.y1], [mx, rect.y1],
        [rect.x0, rect.y1], [rect.x0, my],
      ];
      ctx.setLineDash([]);
      ctx.fillStyle = palette.handleFill;
      ctx.strokeStyle = palette.handleStroke;
      ctx.lineWidth = 1;
      for (const [hx, hy] of handles) {
        ctx.fillRect(hx - half, hy - half, hs, hs);
        ctx.strokeRect(hx - half, hy - half, hs, hs);
      }
    }
    ctx.restore();
  };

  for (let index = 0; index < (rects?.length ?? 0); index += 1) draw(rects[index], index, false);
  if (previewRect) draw(previewRect, -1, true);
}

export function renderExclusionCanvas(
  canvas,
  rects,
  width,
  height,
  previewRect = null,
  selectedIndex = -1,
  handleSize = 8,
) {
  renderRectCanvas(canvas, rects, width, height, previewRect, selectedIndex, handleSize, {
    fill: "rgba(120, 130, 145, 0.28)",
    stroke: "rgba(190, 198, 210, 0.78)",
    selectedFill: "rgba(130, 145, 165, 0.34)",
    selectedStroke: "rgba(245, 248, 255, 0.98)",
    previewFill: "rgba(150, 160, 175, 0.20)",
    previewStroke: "rgba(220, 225, 235, 0.95)",
    handleFill: "rgba(245, 248, 255, 0.95)",
    handleStroke: "rgba(40, 46, 56, 0.95)",
  });
}

export function renderFullEvaluationRoiCanvas(
  canvas,
  rects,
  width,
  height,
  previewRect = null,
  selectedIndex = -1,
  handleSize = 8,
) {
  renderRectCanvas(canvas, rects, width, height, previewRect, selectedIndex, handleSize, {
    fill: "rgba(66, 170, 255, 0.10)",
    stroke: "rgba(98, 190, 255, 0.82)",
    selectedFill: "rgba(66, 170, 255, 0.16)",
    selectedStroke: "rgba(180, 225, 255, 0.98)",
    previewFill: "rgba(66, 170, 255, 0.08)",
    previewStroke: "rgba(180, 225, 255, 0.98)",
    handleFill: "rgba(180, 225, 255, 0.98)",
    handleStroke: "rgba(25, 55, 80, 0.98)",
  });
}

export function countMaskPixels(mask) {
  if (!mask) return 0;
  let count = 0;
  for (let i = 0; i < mask.length; i += 1) count += mask[i] ? 1 : 0;
  return count;
}
