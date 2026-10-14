// Pure geometry and review helpers for the local A/B comparator.
// Coordinates are always GrainTracer preview pixels, never source BMP pixels.
export function positionLocalRoi(width, height, size, cx, cy) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new Error("invalid preview dimensions");
  const extent = Math.max(32, Math.min(1024, Math.round(size)));
  const w = Math.min(width, extent), h = Math.min(height, extent);
  return { x: Math.max(0, Math.min(width - w, Math.round(cx - w / 2))),
    y: Math.max(0, Math.min(height - h, Math.round(cy - h / 2))), width: w, height: h };
}
export function withinLocalRoi(roi, x, y) {
  return Boolean(roi && x >= roi.x && x < roi.x + roi.width && y >= roi.y && y < roi.y + roi.height);
}
export function localAbCounts(maskA, maskB, width, roi, exclusionMask = null) {
  if (!maskA || !maskB || maskA.length !== maskB.length || maskA.length % width) throw new Error("invalid candidate masks");
  const height = maskA.length / width, output = { a: 0, b: 0, onlyA: 0, onlyB: 0, shared: 0 };
  if (roi.x < 0 || roi.y < 0 || roi.x + roi.width > width || roi.y + roi.height > height) throw new Error("ROI out of bounds");
  for (let y = roi.y; y < roi.y + roi.height; y++) {
    for (let x = roi.x; x < roi.x + roi.width; x++) {
      const p = y * width + x;
      if (exclusionMask?.[p]) continue;
      const a = Boolean(maskA[p]), b = Boolean(maskB[p]);
      if (a) output.a++;
      if (b) output.b++;
      if (a && b) output.shared++;
      else if (a) output.onlyA++;
      else if (b) output.onlyB++;
    }
  }
  return output;
}
export function filterLocalReview(indices, width, roi, exclusionMask = null) {
  return indices.filter(p => withinLocalRoi(roi, p % width, Math.floor(p / width)) && !exclusionMask?.[p]);
}
