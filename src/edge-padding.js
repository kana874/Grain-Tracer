// Symmetric reflection at the true image edge: feature kernels can evaluate
// the last source pixel without treating a zero-filled frame as real evidence.
export function mirrorCoord(value, size) {
  if (!Number.isInteger(size) || size < 1) throw new Error("invalid image extent");
  if (size === 1) return 0;
  const period = 2 * size - 2;
  const n = ((Math.round(value) % period) + period) % period;
  return n < size ? n : period - n;
}
export function reflectPadRgba(image, pad = 24) {
  const { width, height, data } = image;
  if (!width || !height || data?.length !== width * height * 4) throw new Error("invalid image");
  const margin = Math.max(0, Math.min(128, Math.round(pad)));
  const w = width + margin * 2, h = height + margin * 2;
  const pixels = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy = mirrorCoord(y - margin, height);
    for (let x = 0; x < w; x++) {
      const sx = mirrorCoord(x - margin, width), inBase = (sy * width + sx) * 4;
      const outBase = (y * w + x) * 4;
      pixels[outBase] = data[inBase];
      pixels[outBase + 1] = data[inBase + 1];
      pixels[outBase + 2] = data[inBase + 2];
      pixels[outBase + 3] = data[inBase + 3];
    }
  }
  return { data: pixels, width: w, height: h };
}
export function cropPaddedFeatures(features, originalWidth, originalHeight, pad) {
  const fullWidth = features.width, fullHeight = features.height;
  if (originalWidth + pad * 2 !== fullWidth || originalHeight + pad * 2 !== fullHeight) {
    throw new Error("feature-padding geometry mismatch");
  }
  const result = { ...features, width: originalWidth, height: originalHeight };
  for (const [name, plane] of Object.entries(features)) {
    if (!ArrayBuffer.isView(plane) || plane.length !== fullWidth * fullHeight) continue;
    const cropped = new plane.constructor(originalWidth * originalHeight);
    for (let y = 0; y < originalHeight; y++) {
      cropped.set(plane.subarray((y + pad) * fullWidth + pad, (y + pad) * fullWidth + pad + originalWidth), y * originalWidth);
    }
    result[name] = cropped;
  }
  result.featureMargins = Object.fromEntries(
    Object.keys(features.featureMargins ?? {}).map(name => [name, 0]),
  );
  result.edgePaddingPixels = pad;
  return result;
}
