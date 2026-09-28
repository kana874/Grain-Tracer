function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function buildIntegral(values, width, height, square = false) {
  const stride = width + 1;
  const integral = new Float64Array((width + 1) * (height + 1));
  for (let y = 0; y < height; y += 1) {
    let rowSum = 0;
    const src = y * width;
    const dst = (y + 1) * stride;
    const prev = y * stride;
    for (let x = 0; x < width; x += 1) {
      const value = values[src + x];
      rowSum += square ? value * value : value;
      integral[dst + x + 1] = integral[prev + x + 1] + rowSum;
    }
  }
  return integral;
}

function rectSum(integral, width, x0, y0, x1, y1) {
  const stride = width + 1;
  return integral[y1 * stride + x1]
    - integral[y0 * stride + x1]
    - integral[y1 * stride + x0]
    + integral[y0 * stride + x0];
}

export async function computeLocalLuminanceNormalization(luma, width, height, options = {}) {
  const radius = Math.max(8, Math.round(options.radius ?? 48));
  const strength = Math.max(0, Math.min(1, options.strength ?? 0.7));
  const onProgress = options.onProgress ?? (() => {});
  const integral = buildIntegral(luma, width, height, false);
  const integralSq = buildIntegral(luma, width, height, true);
  const dark = new Uint8Array(width * height);

  for (let y = 0; y < height; y += 1) {
    const y0 = Math.max(0, y - radius);
    const y1 = Math.min(height, y + radius + 1);
    for (let x = 0; x < width; x += 1) {
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(width, x + radius + 1);
      const area = (x1 - x0) * (y1 - y0);
      const sum = rectSum(integral, width, x0, y0, x1, y1);
      const sumSq = rectSum(integralSq, width, x0, y0, x1, y1);
      const mean = sum / area;
      const variance = Math.max(1e-6, sumSq / area - mean * mean);
      const std = Math.sqrt(variance);
      const z = Math.max(0, (mean - luma[y * width + x]) / (std + 0.018));
      const relative = clamp01(z / 3.2);
      const absolute = clamp01((0.67 - luma[y * width + x]) / 0.57);
      const mixed = absolute * (1 - strength) + relative * strength;
      dark[y * width + x] = Math.round(clamp01(mixed) * 255);
    }
    if (y % 48 === 0 || y === height - 1) {
      onProgress((y + 1) / height);
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }

  return dark;
}

export function normalizeFeatureLocally(feature, width, height, options = {}) {
  const radius = Math.max(8, Math.round(options.radius ?? 48));
  const strength = Math.max(0, Math.min(1, options.strength ?? 0.7));
  if (strength <= 0) return feature.slice();

  const normalizedSource = new Float32Array(feature.length);
  for (let i = 0; i < feature.length; i += 1) normalizedSource[i] = feature[i] / 255;
  const integral = buildIntegral(normalizedSource, width, height, false);
  const out = new Uint8Array(feature.length);

  for (let y = 0; y < height; y += 1) {
    const y0 = Math.max(0, y - radius);
    const y1 = Math.min(height, y + radius + 1);
    for (let x = 0; x < width; x += 1) {
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(width, x + radius + 1);
      const area = (x1 - x0) * (y1 - y0);
      const localMean = rectSum(integral, width, x0, y0, x1, y1) / area;
      const raw = normalizedSource[y * width + x];
      const relative = clamp01(raw / (localMean * 2.15 + 0.035));
      const mixed = raw * (1 - strength) + relative * strength;
      out[y * width + x] = Math.round(clamp01(mixed) * 255);
    }
  }
  return out;
}
