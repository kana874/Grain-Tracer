import { orientationNormal } from "./ridge.js";

function boxBlurFloat(source, width, height, radius) {
  const r = Math.max(1, Math.round(radius));
  const temp = new Float32Array(source.length);
  const out = new Float32Array(source.length);

  for (let y = 0; y < height; y += 1) {
    const base = y * width;
    let sum = 0;
    let count = 0;
    for (let x = 0; x <= Math.min(width - 1, r); x += 1) {
      sum += source[base + x];
      count += 1;
    }
    for (let x = 0; x < width; x += 1) {
      temp[base + x] = sum / Math.max(1, count);
      const removeX = x - r;
      const addX = x + r + 1;
      if (removeX >= 0) { sum -= source[base + removeX]; count -= 1; }
      if (addX < width) { sum += source[base + addX]; count += 1; }
    }
  }

  for (let x = 0; x < width; x += 1) {
    let sum = 0;
    let count = 0;
    for (let y = 0; y <= Math.min(height - 1, r); y += 1) {
      sum += temp[y * width + x];
      count += 1;
    }
    for (let y = 0; y < height; y += 1) {
      out[y * width + x] = sum / Math.max(1, count);
      const removeY = y - r;
      const addY = y + r + 1;
      if (removeY >= 0) { sum -= temp[removeY * width + x]; count -= 1; }
      if (addY < height) { sum += temp[addY * width + x]; count += 1; }
    }
  }
  return out;
}

function tensorPlane(luma, width, height, kind) {
  const out = new Float32Array(width * height);
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const p = y * width + x;
      const gx = (
        -luma[(y - 1) * width + x - 1] + luma[(y - 1) * width + x + 1]
        -2 * luma[y * width + x - 1] + 2 * luma[y * width + x + 1]
        -luma[(y + 1) * width + x - 1] + luma[(y + 1) * width + x + 1]
      ) * 0.125;
      const gy = (
        -luma[(y - 1) * width + x - 1] - 2 * luma[(y - 1) * width + x] - luma[(y - 1) * width + x + 1]
        +luma[(y + 1) * width + x - 1] + 2 * luma[(y + 1) * width + x] + luma[(y + 1) * width + x + 1]
      ) * 0.125;
      out[p] = kind === "xx" ? gx * gx : kind === "yy" ? gy * gy : gx * gy;
    }
  }
  return out;
}

export async function computeDendriteOrientation(luma, width, height, options = {}) {
  const radius = Math.max(2, Math.round(options.radius ?? 7));
  const onProgress = options.onProgress ?? (() => {});
  onProgress(0.02);

  const jxx = boxBlurFloat(tensorPlane(luma, width, height, "xx"), width, height, radius);
  onProgress(0.28);
  await new Promise(resolve => setTimeout(resolve, 0));
  const jyy = boxBlurFloat(tensorPlane(luma, width, height, "yy"), width, height, radius);
  onProgress(0.54);
  await new Promise(resolve => setTimeout(resolve, 0));
  const jxy = boxBlurFloat(tensorPlane(luma, width, height, "xy"), width, height, radius);
  onProgress(0.78);

  const orientation = new Uint8Array(width * height);
  const coherence = new Uint8Array(width * height);
  for (let p = 0; p < orientation.length; p += 1) {
    const xx = jxx[p];
    const yy = jyy[p];
    const xy = jxy[p];
    const theta = 0.5 * Math.atan2(2 * xy, xx - yy);
    const normalizedTheta = theta < 0 ? theta + Math.PI : theta;
    const denom = xx + yy + 1e-8;
    const coh = Math.sqrt((xx - yy) ** 2 + 4 * xy * xy) / denom;
    orientation[p] = Math.max(0, Math.min(255, Math.round((normalizedTheta / Math.PI) * 255)));
    coherence[p] = Math.max(0, Math.min(255, Math.round(Math.min(1, coh) * 255)));
  }
  onProgress(1);
  return { orientation, coherence, radius };
}

function sampleByte(plane, width, height, x, y) {
  const sx = Math.max(0, Math.min(width - 1, Math.round(x)));
  const sy = Math.max(0, Math.min(height - 1, Math.round(y)));
  return plane[sy * width + sx];
}

function directionDifference(aByte, bByte) {
  const a = (aByte / 255) * Math.PI;
  const b = (bByte / 255) * Math.PI;
  // 180-degree periodic orientation: cos(2*theta) maps theta and theta+pi together.
  return (1 - Math.cos(2 * (a - b))) * 0.5;
}

