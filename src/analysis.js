function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function colorDistance(data, i1, i2) {
  const dr = data[i1] - data[i2];
  const dg = data[i1 + 1] - data[i2 + 1];
  const db = data[i1 + 2] - data[i2 + 2];
  return Math.sqrt(dr * dr + dg * dg + db * db) / 441.67295593;
}

function luminance(data, index) {
  return (0.2126 * data[index] + 0.7152 * data[index + 1] + 0.0722 * data[index + 2]) / 255;
}

function removeSmallComponents(mask, width, height, minSize) {
  if (minSize <= 1) return mask;

  const size = width * height;
  const visited = new Uint8Array(size);
  const queue = new Int32Array(size);

  for (let start = 0; start < size; start += 1) {
    if (!mask[start] || visited[start]) continue;

    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    visited[start] = 1;

    while (head < tail) {
      const current = queue[head++];
      const x = current % width;
      const y = Math.floor(current / width);

      for (let dy = -1; dy <= 1; dy += 1) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const next = ny * width + nx;
          if (mask[next] && !visited[next]) {
            visited[next] = 1;
            queue[tail++] = next;
          }
        }
      }
    }

    if (tail < minSize) {
      for (let i = 0; i < tail; i += 1) mask[queue[i]] = 0;
    }
  }

  return mask;
}

function neighborSupport(mask, width, height) {
  const out = new Uint8Array(mask.length);
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const p = y * width + x;
      if (!mask[p]) continue;
      let count = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          count += mask[(y + dy) * width + (x + dx)] ? 1 : 0;
        }
      }
      if (count >= 2) out[p] = 1;
    }
  }
  return out;
}

export async function extractBoundaryCandidates(imageData, options = {}) {
  const { width, height, data } = imageData;
  const sensitivity = options.sensitivity ?? 58;
  const darkWeightRaw = options.darkWeight ?? 65;
  const colorWeightRaw = options.colorWeight ?? 35;
  const minComponent = options.minComponent ?? 24;
  const onProgress = options.onProgress ?? (() => {});

  const totalWeight = Math.max(1, darkWeightRaw + colorWeightRaw);
  const darkWeight = darkWeightRaw / totalWeight;
  const colorWeight = colorWeightRaw / totalWeight;

  const threshold = 0.74 - (sensitivity / 100) * 0.46;
  const radius = Math.max(1, Math.round(Math.min(width, height) / 700));
  const mask = new Uint8Array(width * height);

  for (let y = radius; y < height - radius; y += 1) {
    for (let x = radius; x < width - radius; x += 1) {
      const pixel = y * width + x;
      const i = pixel * 4;
      const left = (y * width + (x - radius)) * 4;
      const right = (y * width + (x + radius)) * 4;
      const up = ((y - radius) * width + x) * 4;
      const down = ((y + radius) * width + x) * 4;

      const luma = luminance(data, i);
      const darkness = clamp01((0.63 - luma) / 0.55);
      const crossColor = Math.max(
        colorDistance(data, left, right),
        colorDistance(data, up, down),
      );

      const score = darkness * darkWeight + crossColor * colorWeight;
      if (score >= threshold) mask[pixel] = 1;
    }

    if (y % 60 === 0) {
      onProgress((y - radius) / Math.max(1, height - radius * 2) * 0.72);
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }

  const supported = neighborSupport(mask, width, height);
  onProgress(0.82);
  await new Promise(resolve => setTimeout(resolve, 0));
  removeSmallComponents(supported, width, height, minComponent);
  onProgress(1);

  return supported;
}

export function renderBoundaryOverlay(mask, width, height, options = {}) {
  const opacity = (options.opacity ?? 90) / 100;
  const rgba = new Uint8ClampedArray(width * height * 4);

  for (let p = 0; p < mask.length; p += 1) {
    if (!mask[p]) continue;
    const i = p * 4;
    rgba[i] = 35;
    rgba[i + 1] = 245;
    rgba[i + 2] = 222;
    rgba[i + 3] = Math.round(255 * opacity);
  }

  return new ImageData(rgba, width, height);
}
