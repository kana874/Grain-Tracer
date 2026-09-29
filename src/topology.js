import { dilateBinaryMask } from "./evaluation.js";

function clampInt(value, min, max) {
  return Math.max(min, Math.min(max, Math.round(Number(value) || 0)));
}

function countInteriorEndpointProxy(mask, width, height, edgeMargin = 3) {
  const margin = Math.max(0, Math.round(edgeMargin));
  let endpointPixels = 0;
  let interiorBoundaryPixels = 0;

  for (let y = margin; y < height - margin; y += 1) {
    for (let x = margin; x < width - margin; x += 1) {
      const p = y * width + x;
      if (!mask[p]) continue;
      interiorBoundaryPixels += 1;
      let neighbors = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          if (mask[ny * width + nx]) neighbors += 1;
        }
      }
      if (neighbors <= 1) endpointPixels += 1;
    }
  }

  return {
    edgeMargin: margin,
    endpointPixels,
    interiorBoundaryPixels,
    endpointPixelsPer100kBoundaryPixels: interiorBoundaryPixels
      ? endpointPixels / interiorBoundaryPixels * 100000
      : 0,
    note: "Endpoint proxy on the binary prediction; use for within-image regression trends, not as a physical grain-junction count.",
  };
}

function buildEdgeReachableMask(wall, width, height) {
  const reachable = new Uint8Array(wall.length);
  const queue = new Int32Array(wall.length);
  let head = 0;
  let tail = 0;

  const push = p => {
    if (wall[p] || reachable[p]) return;
    reachable[p] = 1;
    queue[tail++] = p;
  };

  for (let x = 0; x < width; x += 1) {
    push(x);
    push((height - 1) * width + x);
  }
  for (let y = 1; y < height - 1; y += 1) {
    push(y * width);
    push(y * width + width - 1);
  }

  while (head < tail) {
    const p = queue[head++];
    const x = p % width;
    const y = Math.floor(p / width);
    if (x > 0) push(p - 1);
    if (x + 1 < width) push(p + 1);
    if (y > 0) push(p - width);
    if (y + 1 < height) push(p + width);
  }

  return reachable;
}

function erodeSquare(mask, width, height, radius) {
  const r = Math.max(0, Math.round(radius ?? 0));
  if (!r) return mask.slice();
  const span = r * 2 + 1;
  const horizontal = new Uint8Array(mask.length);
  const output = new Uint8Array(mask.length);

  for (let y = 0; y < height; y += 1) {
    const base = y * width;
    let sum = 0;
    for (let x = 0; x < width; x += 1) {
      const addX = x + r;
      if (addX < width) sum += mask[base + addX] ? 1 : 0;
      const removeX = x - r - 1;
      if (removeX >= 0) sum -= mask[base + removeX] ? 1 : 0;
      if (x >= r && x < width - r && sum === span) horizontal[base + x] = 1;
    }
  }

  for (let x = 0; x < width; x += 1) {
    let sum = 0;
    for (let y = 0; y < height; y += 1) {
      const addY = y + r;
      if (addY < height) sum += horizontal[addY * width + x] ? 1 : 0;
      const removeY = y - r - 1;
      if (removeY >= 0) sum -= horizontal[removeY * width + x] ? 1 : 0;
      if (y >= r && y < height - r && sum === span) output[y * width + x] = 1;
    }
  }

  return output;
}

function buildComponentIndex(mask, width, height, minPixels = 12) {
  const labels = new Uint32Array(mask.length);
  const queue = new Int32Array(mask.length);
  const sizes = [0];
  let count = 0;

  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || labels[start]) continue;
    count += 1;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    labels[start] = count;

    while (head < tail) {
      const p = queue[head++];
      const x = p % width;
      const y = Math.floor(p / width);
      if (x > 0) {
        const np = p - 1;
        if (mask[np] && !labels[np]) {
          labels[np] = count;
          queue[tail++] = np;
        }
      }
      if (x + 1 < width) {
        const np = p + 1;
        if (mask[np] && !labels[np]) {
          labels[np] = count;
          queue[tail++] = np;
        }
      }
      if (y > 0) {
        const np = p - width;
        if (mask[np] && !labels[np]) {
          labels[np] = count;
          queue[tail++] = np;
        }
      }
      if (y + 1 < height) {
        const np = p + width;
        if (mask[np] && !labels[np]) {
          labels[np] = count;
          queue[tail++] = np;
        }
      }
    }
    sizes[count] = tail;
  }

  const active = new Uint8Array(count + 1);
  let activeCount = 0;
  let activePixels = 0;
  for (let label = 1; label <= count; label += 1) {
    if ((sizes[label] ?? 0) < minPixels) continue;
    active[label] = 1;
    activeCount += 1;
    activePixels += sizes[label] ?? 0;
  }
  return { labels, sizes, active, componentCount: activeCount, componentPixels: activePixels };
}

