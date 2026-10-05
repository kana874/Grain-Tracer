import { dilateBinaryMask } from "./evaluation.js";

function clampInt(value, min, max) {
  return Math.max(min, Math.min(max, Math.round(Number(value) || 0)));
}

function edgeSideCount(edgeMask) {
  let count = 0;
  for (const bit of [1, 2, 4, 8]) if (edgeMask & bit) count += 1;
  return count;
}

function hasOppositeEdgePair(edgeMask) {
  return Boolean(((edgeMask & 1) && (edgeMask & 4)) || ((edgeMask & 2) && (edgeMask & 8)));
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

function erodeSquare(mask, width, height, radius) {
  const r = Math.max(0, Math.round(radius ?? 0));
  if (!r) return mask.slice();
  const span = r * 2 + 1;
  const horizontal = new Uint8Array(mask.length);
  const output = new Uint8Array(mask.length);
  const prefix = new Uint32Array(Math.max(width, height) + 1);

  for (let y = 0; y < height; y += 1) {
    const base = y * width;
    prefix[0] = 0;
    for (let x = 0; x < width; x += 1) {
      prefix[x + 1] = prefix[x] + (mask[base + x] ? 1 : 0);
    }
    for (let x = r; x < width - r; x += 1) {
      const sum = prefix[x + r + 1] - prefix[x - r];
      if (sum === span) horizontal[base + x] = 1;
    }
  }

  for (let x = 0; x < width; x += 1) {
    prefix[0] = 0;
    for (let y = 0; y < height; y += 1) {
      prefix[y + 1] = prefix[y] + (horizontal[y * width + x] ? 1 : 0);
    }
    for (let y = r; y < height - r; y += 1) {
      const sum = prefix[y + r + 1] - prefix[y - r];
      if (sum === span) output[y * width + x] = 1;
    }
  }

  return output;
}
function buildComponentIndex(mask, width, height, minPixels = 1, foreground = true) {
  const labels = new Uint32Array(mask.length);
  const queue = new Int32Array(mask.length);
  const sizes = [0];
  const edgeMasks = [0];
  const representatives = [-1];
  let count = 0;

  const isTarget = p => Boolean(mask[p]) === foreground;

  for (let start = 0; start < mask.length; start += 1) {
    if (!isTarget(start) || labels[start]) continue;
    count += 1;
    let head = 0;
    let tail = 0;
    let edgeMask = 0;
    queue[tail++] = start;
    labels[start] = count;
    representatives[count] = start;

    while (head < tail) {
      const p = queue[head++];
      const x = p % width;
      const y = Math.floor(p / width);
      if (x === 0) edgeMask |= 1;
      if (y === 0) edgeMask |= 2;
      if (x === width - 1) edgeMask |= 4;
      if (y === height - 1) edgeMask |= 8;

      if (x > 0) {
        const np = p - 1;
        if (isTarget(np) && !labels[np]) {
          labels[np] = count;
          queue[tail++] = np;
        }
      }
      if (x + 1 < width) {
        const np = p + 1;
        if (isTarget(np) && !labels[np]) {
          labels[np] = count;
          queue[tail++] = np;
        }
      }
      if (y > 0) {
        const np = p - width;
        if (isTarget(np) && !labels[np]) {
          labels[np] = count;
          queue[tail++] = np;
        }
      }
      if (y + 1 < height) {
        const np = p + width;
        if (isTarget(np) && !labels[np]) {
          labels[np] = count;
          queue[tail++] = np;
        }
      }
    }

    sizes[count] = tail;
    edgeMasks[count] = edgeMask;
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

  return {
    labels,
    sizes,
    edgeMasks,
    representatives,
    active,
    componentCount: activeCount,
    rawComponentCount: count,
    componentPixels: activePixels,
  };
}

function buildCoreParentMetadata(coreIndex, fillIndex, borderAssistedMask) {
  const parentFillLabel = new Uint32Array(coreIndex.active.length);
  const borderAssisted = new Uint8Array(coreIndex.active.length);

  for (let p = 0; p < coreIndex.labels.length; p += 1) {
    const coreLabel = coreIndex.labels[p];
    if (!coreLabel || !coreIndex.active[coreLabel]) continue;
    if (!parentFillLabel[coreLabel]) parentFillLabel[coreLabel] = fillIndex?.labels?.[p] ?? 0;
    if (borderAssistedMask?.[p]) borderAssisted[coreLabel] = 1;
  }

  // Erosion can remove direct overlap with the border-assisted mask near the
  // frame. The parent fill label is therefore also used to inherit the flag.
  if (fillIndex && borderAssistedMask) {
    const borderFillLabels = new Uint8Array(fillIndex.rawComponentCount + 1);
    for (let p = 0; p < fillIndex.labels.length; p += 1) {
      if (!borderAssistedMask[p]) continue;
      const label = fillIndex.labels[p];
      if (label) borderFillLabels[label] = 1;
    }
    for (let coreLabel = 1; coreLabel < coreIndex.active.length; coreLabel += 1) {
      const fillLabel = parentFillLabel[coreLabel];
      if (fillLabel && borderFillLabels[fillLabel]) borderAssisted[coreLabel] = 1;
    }
  }

  return { parentFillLabel, borderAssisted };
}

function classifyCoreClosure(
  wall,
  backgroundIndex,
  coreIndex,
  fillIndex,
  coreMeta,
  options = {},
) {
  const covered = new Uint32Array(coreIndex.active.length);
  const backgroundLabels = Array.from({ length: coreIndex.active.length }, () => new Set());
  let coveredPixels = 0;

  for (let p = 0; p < coreIndex.labels.length; p += 1) {
    const coreLabel = coreIndex.labels[p];
    if (!coreLabel || !coreIndex.active[coreLabel]) continue;
    if (wall[p]) {
      covered[coreLabel] += 1;
      coveredPixels += 1;
      continue;
    }
    const backgroundLabel = backgroundIndex.labels[p];
    if (backgroundLabel) backgroundLabels[coreLabel].add(backgroundLabel);
  }

  const maxBorderLeakAreaRatio = Math.max(
    1.05,
    Number(options.maxBorderLeakAreaRatio ?? 2.0),
  );
  let closedRegions = 0;
  let openRegions = 0;
  let fullyCoveredCoreRegions = 0;
  let borderAssistedRegions = 0;
  let borderAssistedClosedRegions = 0;
  let borderAssistedOpenRegions = 0;
  let borderAssistedSingleEdgeRegions = 0;
  let borderAssistedCornerRegions = 0;
  let borderAssistedUnexpectedEdgeLeaks = 0;
  let borderAssistedOversizeLeaks = 0;
  let borderAssistedInvalidEdgeTopology = 0;
  let maxObservedBorderLeakAreaRatio = 0;

  for (let coreLabel = 1; coreLabel < coreIndex.active.length; coreLabel += 1) {
    if (!coreIndex.active[coreLabel]) continue;
    const coreSize = coreIndex.sizes[coreLabel] ?? 0;
    const isFullyCovered = covered[coreLabel] >= coreSize;
    if (isFullyCovered) fullyCoveredCoreRegions += 1;

    const fillLabel = coreMeta.parentFillLabel[coreLabel] ?? 0;
    const isBorderAssisted = Boolean(coreMeta.borderAssisted[coreLabel]);
    const allowedEdgeMask = isBorderAssisted ? (fillIndex?.edgeMasks?.[fillLabel] ?? 0) : 0;
    const allowedEdgeSides = edgeSideCount(allowedEdgeMask);
    const cornerAssisted = allowedEdgeSides === 2 && !hasOppositeEdgePair(allowedEdgeMask);
    const invalidBorderTopology = isBorderAssisted
      && (!allowedEdgeMask || allowedEdgeSides > 2 || hasOppositeEdgePair(allowedEdgeMask));
    if (isBorderAssisted) {
      borderAssistedRegions += 1;
      if (allowedEdgeSides === 1) borderAssistedSingleEdgeRegions += 1;
      else if (cornerAssisted) borderAssistedCornerRegions += 1;
      else if (invalidBorderTopology) borderAssistedInvalidEdgeTopology += 1;
    }

    let isOpen = invalidBorderTopology;
    let leakedUnexpectedEdge = false;
    let leakedOversize = false;
    if (!isFullyCovered && !isOpen) {
      const bgLabels = backgroundLabels[coreLabel];
      for (const bgLabel of bgLabels) {
        const bgEdgeMask = backgroundIndex.edgeMasks[bgLabel] ?? 0;
        if (!isBorderAssisted) {
          if (bgEdgeMask) {
            isOpen = true;
            break;
          }
          continue;
        }

        // Border-assisted closure is explicit: only the same annotated edge
        // (or the two adjacent edges of an annotated corner region) may remain
        // reachable. Reaching any other side means the region is still open.
        if (bgEdgeMask & ~allowedEdgeMask) {
          leakedUnexpectedEdge = true;
          isOpen = true;
          break;
        }

        const expectedArea = Math.max(1, fillIndex?.sizes?.[fillLabel] ?? coreSize);
        const reachableArea = backgroundIndex.sizes[bgLabel] ?? 0;
        const areaRatio = reachableArea / expectedArea;
        maxObservedBorderLeakAreaRatio = Math.max(maxObservedBorderLeakAreaRatio, areaRatio);
        if (areaRatio > maxBorderLeakAreaRatio) {
          leakedOversize = true;
          isOpen = true;
          break;
        }
      }
    }
    if (leakedUnexpectedEdge) borderAssistedUnexpectedEdgeLeaks += 1;
    if (leakedOversize) borderAssistedOversizeLeaks += 1;

    if (isOpen) {
      openRegions += 1;
      if (isBorderAssisted) borderAssistedOpenRegions += 1;
    } else {
      closedRegions += 1;
      if (isBorderAssisted) borderAssistedClosedRegions += 1;
    }
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
    borderAssistedRegions,
    borderAssistedClosedRegions,
    borderAssistedOpenRegions,
    borderAssistedSingleEdgeRegions,
    borderAssistedCornerRegions,
    borderAssistedUnexpectedEdgeLeaks,
    borderAssistedOversizeLeaks,
    borderAssistedInvalidEdgeTopology,
    maxBorderLeakAreaRatio,
    maxObservedBorderLeakAreaRatio,
  };
}

function classifySeedFallback(wall, backgroundIndex, seeds, width, height, options = {}) {
  let closed = 0;
  let open = 0;
  let coveredSeeds = 0;
  let outsideSeeds = 0;
  let borderAssistedRegions = 0;
  let borderAssistedClosedRegions = 0;
  let borderAssistedOpenRegions = 0;
  const maxBorderLeakAreaRatio = Math.max(1.05, Number(options.maxBorderLeakAreaRatio ?? 2.0));

  for (const rawSeed of seeds ?? []) {
    const x = clampInt(rawSeed?.x, -1, width);
    const y = clampInt(rawSeed?.y, -1, height);
    if (x < 0 || y < 0 || x >= width || y >= height) {
      outsideSeeds += 1;
      continue;
    }
    const p = y * width + x;
    const isBorderAssisted = Boolean(rawSeed?.borderAssisted);
    if (isBorderAssisted) borderAssistedRegions += 1;
    if (wall[p]) {
      coveredSeeds += 1;
      closed += 1;
      if (isBorderAssisted) borderAssistedClosedRegions += 1;
      continue;
    }

    const bgLabel = backgroundIndex.labels[p];
    const edgeMask = bgLabel ? backgroundIndex.edgeMasks[bgLabel] ?? 0 : 0;
    const isOpen = isBorderAssisted
      ? Boolean(edgeMask && (backgroundIndex.sizes[bgLabel] ?? 0) > width * height * 0.12 * maxBorderLeakAreaRatio)
      : Boolean(edgeMask);

    if (isOpen) {
      open += 1;
      if (isBorderAssisted) borderAssistedOpenRegions += 1;
    } else {
      closed += 1;
      if (isBorderAssisted) borderAssistedClosedRegions += 1;
    }
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
    borderAssistedRegions,
    borderAssistedClosedRegions,
    borderAssistedOpenRegions,
    maxBorderLeakAreaRatio,
  };
}

function collectEndpointCandidates(mask, width, height, options = {}) {
  const edgeMargin = Math.max(1, Math.round(options.endpointEdgeMargin ?? 3));
  const maxGapDistance = Math.max(1.5, Number(options.maxGapDistance ?? 4.25));
  const maxGapAngleDeg = Math.max(5, Math.min(80, Number(options.maxGapAngleDeg ?? 40)));
  const minFacing = Math.cos(maxGapAngleDeg * Math.PI / 180);
  const maxCandidates = Math.max(1, Math.min(2000, Math.round(options.maxGapCandidates ?? 120)));
  const endpoints = [];

  for (let y = edgeMargin; y < height - edgeMargin; y += 1) {
    for (let x = edgeMargin; x < width - edgeMargin; x += 1) {
      const p = y * width + x;
      if (!mask[p]) continue;
      let neighborCount = 0;
      let neighborX = x;
      let neighborY = y;
      for (let dy = -1; dy <= 1; dy += 1) {
        const ny = y + dy;
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          if (!mask[ny * width + nx]) continue;
          neighborCount += 1;
          neighborX = nx;
          neighborY = ny;
        }
      }
      if (neighborCount !== 1) continue;
      const tx = x - neighborX;
      const ty = y - neighborY;
      const length = Math.hypot(tx, ty) || 1;
      endpoints.push({
        p,
        x,
        y,
        outX: tx / length,
        outY: ty / length,
      });
    }
  }

  const cellSize = Math.max(2, Math.ceil(maxGapDistance));
  const buckets = new Map();
  const bucketKey = (bx, by) => `${bx},${by}`;
  for (let i = 0; i < endpoints.length; i += 1) {
    const endpoint = endpoints[i];
    const bx = Math.floor(endpoint.x / cellSize);
    const by = Math.floor(endpoint.y / cellSize);
    const key = bucketKey(bx, by);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(i);
  }

  const lineCrossesExistingBoundary = (a, b) => {
    const steps = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    if (steps <= 1) return false;
    for (let step = 1; step < steps; step += 1) {
      const t = step / steps;
      const x = Math.round(a.x + (b.x - a.x) * t);
      const y = Math.round(a.y + (b.y - a.y) * t);
      if (mask[y * width + x]) return true;
    }
    return false;
  };

  const candidates = [];
  const angleRejectedSamples = [];
  for (let i = 0; i < endpoints.length; i += 1) {
    const a = endpoints[i];
    const bx = Math.floor(a.x / cellSize);
    const by = Math.floor(a.y / cellSize);

    for (let oy = -1; oy <= 1; oy += 1) {
      for (let ox = -1; ox <= 1; ox += 1) {
        const list = buckets.get(bucketKey(bx + ox, by + oy));
        if (!list) continue;
        for (const j of list) {
          if (j <= i) continue;
          const b = endpoints[j];
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const distance = Math.hypot(dx, dy);
          if (distance <= 1.1 || distance > maxGapDistance) continue;
          const vx = dx / distance;
          const vy = dy / distance;
          const facingA = a.outX * vx + a.outY * vy;
          const facingB = b.outX * -vx + b.outY * -vy;
          const alignment = Math.min(facingA, facingB);
          const distanceScore = 1 - Math.min(1, (distance - 1) / Math.max(0.5, maxGapDistance - 1));
          const candidate = {
            x1: a.x,
            y1: a.y,
            x2: b.x,
            y2: b.y,
            distance,
            alignment,
            score: alignment * 0.75 + distanceScore * 0.25,
            estimatedMissingPixels: Math.max(1, Math.round(distance) - 1),
          };
          if (facingA < minFacing || facingB < minFacing) {
            if (angleRejectedSamples.length < maxCandidates) {
              angleRejectedSamples.push({ ...candidate, rejectionReason: "angle" });
            }
            continue;
          }
          if (lineCrossesExistingBoundary(a, b)) continue;

          candidates.push(candidate);
        }
      }
    }
  }

  candidates.sort((a, b) => b.score - a.score || a.distance - b.distance);
  return {
    endpointCount: endpoints.length,
    candidateCount: candidates.length,
    maxGapDistance,
    maxGapAngleDeg,
    candidates: candidates.slice(0, maxCandidates),
    angleRejectedCount: angleRejectedSamples.length,
    angleRejectedSamples,
    truncated: candidates.length > maxCandidates,
    note: "Direction-consistent short-gap candidates are diagnostic only. No pixels are connected automatically.",
  };
}


function rasterizeGapInterior(candidate, width, height) {
  const dx = candidate.x2 - candidate.x1;
  const dy = candidate.y2 - candidate.y1;
  const steps = Math.max(Math.abs(dx), Math.abs(dy));
  if (steps <= 1) return [];

  const pixels = [];
  let previous = -1;
  for (let step = 1; step < steps; step += 1) {
    const t = step / steps;
    const x = Math.round(candidate.x1 + dx * t);
    const y = Math.round(candidate.y1 + dy * t);
    if (x < 0 || y < 0 || x >= width || y >= height) continue;
    const p = y * width + x;
    if (p !== previous) {
      pixels.push(p);
      previous = p;
    }
  }
  return pixels;
}

function buildSafeGapProposal(prediction, width, height, diagnostics, options = {}) {
  const applyMaxDistance = Math.max(
    1.5,
    Math.min(
      Number(options.gapApplyMaxDistance ?? 3.25),
      diagnostics.maxGapDistance ?? 4.25,
    ),
  );
  const minScore = Math.max(0, Math.min(1, Number(options.minGapScore ?? 0.78)));
  const negativeGuardRadius = Math.max(
    0,
    Math.min(4, Math.round(options.negativeGuardRadius ?? 1)),
  );
  const maxAcceptedBridges = Math.max(
    1,
    Math.min(1000, Math.round(options.maxAcceptedBridges ?? 400)),
  );
  const negativeMask = options.negativeMask?.length === prediction.length
    ? options.negativeMask
    : null;
  const exclusionMask = options.exclusionMask?.length === prediction.length
    ? options.exclusionMask
    : null;
  const negativeGuard = negativeMask && negativeGuardRadius > 0
    ? dilateBinaryMask(negativeMask, width, height, negativeGuardRadius)
    : negativeMask;

  const mask = prediction.slice();
  const bridgeMask = new Uint8Array(prediction.length);
  const acceptedCandidates = [];
  const reviewCandidates = [];
  const usedEndpoints = new Set();
  const maxReviewCandidates = Math.max(40, Math.min(1200, Math.round(options.maxGapReviewCandidates ?? 360)));
  const review = (candidate, disposition, rejectionReason = null, extra = {}) => {
    if (reviewCandidates.length >= maxReviewCandidates) return;
    reviewCandidates.push({ ...candidate, disposition, rejectionReason, ...extra });
  };
  for (const candidate of diagnostics.angleRejectedSamples ?? []) {
    review(candidate, "rejected-angle", "angle");
  }
  const rejected = {
    distance: 0,
    score: 0,
    negative: 0,
    exclusion: 0,
    endpointConflict: 0,
    noInteriorPixels: 0,
    limit: 0,
  };
  let addedPixels = 0;

  for (const candidate of diagnostics.candidates ?? []) {
    if (candidate.distance > applyMaxDistance) {
      rejected.distance += 1;
      review(candidate, "rejected-distance", "distance");
      continue;
    }
    if (candidate.score < minScore) {
      rejected.score += 1;
      review(candidate, "rejected-score", "score");
      continue;
    }

    const endpointA = candidate.y1 * width + candidate.x1;
    const endpointB = candidate.y2 * width + candidate.x2;
    if (usedEndpoints.has(endpointA) || usedEndpoints.has(endpointB)) {
      rejected.endpointConflict += 1;
      review(candidate, "rejected-endpoint-conflict", "endpoint-conflict");
      continue;
    }

    const pixels = rasterizeGapInterior(candidate, width, height);
    if (!pixels.length) {
      rejected.noInteriorPixels += 1;
      review(candidate, "rejected-empty", "no-interior-pixels");
      continue;
    }
    const safetyPixels = [endpointA, endpointB, ...pixels];
    if (exclusionMask && safetyPixels.some(p => exclusionMask[p])) {
      rejected.exclusion += 1;
      review(candidate, "rejected-exclusion", "exclusion");
      continue;
    }
    if (negativeGuard && safetyPixels.some(p => negativeGuard[p])) {
      rejected.negative += 1;
      review(candidate, "rejected-negative", "negative");
      continue;
    }
    if (acceptedCandidates.length >= maxAcceptedBridges) {
      rejected.limit += 1;
      review(candidate, "rejected-limit", "limit");
      continue;
    }

    let candidateAddedPixels = 0;
    for (const p of pixels) {
      if (!mask[p]) {
        mask[p] = 1;
        bridgeMask[p] = 1;
        candidateAddedPixels += 1;
      }
    }
    if (!candidateAddedPixels) continue;

    usedEndpoints.add(endpointA);
    usedEndpoints.add(endpointB);
    addedPixels += candidateAddedPixels;
    const accepted = {
      ...candidate,
      addedPixels: candidateAddedPixels,
    };
    acceptedCandidates.push(accepted);
    review(accepted, "accepted-safe");
  }

  return {
    mode: "safe",
    mask,
    bridgeMask,
    acceptedCandidates,
    reviewCandidates,
    sourceCandidateCount: diagnostics.candidateCount ?? 0,
    consideredCandidateCount: diagnostics.candidates?.length ?? 0,
    acceptedBridgeCount: acceptedCandidates.length,
    addedPixels,
    rejected,
    truncated: Boolean(diagnostics.truncated),
    settings: {
      applyMaxDistance,
      minScore,
      negativeGuardRadius,
      maxGapAngleDeg: diagnostics.maxGapAngleDeg,
      detectionMaxDistance: diagnostics.maxGapDistance,
      maxAcceptedBridges,
    },
  };
}

export function proposeShortGapBridges(prediction, width, height, options = {}) {
  if (!prediction || prediction.length !== width * height) {
    throw new Error("Short-gap Bridge用の境界マスクが不正です。");
  }

  const diagnostics = collectEndpointCandidates(prediction, width, height, {
    ...options,
    maxGapDistance: Math.max(
      Number(options.maxGapDistance ?? 4.25),
      Number(options.gapApplyMaxDistance ?? 3.25),
    ),
    maxGapCandidates: options.maxGapProposalCandidates ?? 2000,
  });
  return buildSafeGapProposal(prediction, width, height, diagnostics, options);
}


function pathBoundaryEvidence(pixels, evidence) {
  if (!pixels?.length || !evidence) return null;
  const ridge = evidence.ridge?.length ? evidence.ridge : null;
  const color = evidence.color?.length ? evidence.color : null;
  if (!ridge && !color) return null;
  let sum = 0;
  let count = 0;
  for (const p of pixels) {
    let local = 0;
    let weight = 0;
    if (ridge) {
      local += (ridge[p] ?? 0) / 255 * 0.65;
      weight += 0.65;
    }
    if (color) {
      local += (color[p] ?? 0) / 255 * 0.35;
      weight += 0.35;
    }
    if (weight > 0) {
      sum += local / weight;
      count += 1;
    }
  }
  return count ? sum / count : null;
}

function buildExtendedGapProposal(prediction, width, height, diagnostics, options = {}) {
  const safeMaxDistance = Math.max(1.5, Number(options.gapApplyMaxDistance ?? 3.25));
  const extendedMaxDistance = Math.max(
    safeMaxDistance + 0.25,
    Math.min(8, Number(options.extendedGapMaxDistance ?? 8)),
  );
  const minScore = Math.max(0, Math.min(1, Number(options.extendedMinGapScore ?? 0.58)));
  const minPathEvidence = Math.max(0, Math.min(1, Number(options.extendedMinPathEvidence ?? 0.34)));
  const negativeGuardRadius = Math.max(0, Math.min(4, Math.round(options.negativeGuardRadius ?? 1)));
  const maxAcceptedBridges = Math.max(1, Math.min(1000, Math.round(options.maxExtendedBridges ?? 240)));
  const negativeMask = options.negativeMask?.length === prediction.length ? options.negativeMask : null;
  const exclusionMask = options.exclusionMask?.length === prediction.length ? options.exclusionMask : null;
  const negativeGuard = negativeMask && negativeGuardRadius > 0
    ? dilateBinaryMask(negativeMask, width, height, negativeGuardRadius)
    : negativeMask;
  const evidence = options.boundaryEvidence ?? null;

  const mask = prediction.slice();
  const bridgeMask = new Uint8Array(prediction.length);
  const acceptedCandidates = [];
  const reviewCandidates = [];
  const usedEndpoints = new Set();
  const maxReviewCandidates = Math.max(40, Math.min(1600, Math.round(options.maxGapReviewCandidates ?? 480)));
  const review = (candidate, disposition, rejectionReason = null, extra = {}) => {
    if (reviewCandidates.length >= maxReviewCandidates) return;
    reviewCandidates.push({ ...candidate, disposition, rejectionReason, ...extra });
  };
  for (const candidate of diagnostics.angleRejectedSamples ?? []) {
    review(candidate, "rejected-angle", "angle");
  }

  const rejected = {
    safeRange: 0,
    distance: 0,
    score: 0,
    evidence: 0,
    evidenceUnavailable: 0,
    negative: 0,
    exclusion: 0,
    endpointConflict: 0,
    noInteriorPixels: 0,
    limit: 0,
  };
  let addedPixels = 0;

  for (const candidate of diagnostics.candidates ?? []) {
    if (candidate.distance <= safeMaxDistance) {
      rejected.safeRange += 1;
      // Extended Preview intentionally omits Safe-range candidates so yellow
      // candidates cannot be confused with the separately evaluated Safe set.
      continue;
    }
    if (candidate.distance > extendedMaxDistance) {
      rejected.distance += 1;
      review(candidate, "rejected-distance", "distance");
      continue;
    }
    if (candidate.score < minScore) {
      rejected.score += 1;
      review(candidate, "rejected-score", "score");
      continue;
    }

    const endpointA = candidate.y1 * width + candidate.x1;
    const endpointB = candidate.y2 * width + candidate.x2;
    if (usedEndpoints.has(endpointA) || usedEndpoints.has(endpointB)) {
      rejected.endpointConflict += 1;
      review(candidate, "rejected-endpoint-conflict", "endpoint-conflict");
      continue;
    }

    const pixels = rasterizeGapInterior(candidate, width, height);
    if (!pixels.length) {
      rejected.noInteriorPixels += 1;
      review(candidate, "rejected-empty", "no-interior-pixels");
      continue;
    }
    const safetyPixels = [endpointA, endpointB, ...pixels];
    if (exclusionMask && safetyPixels.some(p => exclusionMask[p])) {
      rejected.exclusion += 1;
      review(candidate, "rejected-exclusion", "exclusion");
      continue;
    }
    if (negativeGuard && safetyPixels.some(p => negativeGuard[p])) {
      rejected.negative += 1;
      review(candidate, "rejected-negative", "negative");
      continue;
    }

    const pathEvidence = pathBoundaryEvidence(pixels, evidence);
    if (pathEvidence == null) {
      rejected.evidenceUnavailable += 1;
      review(candidate, "rejected-evidence", "evidence-unavailable");
      continue;
    }
    if (pathEvidence < minPathEvidence) {
      rejected.evidence += 1;
      review(candidate, "rejected-evidence", "evidence", { pathEvidence });
      continue;
    }
    if (acceptedCandidates.length >= maxAcceptedBridges) {
      rejected.limit += 1;
      review(candidate, "rejected-limit", "limit", { pathEvidence });
      continue;
    }

    let candidateAddedPixels = 0;
    for (const p of pixels) {
      if (!mask[p]) {
        mask[p] = 1;
        bridgeMask[p] = 1;
        candidateAddedPixels += 1;
      }
    }
    if (!candidateAddedPixels) continue;

    usedEndpoints.add(endpointA);
    usedEndpoints.add(endpointB);
    addedPixels += candidateAddedPixels;
    const accepted = {
      ...candidate,
      pathEvidence,
      addedPixels: candidateAddedPixels,
    };
    acceptedCandidates.push(accepted);
    review(accepted, "accepted-extended", null, { pathEvidence });
  }

  return {
    mode: "extended",
    mask,
    bridgeMask,
    acceptedCandidates,
    reviewCandidates,
    sourceCandidateCount: diagnostics.candidateCount ?? 0,
    consideredCandidateCount: diagnostics.candidates?.length ?? 0,
    acceptedBridgeCount: acceptedCandidates.length,
    addedPixels,
    rejected,
    truncated: Boolean(diagnostics.truncated),
    settings: {
      safeMaxDistance,
      extendedMaxDistance,
      minScore,
      minPathEvidence,
      negativeGuardRadius,
      maxGapAngleDeg: diagnostics.maxGapAngleDeg,
      detectionMaxDistance: diagnostics.maxGapDistance,
      maxAcceptedBridges,
    },
  };
}

export function proposeExtendedGapBridges(prediction, width, height, options = {}) {
  if (!prediction || prediction.length !== width * height) {
    throw new Error("Extended Gap Bridge用の境界マスクが不正です。");
  }
  const extendedMaxDistance = Math.max(
    Number(options.gapApplyMaxDistance ?? 3.25) + 0.25,
    Math.min(8, Number(options.extendedGapMaxDistance ?? 8)),
  );
  const diagnostics = collectEndpointCandidates(prediction, width, height, {
    ...options,
    maxGapDistance: extendedMaxDistance,
    maxGapCandidates: options.maxGapProposalCandidates ?? 2400,
  });
  return buildExtendedGapProposal(prediction, width, height, diagnostics, options);
}

export function computeClosureSnapshot(prediction, width, height, seeds = [], options = {}) {
  if (!prediction || prediction.length !== width * height) {
    throw new Error("Closure診断用の境界マスクが不正です。");
  }
  const closedNegativeMask = options.closedNegativeMask ?? null;
  const borderAssistedMask = options.borderAssistedMask ?? null;
  const coreErosionRadius = Math.max(0, Math.round(options.coreErosionRadius ?? 2));
  const minCorePixels = Math.max(1, Math.round(options.minCorePixels ?? 12));
  const coreMask = closedNegativeMask?.length === prediction.length
    ? erodeSquare(closedNegativeMask, width, height, coreErosionRadius)
    : null;
  const coreIndex = coreMask
    ? buildComponentIndex(coreMask, width, height, minCorePixels, true)
    : null;
  const fillIndex = closedNegativeMask?.length === prediction.length
    ? buildComponentIndex(closedNegativeMask, width, height, 1, true)
    : null;
  const coreMeta = coreIndex && fillIndex
    ? buildCoreParentMetadata(coreIndex, fillIndex, borderAssistedMask)
    : null;
  const useCoreRegions = Boolean(coreIndex?.componentCount);
  const backgroundIndex = buildComponentIndex(prediction, width, height, 1, false);
  const classified = useCoreRegions
    ? classifyCoreClosure(prediction, backgroundIndex, coreIndex, fillIndex, coreMeta, options)
    : classifySeedFallback(prediction, backgroundIndex, seeds, width, height, options);

  return {
    basis: useCoreRegions ? "closed-negative-eroded-core" : "seed-fallback",
    seedCount: (seeds ?? []).length,
    borderAssistedSeedCount: (seeds ?? []).filter(seed => seed?.borderAssisted).length,
    coreErosionRadius: useCoreRegions ? coreErosionRadius : null,
    minCorePixels: useCoreRegions ? minCorePixels : null,
    coreRegionCount: useCoreRegions ? coreIndex.componentCount : 0,
    corePixels: useCoreRegions ? coreIndex.componentPixels : 0,
    ...classified,
  };
}


function summarizeClosureProfile(closureByBridgeRadius) {
  const items = [...(closureByBridgeRadius ?? [])].sort((a, b) => a.bridgeRadius - b.bridgeRadius);
  const regionCount = items[0]?.regionCount ?? 0;
  if (!regionCount || !items.length) {
    return {
      regionCount,
      weightedClosureScore: null,
      meanRequiredRadiusCapped: null,
      maxRadius: items.at(-1)?.bridgeRadius ?? null,
      minimumRadiusHistogram: {},
      openAfterMaxRadius: regionCount,
    };
  }

  const rates = items.map(item => item.closureRate ?? 0);
  const weightedClosureScore = rates.reduce((sum, value) => sum + value, 0) / rates.length;
  const minimumRadiusHistogram = {};
  let previousClosed = 0;
  let weightedRequired = 0;
  for (const item of items) {
    const newlyClosed = Math.max(0, (item.closedRegions ?? 0) - previousClosed);
    minimumRadiusHistogram[String(item.bridgeRadius)] = newlyClosed;
    weightedRequired += newlyClosed * item.bridgeRadius;
    previousClosed = Math.max(previousClosed, item.closedRegions ?? 0);
  }
  const maxRadius = items.at(-1)?.bridgeRadius ?? 0;
  const openAfterMaxRadius = Math.max(0, regionCount - previousClosed);
  minimumRadiusHistogram[">" + maxRadius] = openAfterMaxRadius;
  weightedRequired += openAfterMaxRadius * (maxRadius + 1);

  return {
    regionCount,
    weightedClosureScore,
    meanRequiredRadiusCapped: weightedRequired / regionCount,
    maxRadius,
    minimumRadiusHistogram,
    openAfterMaxRadius,
  };
}

export function computeClosureProfile(prediction, width, height, seeds = [], options = {}) {
  if (!prediction || prediction.length !== width * height) {
    throw new Error("Closure Profile用の境界マスクが不正です。");
  }
  const bridgeRadii = [...new Set((options.bridgeRadii ?? [0, 1, 2, 3])
    .map(value => Math.max(0, Math.round(value))))]
    .sort((a, b) => a - b);
  const closedNegativeMask = options.closedNegativeMask ?? null;
  const borderAssistedMask = options.borderAssistedMask ?? null;
  const coreErosionRadius = Math.max(0, Math.round(options.coreErosionRadius ?? 2));
  const minCorePixels = Math.max(1, Math.round(options.minCorePixels ?? 12));
  const coreMask = closedNegativeMask?.length === prediction.length
    ? erodeSquare(closedNegativeMask, width, height, coreErosionRadius)
    : null;
  const coreIndex = coreMask
    ? buildComponentIndex(coreMask, width, height, minCorePixels, true)
    : null;
  const fillIndex = closedNegativeMask?.length === prediction.length
    ? buildComponentIndex(closedNegativeMask, width, height, 1, true)
    : null;
  const coreMeta = coreIndex && fillIndex
    ? buildCoreParentMetadata(coreIndex, fillIndex, borderAssistedMask)
    : null;
  // Select cores by their original full-image fill component, never a crop edge.
  if (coreIndex && fillIndex && Number.isInteger(options.targetSeedP)) {
    const parent = fillIndex.labels[options.targetSeedP] ?? 0;
    coreIndex.componentCount = 0;
    coreIndex.componentPixels = 0;
    for (let label = 1; label < coreIndex.active.length; label += 1) {
      if (!parent || coreMeta.parentFillLabel[label] !== parent) coreIndex.active[label] = 0;
      if (coreIndex.active[label]) {
        coreIndex.componentCount += 1;
        coreIndex.componentPixels += coreIndex.sizes[label];
      }
    }
  }
  const useCoreRegions = Boolean(coreIndex?.componentCount);
  if (Number.isInteger(options.targetSeedP) && !useCoreRegions) {
    return { basis: "closed-negative-eroded-core", regionCount: 0,
      closureByBridgeRadius: [], weightedClosureScore: null, maxRadius: bridgeRadii.at(-1),
      meanRequiredRadiusCapped: null, openAfterMaxRadius: 0, minimumRadiusHistogram: {} };
  }
  const closureByBridgeRadius = [];
  for (const radius of bridgeRadii) {
    const wall = radius > 0
      ? dilateBinaryMask(prediction, width, height, radius)
      : prediction;
    const backgroundIndex = buildComponentIndex(wall, width, height, 1, false);
    const classified = useCoreRegions
      ? classifyCoreClosure(wall, backgroundIndex, coreIndex, fillIndex, coreMeta, options)
      : classifySeedFallback(wall, backgroundIndex, seeds, width, height, options);
    closureByBridgeRadius.push({ bridgeRadius: radius, ...classified });
  }
  return {
    basis: useCoreRegions ? "closed-negative-eroded-core" : "seed-fallback",
    coreRegionCount: useCoreRegions ? coreIndex.componentCount : 0,
    closureByBridgeRadius,
    ...summarizeClosureProfile(closureByBridgeRadius),
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
  const shortGapCandidates = collectEndpointCandidates(prediction, width, height, options);
  const safeGapProposal = proposeShortGapBridges(prediction, width, height, options);
  const extendedGapProposal = options.boundaryEvidence
    ? proposeExtendedGapBridges(prediction, width, height, options)
    : null;

  const closedNegativeMask = options.closedNegativeMask ?? null;
  const borderAssistedMask = options.borderAssistedMask ?? null;
  const coreErosionRadius = Math.max(0, Math.round(options.coreErosionRadius ?? 2));
  const minCorePixels = Math.max(1, Math.round(options.minCorePixels ?? 12));
  const coreMask = closedNegativeMask?.length === prediction.length
    ? erodeSquare(closedNegativeMask, width, height, coreErosionRadius)
    : null;
  const coreIndex = coreMask
    ? buildComponentIndex(coreMask, width, height, minCorePixels, true)
    : null;
  const fillIndex = closedNegativeMask?.length === prediction.length
    ? buildComponentIndex(closedNegativeMask, width, height, 1, true)
    : null;
  const coreMeta = coreIndex && fillIndex
    ? buildCoreParentMetadata(coreIndex, fillIndex, borderAssistedMask)
    : null;
  const useCoreRegions = Boolean(coreIndex?.componentCount);

  const closureByBridgeRadius = [];
  for (const radius of bridgeRadii) {
    const wall = radius > 0
      ? dilateBinaryMask(prediction, width, height, radius)
      : prediction;
    const backgroundIndex = buildComponentIndex(wall, width, height, 1, false);
    const classified = useCoreRegions
      ? classifyCoreClosure(wall, backgroundIndex, coreIndex, fillIndex, coreMeta, options)
      : classifySeedFallback(wall, backgroundIndex, seeds, width, height, options);
    closureByBridgeRadius.push({
      bridgeRadius: radius,
      ...classified,
    });
  }

  const base = closureByBridgeRadius.find(item => item.bridgeRadius === 0)
    ?? closureByBridgeRadius[0]
    ?? null;
  const closureProfile = summarizeClosureProfile(closureByBridgeRadius);
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
      borderAssistedClosedRegions: item.borderAssistedClosedRegions ?? 0,
    });
    previousClosed = Math.max(previousClosed, item.closedRegions);
  }

  return {
    version: 3,
    revision: "3.0-minimum-closure-profile",
    mode: "diagnostic-with-closure-profile-and-opt-in-gap",
    endpointProxy: endpoint,
    shortGapCandidates,
    safeGapBridge: {
      sourceCandidateCount: safeGapProposal.sourceCandidateCount,
      consideredCandidateCount: safeGapProposal.consideredCandidateCount,
      acceptedBridgeCount: safeGapProposal.acceptedBridgeCount,
      addedPixels: safeGapProposal.addedPixels,
      rejected: safeGapProposal.rejected,
      truncated: safeGapProposal.truncated,
      settings: safeGapProposal.settings,
      acceptedCandidates: safeGapProposal.acceptedCandidates.slice(0, 160),
    },
    extendedGapBridge: extendedGapProposal ? {
      sourceCandidateCount: extendedGapProposal.sourceCandidateCount,
      consideredCandidateCount: extendedGapProposal.consideredCandidateCount,
      acceptedBridgeCount: extendedGapProposal.acceptedBridgeCount,
      addedPixels: extendedGapProposal.addedPixels,
      rejected: extendedGapProposal.rejected,
      truncated: extendedGapProposal.truncated,
      settings: extendedGapProposal.settings,
      acceptedCandidates: extendedGapProposal.acceptedCandidates.slice(0, 160),
    } : null,
    regionClosure: {
      basis: useCoreRegions ? "closed-negative-eroded-core" : "seed-fallback",
      seedCount: (seeds ?? []).length,
      borderAssistedSeedCount: (seeds ?? []).filter(seed => seed?.borderAssisted).length,
      coreErosionRadius: useCoreRegions ? coreErosionRadius : null,
      minCorePixels: useCoreRegions ? minCorePixels : null,
      coreRegionCount: useCoreRegions ? coreIndex.componentCount : 0,
      corePixels: useCoreRegions ? coreIndex.componentPixels : 0,
      baseClosureRate: base?.closureRate ?? null,
      baseClosedRegions: base?.closedRegions ?? 0,
      baseOpenRegions: base?.openRegions ?? 0,
      baseBorderAssistedRegions: base?.borderAssistedRegions ?? 0,
      baseBorderAssistedClosedRegions: base?.borderAssistedClosedRegions ?? 0,
      closureByBridgeRadius,
      recovery,
      profile: closureProfile,
      note: "Ordinary cores are open when their prediction-background component reaches any image edge. Border-assisted cores explicitly remember the edge set represented by their annotated fill: a single edge or two adjacent corner edges may remain reachable, another edge is a leak, opposite-edge or >2-edge topology is invalid, and excessive reachable area remains open. Core coverage is reported separately.",
    },
    note: "Topology v3.0 adds a Minimum Closure Radius profile. The weighted closure score averages closure rates across 0/1/2/3 px probes so partial topology improvements are measurable even when 0 px closure stays at zero. Safe/Extended Gap remain guarded post-processing stages.",
  };
}

