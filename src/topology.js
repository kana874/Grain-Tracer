import { buildClosedNegativeRegionIndex } from "./closed-negative-fill.js";
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
    note: "Endpoint proxy on the unskeletonized binary boundary mask; use for within-image regression trends, not as a physical grain-junction count.",
  };
}

function classifySeedClosures(index, seeds, width, height) {
  let closed = 0;
  let open = 0;
  let onBoundary = 0;
  let outside = 0;

  for (const rawSeed of seeds ?? []) {
    const x = clampInt(rawSeed?.x, -1, width);
    const y = clampInt(rawSeed?.y, -1, height);
    if (x < 0 || y < 0 || x >= width || y >= height) {
      outside += 1;
      continue;
    }
    const label = index.labels[y * width + x];
    if (!label) {
      onBoundary += 1;
      continue;
    }
    if (index.componentTouchesEdge[label]) open += 1;
    else closed += 1;
  }

  const evaluable = closed + open;
  return {
    seedCount: (seeds ?? []).length,
    evaluableSeeds: evaluable,
    closedSeeds: closed,
    openSeeds: open,
    seedsOnPrediction: onBoundary,
    outsideSeeds: outside,
    closureRate: evaluable ? closed / evaluable : null,
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
  const closureByBridgeRadius = [];

  for (const radius of bridgeRadii) {
    const wall = radius > 0
      ? dilateBinaryMask(prediction, width, height, radius)
      : prediction;
    const index = buildClosedNegativeRegionIndex(
      wall,
      width,
      height,
      { safetyRadius: 0 },
    );
    const classified = classifySeedClosures(index, seeds, width, height);
    closureByBridgeRadius.push({
      bridgeRadius: radius,
      ...classified,
    });
  }

  const base = closureByBridgeRadius.find(item => item.bridgeRadius === 0)
    ?? closureByBridgeRadius[0]
    ?? null;
  const recovery = [];
  let previousClosed = base?.closedSeeds ?? 0;
  for (const item of closureByBridgeRadius) {
    if (item === base) continue;
    recovery.push({
      bridgeRadius: item.bridgeRadius,
      newlyClosedSeedsVsPrevious: Math.max(0, item.closedSeeds - previousClosed),
      totalClosedSeeds: item.closedSeeds,
      closureRate: item.closureRate,
    });
    previousClosed = Math.max(previousClosed, item.closedSeeds);
  }

  return {
    version: 1,
    mode: "diagnostic-only",
    endpointProxy: endpoint,
    seedClosure: {
      seedCount: (seeds ?? []).length,
      baseClosureRate: base?.closureRate ?? null,
      baseClosedSeeds: base?.closedSeeds ?? 0,
      baseOpenSeeds: base?.openSeeds ?? 0,
      closureByBridgeRadius,
      recovery,
      note: "A seed is closed when the connected non-boundary region containing it cannot reach the image edge. Dilated bridge radii are diagnostic probes for small boundary gaps and are not applied to the extraction result.",
    },
    note: "Topology metrics are diagnostic only in v0.3.6.3 and are not part of Auto Tune v2 objective.",
  };
}
