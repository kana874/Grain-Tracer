function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

export function buildLuminance(imageData) {
  const { data, width, height } = imageData;
  const out = new Float32Array(width * height);
  for (let p = 0, i = 0; p < out.length; p += 1, i += 4) {
    out[p] = (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
  }
  return out;
}

const DIRECTIONS = [
  { nx: 1, ny: 0, tx: 0, ty: 1, angle: 0 },
  { nx: 1, ny: 1, tx: -1, ty: 1, angle: Math.PI / 4 },
  { nx: 0, ny: 1, tx: 1, ty: 0, angle: Math.PI / 2 },
  { nx: -1, ny: 1, tx: 1, ty: 1, angle: Math.PI * 3 / 4 },
];

const AXIAL_COS2 = DIRECTIONS.map(direction => Math.cos(direction.angle * 2));
const AXIAL_SIN2 = DIRECTIONS.map(direction => Math.sin(direction.angle * 2));

function sample(luma, width, height, x, y) {
  const sx = Math.max(0, Math.min(width - 1, Math.round(x)));
  const sy = Math.max(0, Math.min(height - 1, Math.round(y)));
  return luma[sy * width + sx];
}

export async function computeMultiScaleDarkRidge(luma, width, height, options = {}) {
  const scales = options.scales ?? [1, 2, 4];
  const onProgress = options.onProgress ?? (() => {});
  const size = width * height;
  const ridge = new Uint8Array(size);
  const orientation = new Uint8Array(size);
  const orientationAngle = new Float32Array(size);
  const bestScale = new Uint8Array(size);
  const directionScores = new Float32Array(DIRECTIONS.length);
  const margin = Math.max(...scales) + 1;

  for (let y = margin; y < height - margin; y += 1) {
    for (let x = margin; x < width - margin; x += 1) {
      const p = y * width + x;
      const center = luma[p];
      let best = 0;
      let bestDir = 0;
      let bestAngle = 0;
      let bestScaleIndex = 0;

      for (let si = 0; si < scales.length; si += 1) {
        const radius = scales[si];
        const norm = radius * Math.SQRT2;
        let scaleBest = 0;
        let scaleBestDir = 0;

        for (let di = 0; di < DIRECTIONS.length; di += 1) {
          const d = DIRECTIONS[di];
          const nr = d.nx !== 0 && d.ny !== 0 ? norm : radius;
          const tr = d.tx !== 0 && d.ty !== 0 ? norm : radius;

          const n1 = sample(luma, width, height, x + d.nx * nr, y + d.ny * nr);
          const n2 = sample(luma, width, height, x - d.nx * nr, y - d.ny * nr);
          const t1 = sample(luma, width, height, x + d.tx * tr, y + d.ty * tr);
          const t2 = sample(luma, width, height, x - d.tx * tr, y - d.ty * tr);

          const normalResponse = Math.max(0, ((n1 + n2) * 0.5) - center);
          const tangentResponse = Math.max(0, ((t1 + t2) * 0.5) - center);
          // Dark dots respond similarly in normal and tangent directions. A line-like
          // ridge should be dark across the line while remaining dark along it.
          const lineResponse = Math.max(0, normalResponse - tangentResponse * 0.68);
          const scaleCompensation = 1 / Math.sqrt(radius);
          const score = clamp01((lineResponse * scaleCompensation) / 0.16);
          directionScores[di] = score;

          if (score > scaleBest) {
            scaleBest = score;
            scaleBestDir = di;
          }
        }

        if (scaleBest > best) {
          best = scaleBest;
          bestDir = scaleBestDir;
          bestScaleIndex = si;

          // Ridge normals are axial (theta == theta + PI). A doubled-angle
          // weighted mean interpolates the four sampled directions into a
          // continuous normal without changing the original detector response.
          let vx = 0;
          let vy = 0;
          for (let di = 0; di < DIRECTIONS.length; di += 1) {
            const weight = directionScores[di] * directionScores[di];
            vx += weight * AXIAL_COS2[di];
            vy += weight * AXIAL_SIN2[di];
          }
          if (Math.hypot(vx, vy) > 1e-8) {
            bestAngle = 0.5 * Math.atan2(vy, vx);
            if (bestAngle < 0) bestAngle += Math.PI;
          } else {
            bestAngle = DIRECTIONS[scaleBestDir].angle;
          }
        }
      }

      ridge[p] = Math.round(best * 255);
      orientation[p] = bestDir;
      orientationAngle[p] = bestAngle;
      bestScale[p] = bestScaleIndex;
    }

    if (y % 36 === 0 || y === height - margin - 1) {
      onProgress((y - margin + 1) / Math.max(1, height - margin * 2));
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }

  return { ridge, orientation, orientationAngle, bestScale, scales };
}

export function orientationNormal(orientationIndex) {
  const d = DIRECTIONS[orientationIndex] ?? DIRECTIONS[0];
  const length = Math.hypot(d.nx, d.ny) || 1;
  return { x: d.nx / length, y: d.ny / length };
}


export function orientationNormalContinuous(angle, fallbackIndex = 0) {
  if (Number.isFinite(angle)) return { x: Math.cos(angle), y: Math.sin(angle) };
  return orientationNormal(fallbackIndex);
}
