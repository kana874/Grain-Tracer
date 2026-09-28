import { orientationNormal } from "./ridge.js";

function srgbToLinear(value) {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function rgbToLab(r, g, b) {
  const R = srgbToLinear(r);
  const G = srgbToLinear(g);
  const B = srgbToLinear(b);
  const x = (R * 0.4124564 + G * 0.3575761 + B * 0.1804375) / 0.95047;
  const y = (R * 0.2126729 + G * 0.7151522 + B * 0.0721750);
  const z = (R * 0.0193339 + G * 0.1191920 + B * 0.9503041) / 1.08883;
  const f = value => value > 0.008856 ? Math.cbrt(value) : (7.787 * value + 16 / 116);
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

export function buildLabPlanes(imageData) {
  const { data, width, height } = imageData;
  const size = width * height;
  const L = new Uint8Array(size);
  const A = new Int16Array(size);
  const B = new Int16Array(size);
  for (let p = 0, i = 0; p < size; p += 1, i += 4) {
    const [l, a, b] = rgbToLab(data[i], data[i + 1], data[i + 2]);
    L[p] = Math.max(0, Math.min(255, Math.round(l * 2.55)));
    A[p] = Math.round(a * 2);
    B[p] = Math.round(b * 2);
  }
  return { L, A, B };
}

function samplePlane(plane, width, height, x, y) {
  const sx = Math.max(0, Math.min(width - 1, Math.round(x)));
  const sy = Math.max(0, Math.min(height - 1, Math.round(y)));
  return plane[sy * width + sx];
}

export async function computeDirectionalColorDifference(imageData, orientation, options = {}) {
  const { width, height } = imageData;
  const distances = options.distances ?? [2, 4, 6];
  const onProgress = options.onProgress ?? (() => {});
  const planes = buildLabPlanes(imageData);
  const out = new Uint8Array(width * height);
  const margin = Math.max(...distances) + 1;

  for (let y = margin; y < height - margin; y += 1) {
    for (let x = margin; x < width - margin; x += 1) {
      const p = y * width + x;
      const normal = orientationNormal(orientation[p]);
      let l1 = 0; let a1 = 0; let b1 = 0;
      let l2 = 0; let a2 = 0; let b2 = 0;
      for (const d of distances) {
        l1 += samplePlane(planes.L, width, height, x + normal.x * d, y + normal.y * d);
        a1 += samplePlane(planes.A, width, height, x + normal.x * d, y + normal.y * d);
        b1 += samplePlane(planes.B, width, height, x + normal.x * d, y + normal.y * d);
        l2 += samplePlane(planes.L, width, height, x - normal.x * d, y - normal.y * d);
        a2 += samplePlane(planes.A, width, height, x - normal.x * d, y - normal.y * d);
        b2 += samplePlane(planes.B, width, height, x - normal.x * d, y - normal.y * d);
      }
      const n = distances.length;
      const dl = (l1 - l2) / n / 2.55;
      const da = (a1 - a2) / n / 2;
      const db = (b1 - b2) / n / 2;
      const deltaE = Math.sqrt(dl * dl + da * da + db * db);
      out[p] = Math.round(Math.max(0, Math.min(1, deltaE / 55)) * 255);
    }
    if (y % 44 === 0 || y === height - margin - 1) {
      onProgress((y - margin + 1) / Math.max(1, height - margin * 2));
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }

  return out;
}