// Reuse annotation indexes and dilated base walls. Candidate additions can only
// remove background connections, so unchanged background components are reusable.
export function createTargetClosureEvaluator(width, height, options = {}) {
  const size = width * height;
  const closed = options.closedNegativeMask;
  if (closed?.length !== size) return null;
  const erosion = Math.max(0, Math.round(options.coreErosionRadius ?? 2));
  const core = buildComponentIndex(erodeSquare(closed, width, height, erosion), width, height,
    Math.max(1, Math.round(options.minCorePixels ?? 12)), true);
  const fill = buildComponentIndex(closed, width, height, 1, true);
  const meta = buildCoreParentMetadata(core, fill, options.borderAssistedMask);
  const groups = new Map();
  for (let label = 1; label < core.active.length; label++) {
    if (!core.active[label]) continue;
    const parent = meta.parentFillLabel[label];
    if (!groups.has(parent)) groups.set(parent, []);
    groups.get(parent).push({ label, pixels: [], borderAssisted: Boolean(meta.borderAssisted[label]) });
  }
  const byLabel = new Map([...groups.values()].flat().map(item => [item.label, item]));
  for (let p = 0; p < size; p++) byLabel.get(core.labels[p])?.pixels.push(p);
  const maxRadius = Math.max(0, Math.min(4, Math.round(options.topologyProbeMaxRadius ?? 3)));
  const cache = new WeakMap();
  const visited = new Uint32Array(size);
  const queue = new Int32Array(size);
  let stamp = 0;
  const stats = { baseBuilds: 0, evaluations: 0, traversedPixels: 0, reusedComponents: 0, fallbackEvaluations: 0 };
  function baseFor(mask) {
    let base = cache.get(mask);
    if (!base) {
      base = Array.from({ length: maxRadius + 1 }, (_, r) => {
        const wall = r ? dilateBinaryMask(mask, width, height, r) : mask;
        return { wall, background: buildComponentIndex(wall, width, height, 1, false) };
      });
      cache.set(mask, base);
      stats.baseBuilds++;
    }
    return base;
  }
  return {
    stats,
    invalidate(mask) { cache.delete(mask); },
    evaluate(mask, seedP, additions = null) {
      stats.evaluations++;
      const selected = groups.get(fill.labels[seedP]) ?? [];
      if (selected.some(item => item.borderAssisted)) {
        stats.fallbackEvaluations++;
        const changed = additions?.size ? mask.slice() : mask;
        if (additions?.size) for (const p of additions) changed[p] = 1;
        return computeClosureProfile(changed, width, height, [], { ...options, targetSeedP: seedP,
          bridgeRadii: Array.from({ length: maxRadius + 1 }, (_, r) => r) });
      }
      const base = baseFor(mask);
      const probes = base.map(({ wall, background }, radius) => {
        const extra = new Set();
        for (const p of additions ?? []) {
          const x = p % width, y = Math.floor(p / width);
          for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
            const nx = x + dx, ny = y + dy;
            if (nx >= 0 && ny >= 0 && nx < width && ny < height) extra.add(ny * width + nx);
          }
        }
        const affected = new Set([...extra].map(p => background.labels[p]).filter(Boolean));
        let openRegions = 0;
        for (const item of selected) {
          let open = false;
          // A core may straddle several background components. Every one must close.
          stamp++;
          if (stamp >= 0xffffffff) { visited.fill(0); stamp = 1; }
          for (const start of item.pixels) {
            if (wall[start] || extra.has(start) || visited[start] === stamp) continue;
            const label = background.labels[start];
            if (!affected.has(label)) {
              stats.reusedComponents++;
              if (background.edgeMasks[label]) { open = true; break; }
              continue;
            }
            let head = 0, tail = 0;
            queue[tail++] = start; visited[start] = stamp;
            while (head < tail && !open) {
              const p = queue[head++], x = p % width, y = Math.floor(p / width);
              stats.traversedPixels++;
              if (x === 0 || y === 0 || x === width - 1 || y === height - 1) { open = true; break; }
              for (const np of [p - 1, p + 1, p - width, p + width]) {
                if (visited[np] === stamp || wall[np] || extra.has(np)) continue;
                visited[np] = stamp; queue[tail++] = np;
              }
            }
            if (open) break;
          }
          if (open) openRegions++;
        }
        return { bridgeRadius: radius, regionCount: selected.length, openRegions,
          closedRegions: selected.length - openRegions,
          closureRate: selected.length ? (selected.length - openRegions) / selected.length : null };
      });
      return { basis: 'closed-negative-eroded-core', closureByBridgeRadius: probes,
        ...summarizeClosureProfile(probes) };
    },
  };
}
