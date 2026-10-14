/**
 * Ensure a candidate closed-negative fill does not change any pixel outside
 * the actively reviewed Validation ROI. Check the proposed region label
 * rather than comparing against the combined mask; prior fill seeds may
 * already contain pixels outside the draft.
 */
export function checkValidationFillBounds(regionIndex, result, roi) {
  if (!roi) return { allowed: true, reason: null };
  if (!regionIndex || !regionIndex.labels || !regionIndex.safetyMask
      || !result?.accepted || !Number.isInteger(result.label) || result.label <= 0) {
    return { allowed: false, reason: 'invalid-fill' };
  }
  const { width, height, labels, safetyMask } = regionIndex;
  if (!Number.isInteger(width) || !Number.isInteger(height)
      || labels.length !== width * height || safetyMask.length !== labels.length) {
    return { allowed: false, reason: 'invalid-region-index' };
  }
  const x0=Math.max(0,Math.ceil(Math.min(roi.x0,roi.x1)));
  const y0=Math.max(0,Math.ceil(Math.min(roi.y0,roi.y1)));
  const x1=Math.min(width-1,Math.floor(Math.max(roi.x0,roi.x1)));
  const y1=Math.min(height-1,Math.floor(Math.max(roi.y0,roi.y1)));
  if (x1<x0 || y1<y0) return { allowed:false, reason:'invalid-roi' };
  let inside=0,outside=0;
  for (let p=0;p<labels.length;p++) {
    if (labels[p] !== result.label || safetyMask[p]) continue;
    const x=p%width,y=Math.floor(p/width);
    if(x<x0||x>x1||y<y0||y>y1)outside++;
    else inside++;
    // Early exit when any affected pixel crosses the ROI.
    if(outside) return {allowed:false,reason:'outside-validation-roi',insidePixels:inside,outsidePixels:outside};
  }
  return {allowed:true,reason:null,insidePixels:inside,outsidePixels:0};
}