export async function computeDendriteDifference(
  dendriteOrientation,
  dendriteCoherence,
  ridgeOrientation,
  width,
  height,
  options = {},
) {
  const distances = options.distances ?? [5, 9, 13];
  const onProgress = options.onProgress ?? (() => {});
  const out = new Uint8Array(width * height);
  const margin = Math.max(...distances) + 1;

  for (let y = margin; y < height - margin; y += 1) {
    for (let x = margin; x < width - margin; x += 1) {
      const p = y * width + x;
      const normal = orientationNormal(ridgeOrientation[p]);
      let weighted = 0;
      let weightSum = 0;
      for (const distance of distances) {
        const oa = sampleByte(dendriteOrientation, width, height, x + normal.x * distance, y + normal.y * distance);
        const ob = sampleByte(dendriteOrientation, width, height, x - normal.x * distance, y - normal.y * distance);
        const ca = sampleByte(dendriteCoherence, width, height, x + normal.x * distance, y + normal.y * distance) / 255;
        const cb = sampleByte(dendriteCoherence, width, height, x - normal.x * distance, y - normal.y * distance) / 255;
        const confidence = Math.sqrt(ca * cb);
        const orientationChange = directionDifference(oa, ob);
        const coherenceChange = Math.abs(ca - cb) * 0.20;
        weighted += Math.min(1, orientationChange * confidence + coherenceChange) * (0.5 + confidence);
        weightSum += 0.5 + confidence;
      }
      out[p] = Math.round((weightSum ? weighted / weightSum : 0) * 255);
    }
    if (y % 40 === 0 || y === height - margin - 1) {
      onProgress((y - margin + 1) / Math.max(1, height - margin * 2));
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }
  return out;
}


export async function computeDendriteLinePenalty(
  ridge,
  color,
  dendriteDifference,
  dendriteOrientation,
  dendriteCoherence,
  ridgeOrientation,
  width,
  height,
  options = {},
) {
  const onProgress = options.onProgress ?? (() => {});
  const sideDistance = Math.max(2, Math.round(options.sideDistance ?? 6));
  const tangentDistances = options.tangentDistances ?? [4, 8];
  const parallelDistances = options.parallelDistances ?? [4, 8];
  const margin = Math.max(
    sideDistance,
    ...tangentDistances,
    ...parallelDistances,
  ) + 1;
  const out = new Uint8Array(width * height);

  const sampleNormalized = (plane, x, y) =>
    sampleByte(plane, width, height, x, y) / 255;

  for (let y = margin; y < height - margin; y += 1) {
    for (let x = margin; x < width - margin; x += 1) {
      const p = y * width + x;
      const ridgeStrength = (ridge?.[p] ?? 0) / 255;
      if (ridgeStrength < 0.08) continue;

      const normal = orientationNormal(ridgeOrientation?.[p] ?? 0);
      const tangent = { x: -normal.y, y: normal.x };
      const colorEvidence = (color?.[p] ?? 0) / 255;
      const differenceEvidence = (dendriteDifference?.[p] ?? 0) / 255;
      const centerCoherence = (dendriteCoherence?.[p] ?? 0) / 255;

      const oa = sampleByte(
        dendriteOrientation,
        width,
        height,
        x + normal.x * sideDistance,
        y + normal.y * sideDistance,
      );
      const ob = sampleByte(
        dendriteOrientation,
        width,
        height,
        x - normal.x * sideDistance,
        y - normal.y * sideDistance,
      );
      const ca = sampleNormalized(
        dendriteCoherence,
        x + normal.x * sideDistance,
        y + normal.y * sideDistance,
      );
      const cb = sampleNormalized(
        dendriteCoherence,
        x - normal.x * sideDistance,
        y - normal.y * sideDistance,
      );
      const sideCoherence = Math.sqrt(ca * cb);
      const orientationContinuity = 1 - directionDifference(oa, ob);

      let tangentSupport = 0;
      let tangentWeight = 0;
      for (const distance of tangentDistances) {
        for (const sign of [-1, 1]) {
          const tx = x + tangent.x * distance * sign;
          const ty = y + tangent.y * distance * sign;
          const support = sampleNormalized(ridge, tx, ty);
          const localOrientation = sampleByte(dendriteOrientation, width, height, tx, ty);
          const localCoherence = sampleNormalized(dendriteCoherence, tx, ty);
          const orientationAgreement = 1 - directionDifference(
            dendriteOrientation?.[p] ?? 0,
            localOrientation,
          );
          tangentSupport += support * (0.35 + 0.65 * orientationAgreement) * (0.45 + 0.55 * localCoherence);
          tangentWeight += 1;
        }
      }
      tangentSupport = tangentWeight ? tangentSupport / tangentWeight : 0;

      let parallelSupport = 0;
      let parallelWeight = 0;
      for (const distance of parallelDistances) {
        const plus = sampleNormalized(
          ridge,
          x + normal.x * distance,
          y + normal.y * distance,
        );
        const minus = sampleNormalized(
          ridge,
          x - normal.x * distance,
          y - normal.y * distance,
        );
        parallelSupport += Math.max(plus, minus);
        parallelWeight += 1;
      }
      parallelSupport = parallelWeight ? parallelSupport / parallelWeight : 0;

      const lowColor = 1 - colorEvidence;
      const coherence = 0.45 * centerCoherence + 0.55 * sideCoherence;
      const longitudinal = 0.72 * tangentSupport + 0.28 * parallelSupport;
      const boundaryDifferenceGuard = 1 - 0.72 * differenceEvidence;

      const penalty = ridgeStrength
        * lowColor
        * (0.25 + 0.75 * coherence)
        * (0.30 + 0.70 * orientationContinuity)
        * longitudinal
        * Math.max(0.15, boundaryDifferenceGuard);

      out[p] = Math.max(0, Math.min(255, Math.round(penalty * 255)));
    }

    if (y % 40 === 0 || y === height - margin - 1) {
      onProgress((y - margin + 1) / Math.max(1, height - margin * 2));
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }

  onProgress(1);
  return out;
}