function classifyCoreClosure(wall, edgeReachable, coreIndex) {
  const reachable = new Uint8Array(coreIndex.active.length);
  const covered = new Uint32Array(coreIndex.active.length);
  let coveredPixels = 0;

  for (let p = 0; p < coreIndex.labels.length; p += 1) {
    const label = coreIndex.labels[p];
    if (!label || !coreIndex.active[label]) continue;
    if (edgeReachable[p]) reachable[label] = 1;
    if (wall[p]) {
      covered[label] += 1;
      coveredPixels += 1;
    }
  }

  let closedRegions = 0;
  let openRegions = 0;
  let fullyCoveredCoreRegions = 0;
  for (let label = 1; label < coreIndex.active.length; label += 1) {
    if (!coreIndex.active[label]) continue;
    if (reachable[label]) openRegions += 1;
    else closedRegions += 1;
    if (covered[label] >= (coreIndex.sizes[label] ?? 0)) fullyCoveredCoreRegions += 1;
  }

  return {
    regionCount: coreIndex.componentCount,
    closedRegions,
    openRegions,
    closureRate: coreIndex.componentCount ? closedRegions / coreIndex.componentCount : null,
    fullyCoveredCoreRegions,
    coveredCorePixels: coveredPixels,
    corePixels: coreIndex.componentPixels,
    coveredCorePixelFraction: coreIndex.componentPixels
      ? coveredPixels / coreIndex.componentPixels
      : 0,
  };
}

function classifySeedFallback(wall, edgeReachable, seeds, width, height) {
  let closed = 0;
  let open = 0;
  let coveredSeeds = 0;
  let outsideSeeds = 0;
  for (const rawSeed of seeds ?? []) {
    const x = clampInt(rawSeed?.x, -1, width);
    const y = clampInt(rawSeed?.y, -1, height);
    if (x < 0 || y < 0 || x >= width || y >= height) {
      outsideSeeds += 1;
      continue;
    }
    const p = y * width + x;
    if (wall[p]) coveredSeeds += 1;
    if (edgeReachable[p]) open += 1;
    else closed += 1;
  }
  const considered = closed + open;
  return {
    regionCount: considered,
    closedRegions: closed,
    openRegions: open,
    closureRate: considered ? closed / considered : null,
    fullyCoveredCoreRegions: coveredSeeds,
    coveredCorePixels: coveredSeeds,
    corePixels: considered,
    coveredCorePixelFraction: considered ? coveredSeeds / considered : 0,
    outsideSeeds,
  };
}

export function computeBoundaryTopology(prediction, width, height, seeds = [], options = {}) {
  if (!prediction || prediction.length !== width * height) {
    throw new Error("Topology診断用の境界マスクが不正です。");
  }

  const bridgeRadii = [...new Set((options.bridgeRadii ?? [0, 1, 2, 3])
    .map(value => Math.max(0, Math.round(value))))]
    .sort((a, b) => a - b);
  const endpoint = countInteriorEndpointProxy(
    prediction,
    width,
    height,
    options.endpointEdgeMargin ?? 3,
  );

  const closedNegativeMask = options.closedNegativeMask ?? null;
  const coreErosionRadius = Math.max(0, Math.round(options.coreErosionRadius ?? 2));
  const minCorePixels = Math.max(1, Math.round(options.minCorePixels ?? 12));
  const coreMask = closedNegativeMask?.length === prediction.length
    ? erodeSquare(closedNegativeMask, width, height, coreErosionRadius)
    : null;
  const coreIndex = coreMask
    ? buildComponentIndex(coreMask, width, height, minCorePixels)
    : null;
  const useCoreRegions = Boolean(coreIndex?.componentCount);

  const closureByBridgeRadius = [];
  for (const radius of bridgeRadii) {
    const wall = radius > 0
      ? dilateBinaryMask(prediction, width, height, radius)
      : prediction;
    const edgeReachable = buildEdgeReachableMask(wall, width, height);
    const classified = useCoreRegions
      ? classifyCoreClosure(wall, edgeReachable, coreIndex)
      : classifySeedFallback(wall, edgeReachable, seeds, width, height);
    closureByBridgeRadius.push({
      bridgeRadius: radius,
      ...classified,
    });
  }

  const base = closureByBridgeRadius.find(item => item.bridgeRadius === 0)
    ?? closureByBridgeRadius[0]
    ?? null;
  const recovery = [];
  let previousClosed = base?.closedRegions ?? 0;
  for (const item of closureByBridgeRadius) {
    if (item === base) continue;
    recovery.push({
      bridgeRadius: item.bridgeRadius,
      newlyClosedRegionsVsPrevious: Math.max(0, item.closedRegions - previousClosed),
      totalClosedRegions: item.closedRegions,
      closureRate: item.closureRate,
      coveredCorePixelFraction: item.coveredCorePixelFraction,
    });
    previousClosed = Math.max(previousClosed, item.closedRegions);
  }

  return {
    version: 2,
    mode: "diagnostic-only",
    endpointProxy: endpoint,
    regionClosure: {
      basis: useCoreRegions ? "closed-negative-eroded-core" : "seed-fallback",
      seedCount: (seeds ?? []).length,
      coreErosionRadius: useCoreRegions ? coreErosionRadius : null,
      minCorePixels: useCoreRegions ? minCorePixels : null,
      coreRegionCount: useCoreRegions ? coreIndex.componentCount : 0,
      corePixels: useCoreRegions ? coreIndex.componentPixels : 0,
      baseClosureRate: base?.closureRate ?? null,
      baseClosedRegions: base?.closedRegions ?? 0,
      baseOpenRegions: base?.openRegions ?? 0,
      closureByBridgeRadius,
      recovery,
      note: "Closure is evaluated from eroded high-confidence Negative Fill cores. A region is open if any core pixel can reach the image edge through non-boundary pixels; increasing bridge radius can only remove reachability. Core coverage is reported separately so over-thick bridging is visible instead of being hidden by the closure score.",
    },
    note: "Topology v2 is diagnostic only in v0.3.6.4 and is not part of Auto Tune v2 objective.",
  };
}
