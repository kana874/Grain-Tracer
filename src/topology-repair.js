import { computeClosureProfile, createTargetClosureEvaluator } from "./topology.js";

const DIRS8 = Object.freeze([
  [-1, -1], [0, -1], [1, -1],
  [-1, 0],             [1, 0],
  [-1, 1],  [0, 1],   [1, 1],
]);
const DIRS4 = Object.freeze([[-1, 0], [1, 0], [0, -1], [0, 1]]);

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function evidenceValue(source, index) {
  if (!source || index < 0 || index >= source.length) return null;
  const value = Number(source[index]);
  if (!Number.isFinite(value)) return null;
  return clamp01(value > 1 ? value / 255 : value);
}

function pointFromIndex(index, width) {
  return { x: index % width, y: Math.floor(index / width) };
}

function indexOf(width, x, y) {
  return y * width + x;
}

function inBounds(width, height, x, y) {
  return x >= 0 && y >= 0 && x < width && y < height;
}

function boundaryNeighbors(mask, width, height, p) {
  const x = p % width;
  const y = Math.floor(p / width);
  const result = [];
  for (const [dx, dy] of DIRS8) {
    const nx = x + dx;
    const ny = y + dy;
    if (!inBounds(width, height, nx, ny)) continue;
    const np = indexOf(width, nx, ny);
    if (mask[np]) result.push(np);
  }
  return result;
}

function angleDeg(ax, ay, bx, by) {
  const al = Math.hypot(ax, ay);
  const bl = Math.hypot(bx, by);
  if (!al || !bl) return 180;
  const dot = Math.max(-1, Math.min(1, (ax * bx + ay * by) / (al * bl)));
  return Math.acos(dot) * 180 / Math.PI;
}

function normalized(dx, dy) {
  const length = Math.hypot(dx, dy) || 1;
  return { x: dx / length, y: dy / length };
}

function estimateEndpointOutward(mask, width, height, p, depth = 4) {
  const start = pointFromIndex(p, width);
  const chain = [p];
  let prev = -1;
  let current = p;
  for (let step = 0; step < depth; step += 1) {
    const next = boundaryNeighbors(mask, width, height, current).filter(np => np !== prev);
    if (!next.length) break;
    const chosen = next[0];
    chain.push(chosen);
    prev = current;
    current = chosen;
    if (next.length > 1) break;
  }
  if (chain.length < 2) return { x: 0, y: 0 };
  const tail = pointFromIndex(chain[chain.length - 1], width);
  return normalized(start.x - tail.x, start.y - tail.y);
}

function meanEvidenceForPixels(pixels, options = {}) {
  if (!pixels?.length) {
    return { boundaryProbability: null, ridge: null, color: null, dendritePenalty: null };
  }
  let probability = 0;
  let probabilityCount = 0;
  let ridge = 0;
  let ridgeCount = 0;
  let color = 0;
  let colorCount = 0;
  let dendritePenalty = 0;
  let dendriteCount = 0;
  for (const p of pixels) {
    const direct = evidenceValue(options.boundaryProbability, p);
    const r = evidenceValue(options.ridge, p);
    const c = evidenceValue(options.color, p);
    const d = evidenceValue(options.dendritePenalty, p);
    if (direct != null) {
      probability += direct;
      probabilityCount += 1;
    } else if (r != null || c != null) {
      probability += (r ?? 0) * 0.65 + (c ?? 0) * 0.35;
      probabilityCount += 1;
    }
    if (r != null) { ridge += r; ridgeCount += 1; }
    if (c != null) { color += c; colorCount += 1; }
    if (d != null) { dendritePenalty += d; dendriteCount += 1; }
  }
  return {
    boundaryProbability: probabilityCount ? probability / probabilityCount : null,
    ridge: ridgeCount ? ridge / ridgeCount : null,
    color: colorCount ? color / colorCount : null,
    dendritePenalty: dendriteCount ? dendritePenalty / dendriteCount : null,
  };
}

function edgeCurvature(pixels, width) {
  if (!pixels || pixels.length < 3) return 0;
  let total = 0;
  let count = 0;
  for (let i = 1; i + 1 < pixels.length; i += 1) {
    const a = pointFromIndex(pixels[i - 1], width);
    const b = pointFromIndex(pixels[i], width);
    const c = pointFromIndex(pixels[i + 1], width);
    total += angleDeg(b.x - a.x, b.y - a.y, c.x - b.x, c.y - b.y);
    count += 1;
  }
  return count ? total / count : 0;
}

function representativePixel(pixels, width) {
  if (!pixels.length) return -1;
  let cx = 0;
  let cy = 0;
  for (const p of pixels) {
    const pt = pointFromIndex(p, width);
    cx += pt.x;
    cy += pt.y;
  }
  cx /= pixels.length;
  cy /= pixels.length;
  let best = pixels[0];
  let bestDistance = Infinity;
  for (const p of pixels) {
    const pt = pointFromIndex(p, width);
    const distance = (pt.x - cx) ** 2 + (pt.y - cy) ** 2;
    if (distance < bestDistance) {
      best = p;
      bestDistance = distance;
    }
  }
  return best;
}

export function buildSkeletonGraph(mask, width, height, options = {}) {
  if (!mask || mask.length !== width * height) {
    throw new Error("Skeleton Graph用の境界マスクが不正です。");
  }

  const degree = new Uint8Array(mask.length);
  for (let p = 0; p < mask.length; p += 1) {
    if (!mask[p]) continue;
    degree[p] = boundaryNeighbors(mask, width, height, p).length;
  }

  const pixelToNode = new Int32Array(mask.length);
  pixelToNode.fill(-1);
  const nodes = [];
  const visitedJunction = new Uint8Array(mask.length);
  const junctionQueue = new Int32Array(mask.length);

  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || degree[start] < 3 || visitedJunction[start]) continue;
    let head = 0;
    let tail = 0;
    const pixels = [];
    visitedJunction[start] = 1;
    junctionQueue[tail++] = start;
    while (head < tail) {
      const p = junctionQueue[head++];
      pixels.push(p);
      const x = p % width;
      const y = Math.floor(p / width);
      for (const [dx, dy] of DIRS8) {
        const nx = x + dx;
        const ny = y + dy;
        if (!inBounds(width, height, nx, ny)) continue;
        const np = indexOf(width, nx, ny);
        if (!mask[np] || degree[np] < 3 || visitedJunction[np]) continue;
        visitedJunction[np] = 1;
        junctionQueue[tail++] = np;
      }
    }
    const representative = representativePixel(pixels, width);
    const pt = pointFromIndex(representative, width);
    const node = {
      id: nodes.length,
      type: "junction",
      p: representative,
      x: pt.x,
      y: pt.y,
      degree: 0,
      pixels,
      incidentEdgeIds: [],
      incidentDirections: [],
    };
    nodes.push(node);
    for (const p of pixels) pixelToNode[p] = node.id;
  }

  for (let p = 0; p < mask.length; p += 1) {
    if (!mask[p] || degree[p] !== 1 || pixelToNode[p] >= 0) continue;
    const pt = pointFromIndex(p, width);
    const outward = estimateEndpointOutward(mask, width, height, p, options.tangentDepth ?? 4);
    const node = {
      id: nodes.length,
      type: "endpoint",
      p,
      x: pt.x,
      y: pt.y,
      degree: 1,
      pixels: [p],
      outward,
      incidentEdgeIds: [],
      incidentDirections: [],
    };
    pixelToNode[p] = node.id;
    nodes.push(node);
  }

  const edges = [];
  const walkedSegments = new Set();
  const segmentKey = (a, b) => a < b ? `${a}:${b}` : `${b}:${a}`;

  for (const startNode of nodes) {
    for (const startPixel of startNode.pixels) {
      for (const first of boundaryNeighbors(mask, width, height, startPixel)) {
        if (pixelToNode[first] === startNode.id) continue;
        const firstKey = segmentKey(startPixel, first);
        if (walkedSegments.has(firstKey)) continue;

        const pixels = [startPixel];
        let prev = startPixel;
        let current = first;
        let endNodeId = pixelToNode[current];

        while (true) {
          pixels.push(current);
          walkedSegments.add(segmentKey(prev, current));
          if (endNodeId >= 0) break;
          const nextCandidates = boundaryNeighbors(mask, width, height, current)
            .filter(np => np !== prev);
          if (!nextCandidates.length) break;
          let next = nextCandidates[0];
          if (nextCandidates.length > 1) {
            next = nextCandidates.find(np => pixelToNode[np] >= 0) ?? next;
          }
          prev = current;
          current = next;
          endNodeId = pixelToNode[current];
          if (pixels.length > mask.length) break;
        }

        if (endNodeId < 0 || endNodeId === startNode.id || pixels.length < 2) continue;
        const endNode = nodes[endNodeId];
        const metrics = meanEvidenceForPixels(pixels, options);
        const edge = {
          id: edges.length,
          startNodeId: startNode.id,
          endNodeId,
          pixels,
          lengthPx: Math.max(0, pixels.length - 1),
          meanBoundaryScore: metrics.boundaryProbability,
          meanRidge: metrics.ridge,
          meanColor: metrics.color,
          curvature: edgeCurvature(pixels, width),
        };
        edges.push(edge);
        startNode.incidentEdgeIds.push(edge.id);
        endNode.incidentEdgeIds.push(edge.id);
      }
    }
  }

  for (const node of nodes) {
    node.degree = node.incidentEdgeIds.length || node.degree;
    for (const edgeId of node.incidentEdgeIds) {
      const edge = edges[edgeId];
      if (!edge) continue;
      const fromStart = edge.startNodeId === node.id;
      const list = fromStart ? edge.pixels : [...edge.pixels].reverse();
      const a = pointFromIndex(list[0], width);
      const b = pointFromIndex(list[Math.min(list.length - 1, 2)], width);
      node.incidentDirections.push(normalized(b.x - a.x, b.y - a.y));
    }
  }

  return {
    version: 4,
    width,
    height,
    nodes,
    edges,
    degree,
    pixelToNode,
    endpointCount: nodes.filter(node => node.type === "endpoint").length,
    junctionCount: nodes.filter(node => node.type === "junction").length,
    edgeCount: edges.length,
    boundaryPixels: mask.reduce((sum, value) => sum + (value ? 1 : 0), 0),
  };
}

export function compactSkeletonGraph(graph, options = {}) {
  if (!graph) return null;
  const maxNodes = Math.max(1, Math.round(options.maxNodes ?? 240));
  const maxEdges = Math.max(1, Math.round(options.maxEdges ?? 360));
  return {
    version: graph.version ?? 4,
    width: graph.width,
    height: graph.height,
    boundaryPixels: graph.boundaryPixels ?? 0,
    endpointCount: graph.endpointCount ?? 0,
    junctionCount: graph.junctionCount ?? 0,
    edgeCount: graph.edgeCount ?? 0,
    nodes: (graph.nodes ?? []).slice(0, maxNodes).map(node => ({
      id: node.id,
      type: node.type,
      x: node.x,
      y: node.y,
      degree: node.degree,
      incidentEdgeIds: [...(node.incidentEdgeIds ?? [])],
    })),
    edges: (graph.edges ?? []).slice(0, maxEdges).map(edge => ({
      id: edge.id,
      startNodeId: edge.startNodeId,
      endNodeId: edge.endNodeId,
      lengthPx: edge.lengthPx,
      meanBoundaryScore: edge.meanBoundaryScore,
      meanRidge: edge.meanRidge,
      meanColor: edge.meanColor,
      curvature: edge.curvature,
      pixelCount: edge.pixels?.length ?? 0,
    })),
    nodesTruncated: (graph.nodes?.length ?? 0) > maxNodes,
    edgesTruncated: (graph.edges?.length ?? 0) > maxEdges,
  };
}

function buildGuardMask(source, width, height, radius) {
  if (!source || source.length !== width * height) return null;
  if (radius <= 0) return source;
  const result = new Uint8Array(source.length);
  for (let p = 0; p < source.length; p += 1) {
    if (!source[p]) continue;
    const x = p % width;
    const y = Math.floor(p / width);
    for (let dy = -radius; dy <= radius; dy += 1) {
      const ny = y + dy;
      if (ny < 0 || ny >= height) continue;
      for (let dx = -radius; dx <= radius; dx += 1) {
        const nx = x + dx;
        if (nx < 0 || nx >= width) continue;
        result[indexOf(width, nx, ny)] = 1;
      }
    }
  }
  return result;
}

function protectedByFrame(width, height, x, y, margin) {
  return margin > 0 && (
    x < margin || y < margin || x >= width - margin || y >= height - margin
  );
}

function junctionAcceptsDirection(node, vx, vy, minAngleDeg) {
  if (!node?.incidentDirections?.length) return true;
  const outwardFromJunction = normalized(-vx, -vy);
  let minimum = 180;
  for (const direction of node.incidentDirections) {
    minimum = Math.min(
      minimum,
      angleDeg(outwardFromJunction.x, outwardFromJunction.y, direction.x, direction.y),
    );
  }
  return minimum >= minAngleDeg;
}

function buildComponentLabels(mask, width, height) {
  const labels = new Int32Array(mask.length);
  const queue = new Int32Array(mask.length);
  const components = [];
  let label = 0;
  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || labels[start]) continue;
    label += 1;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    labels[start] = label;
    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;
    let pixels = 0;
    let firstPixel = start;
    while (head < tail) {
      const p = queue[head++];
      const x = p % width;
      const y = Math.floor(p / width);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      pixels += 1;
      for (const [dx, dy] of DIRS4) {
        const nx = x + dx;
        const ny = y + dy;
        if (!inBounds(width, height, nx, ny)) continue;
        const np = indexOf(width, nx, ny);
        if (!mask[np] || labels[np]) continue;
        labels[np] = label;
        queue[tail++] = np;
      }
    }
    components.push({
      id: label,
      minX,
      minY,
      maxX,
      maxY,
      pixels,
      firstPixel,
      seedP: firstPixel,
      seedCount: 0,
      borderAssisted: false,
    });
  }
  return { labels, components };
}

function maskAt(mask, p, additions) {
  return Boolean(mask[p] || additions?.has(p));
}

export function targetClosureSignature(mask, width, height, target, options = {}, additions = null) {
  const maxRadius = Math.max(0, Math.min(4, Math.round(options.topologyProbeMaxRadius ?? 3)));
  const wall = additions?.size && !options.targetClosureEvaluator ? mask.slice() : mask;
  if (additions?.size && !options.targetClosureEvaluator) for (const p of additions) wall[p] = 1;
  const profile = options.targetClosureEvaluator
    ? options.targetClosureEvaluator.evaluate(mask, target.seedP, additions)
    : computeClosureProfile(wall, width, height, [], {
    ...options,
    targetSeedP: target.seedP,
    bridgeRadii: Array.from({ length: maxRadius + 1 }, (_, radius) => radius),
  });
  const measurable = profile.regionCount > 0;
  const probes = profile.closureByBridgeRadius.map(item => ({
    radius: item.bridgeRadius,
    closed: measurable && item.openRegions === 0,
  }));
  return {
    measurable,
    coreRegionCount: profile.regionCount,
    requiredRadius: probes.find(probe => probe.closed)?.radius ?? maxRadius + 1,
    weightedClosureScore: profile.weightedClosureScore ?? 0,
    exactClosed: Boolean(probes[0]?.closed),
    openAfterMaxRadius: measurable ? profile.openAfterMaxRadius : 1,
    maxRadius,
    maxRadiusBorderContacts: 0,
    maxRadiusReachableArea: 0,
    probes,
  };
}

function targetImprovement(before, after) {
  if (!before || !after) {
    return {
      improved: false,
      exactGain: 0,
      weightedGain: 0,
      radiusGain: 0,
      openGain: 0,
      borderContactGain: 0,
      reachableAreaGain: 0,
      progressScore: 0,
    };
  }
  const exactGain = Number(after.exactClosed) - Number(before.exactClosed);
  const weightedGain = (after.weightedClosureScore ?? 0) - (before.weightedClosureScore ?? 0);
  const radiusGain = (before.requiredRadius ?? 99) - (after.requiredRadius ?? 99);
  const openGain = (before.openAfterMaxRadius ?? 0) - (after.openAfterMaxRadius ?? 0);
  const borderContactGain =
    (before.maxRadiusBorderContacts ?? 0) - (after.maxRadiusBorderContacts ?? 0);
  const reachableAreaGain =
    (before.maxRadiusReachableArea ?? 0) - (after.maxRadiusReachableArea ?? 0);
  const areaBase = Math.max(1, before.maxRadiusReachableArea ?? 0);
  const partialProgress =
    borderContactGain > 0
    && reachableAreaGain > Math.max(3, areaBase * 0.005);
  const improved = exactGain > 0 || weightedGain > 1e-9 || radiusGain > 0 || openGain > 0 || partialProgress;
  const progressScore =
      exactGain * 8
    + weightedGain * 6
    + Math.max(0, radiusGain) * 2
    + Math.max(0, openGain) * 4
    + Math.max(0, borderContactGain) * 0.08
    + Math.max(0, reachableAreaGain / areaBase) * 0.6;
  return {
    improved,
    exactGain,
    weightedGain,
    radiusGain,
    openGain,
    borderContactGain,
    reachableAreaGain,
    progressScore,
  };
}

function buildTopologyTargetContext(prediction, width, height, options = {}) {
  const closed = options.closedNegativeMask;
  if (!closed || closed.length !== prediction.length) return null;

  const { labels, components } = buildComponentLabels(closed, width, height);
  if (!components.length) return null;

  const componentById = new Map(components.map(component => [component.id, component]));
  const seeds = Array.isArray(options.closedNegativeSeeds) ? options.closedNegativeSeeds : [];
  if (seeds.length) {
    for (const seed of seeds) {
      const x = Math.round(Number(seed?.x));
      const y = Math.round(Number(seed?.y));
      if (!Number.isFinite(x) || !Number.isFinite(y) || !inBounds(width, height, x, y)) continue;
      const p = indexOf(width, x, y);
      const id = labels[p];
      if (!id) continue;
      const component = componentById.get(id);
      if (!component) continue;
      component.seedP = p;
      component.seedCount += 1;
      if (seed?.borderAssisted) component.borderAssisted = true;
    }
  }

  if (options.borderAssistedMask?.length === prediction.length) {
    for (let p = 0; p < options.borderAssistedMask.length; p += 1) {
      if (!options.borderAssistedMask[p]) continue;
      const id = labels[p];
      if (id) {
        const component = componentById.get(id);
        if (component) component.borderAssisted = true;
      }
    }
  }

  const useSeededOnly = seeds.length > 0;
  const includeBorderAssisted = Boolean(options.includeBorderAssistedTargets);
  const targets = [];
  for (const component of components) {
    if (useSeededOnly && component.seedCount === 0) continue;
    if (component.borderAssisted && !includeBorderAssisted) continue;
    const before = targetClosureSignature(prediction, width, height, component, options);
    if (!before.measurable || before.exactClosed) continue;
    targets.push({
      ...component,
      before,
      priority: Math.max(1, Math.min(5, before.requiredRadius + (before.openAfterMaxRadius ? 1 : 0))),
    });
  }

  if (!targets.length) {
    return {
      labels,
      targetMap: new Int32Array(prediction.length),
      priorityMap: new Uint8Array(prediction.length),
      targets: [],
      targetById: new Map(),
      summary: {
        componentCount: components.length,
        seededComponentCount: components.filter(item => item.seedCount > 0).length,
        activeTargetCount: 0,
        excludedBorderAssistedCount: components.filter(item => item.borderAssisted && !includeBorderAssisted).length,
        byRequiredRadius: {},
      },
    };
  }

  const targetById = new Map(targets.map(target => [target.id, target]));
  const targetMap = new Int32Array(prediction.length);
  const priorityMap = new Uint8Array(prediction.length);
  const targetMemberships = new Map();
  const margin = Math.max(
    2,
    Math.min(32, Math.round(options.topologyTargetMargin ?? (Number(options.maxSearchDistance ?? 10) + 3))),
  );

  for (let p = 0; p < closed.length; p += 1) {
    const id = labels[p];
    if (!id || !targetById.has(id)) continue;
    const x = p % width;
    const y = Math.floor(p / width);
    let boundary = false;
    for (const [dx, dy] of DIRS4) {
      const nx = x + dx;
      const ny = y + dy;
      if (!inBounds(width, height, nx, ny) || labels[indexOf(width, nx, ny)] !== id) {
        boundary = true;
        break;
      }
    }
    if (!boundary) continue;
    const target = targetById.get(id);
    for (let dy = -margin; dy <= margin; dy += 1) {
      const ny = y + dy;
      if (ny < 0 || ny >= height) continue;
      for (let dx = -margin; dx <= margin; dx += 1) {
        const nx = x + dx;
        if (nx < 0 || nx >= width) continue;
        const np = indexOf(width, nx, ny);
        let memberships = targetMemberships.get(np);
        if (!memberships) targetMemberships.set(np, memberships = new Set());
        memberships.add(id);
        if (target.priority > priorityMap[np]) {
          priorityMap[np] = target.priority;
          targetMap[np] = id;
        }
      }
    }
  }

  const byRequiredRadius = {};
  for (const target of targets) {
    const key = target.before.requiredRadius > target.before.maxRadius
      ? `>${target.before.maxRadius}`
      : String(target.before.requiredRadius);
    byRequiredRadius[key] = (byRequiredRadius[key] ?? 0) + 1;
  }

  return {
    labels,
    targetMap,
    priorityMap,
    targetMemberships,
    targets,
    targetById,
    summary: {
      componentCount: components.length,
      seededComponentCount: components.filter(item => item.seedCount > 0).length,
      activeTargetCount: targets.length,
      excludedBorderAssistedCount: components.filter(item => item.borderAssisted && !includeBorderAssisted).length,
      targetMargin: margin,
      byRequiredRadius,
    },
  };
}

function makeSpatialIndex(nodes, cellSize) {
  const buckets = new Map();
  for (const node of nodes) {
    const cx = Math.floor(node.x / cellSize);
    const cy = Math.floor(node.y / cellSize);
    const key = `${cx},${cy}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(node);
    else buckets.set(key, [node]);
  }
  return {
    query(x, y) {
      const cx = Math.floor(x / cellSize);
      const cy = Math.floor(y / cellSize);
      const result = [];
      for (let oy = -1; oy <= 1; oy += 1) {
        for (let ox = -1; ox <= 1; ox += 1) {
          const bucket = buckets.get(`${cx + ox},${cy + oy}`);
          if (bucket) result.push(...bucket);
        }
      }
      return result;
    },
  };
}

function candidateTypePriority(type) {
  if (type === "endpoint-junction") return 3;
  if (type === "endpoint-boundary") return 2;
  return 1;
}

export function selectBalancedCandidates(byType, maxCandidates) {
  const types = ["endpoint-endpoint", "endpoint-boundary", "endpoint-junction", "boundary-boundary"].filter(type => byType[type]?.length);
  const quota = Math.max(1, Math.floor(maxCandidates / Math.max(1, types.length)));
  const selected = [];
  const leftovers = [];

  for (const type of types) {
    const groups = new Map();
    for (const item of byType[type] ?? []) {
      const id = item.topologyTargetId ?? 0;
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push(item);
    }
    const items = [];
    const queues = [...groups.values()];
    for (let rank = 0; queues.some(queue => rank < queue.length); rank += 1) {
      for (const queue of queues) if (queue[rank]) items.push(queue[rank]);
    }
    selected.push(...items.slice(0, quota));
    leftovers.push(...items.slice(quota));
  }

  leftovers.sort((a, b) =>
    (b.leakRouteScore ?? 0) - (a.leakRouteScore ?? 0)
    || (b.topologyPriority ?? 0) - (a.topologyPriority ?? 0)
    || candidateTypePriority(b.type) - candidateTypePriority(a.type)
    || (b.facing ?? 0) - (a.facing ?? 0)
    || a.distance - b.distance);
  selected.push(...leftovers.slice(0, Math.max(0, maxCandidates - selected.length)));
  return selected.slice(0, maxCandidates);
}

// Opposing boundary pixels across a real escape route can expose breaks
// whose raster graph has no degree-one endpoint (thick or branched lines).
export function escapeBoundaryCandidates(mask, width, height, route, targetId, memberships, maxDistance = 10, limit = 24) {
  const result = [], seen = new Set();
  for (const p of route) {
    const x = p % width, y = Math.floor(p / width);
    if (!memberships?.get(p)?.has(targetId)) continue;
    for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
      const hit = sign => {
        for (let step = 1; step <= maxDistance; step++) {
          const nx = x + dx * step * sign, ny = y + dy * step * sign;
          if (!inBounds(width, height, nx, ny)) return null;
          const q = indexOf(width, nx, ny);
          if (mask[q]) return { p: q, x: nx, y: ny };
        }
        return null;
      };
      const a = hit(-1), b = hit(1);
      if (!a || !b || !memberships.get(a.p)?.has(targetId) || !memberships.get(b.p)?.has(targetId)) continue;
      const distance = Math.hypot(b.x - a.x, b.y - a.y);
      if (distance <= 1.1 || distance > maxDistance) continue;
      const key = [a.p, b.p].sort((a, b) => a - b).join(':');
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ type: 'boundary-boundary', sourceNodeId: -a.p - 1, targetNodeId: null,
        sourceP: a.p, targetP: b.p, x1: a.x, y1: a.y, x2: b.x, y2: b.y,
        distance, facing: 1, sourceOutward: normalized(b.x - a.x, b.y - a.y), targetOutward: null,
        forcedTopologyTargetId: targetId, origin: 'escape-cross-section' });
    }
  }
  result.sort((a, b) => a.distance - b.distance);
  return result.slice(0, limit);
}

export function candidateGeometry(graph, mask, width, height, options, topologyContext = null) {
  const maxDistance = Math.max(2, Number(options.maxSearchDistance ?? 10));
  const maxEndpointAngleDeg = Math.max(5, Math.min(85, Number(options.maxEndpointAngleDeg ?? 50)));
  const junctionMinAngleDeg = Math.max(0, Math.min(90, Number(options.junctionMinAngleDeg ?? 20)));
  const minFacing = Math.cos(maxEndpointAngleDeg * Math.PI / 180);
  const maxBoundaryTargets = Math.max(1, Math.min(8, Math.round(options.maxBoundaryTargetsPerEndpoint ?? 3)));
  const maxCandidates = Math.max(3, Math.min(1500, Math.round(options.maxCandidates ?? 360)));
  const requireTopologyTarget = topologyContext?.targets?.length
    ? options.requireTopologyTarget !== false
    : false;
  const endpoints = graph.nodes.filter(node => node.type === "endpoint");
  const junctions = graph.nodes.filter(node => node.type === "junction");
  const cellSize = Math.max(3, Math.ceil(maxDistance + 1));
  const endpointIndex = makeSpatialIndex(endpoints, cellSize);
  const junctionIndex = makeSpatialIndex(junctions, cellSize);
  const byType = {
    "endpoint-endpoint": [],
    "endpoint-boundary": [],
    "endpoint-junction": [],
    "boundary-boundary": [],
  };
  const dedupe = new Set();
  const leakRoutes = new Map();
  for (const target of topologyContext?.targets ?? []) {
    if (!target.before) continue;
    const radius = Math.max(0, Math.min(target.before.maxRadius, target.before.requiredRadius - 1));
    leakRoutes.set(target.id, { radius, pixels: new Set(
      options.targetClosureEvaluator?.escapePath(mask, target.seedP, radius) ?? []) });
  }
  const leakScore = (candidate, id) => {
    const route = leakRoutes.get(id);
    if (!route?.pixels.size) return 0;
    const steps = Math.max(1, Math.ceil(candidate.distance));
    for (let i = 1; i < steps; i++) {
      const x = Math.round(candidate.x1 + (candidate.x2 - candidate.x1) * i / steps);
      const y = Math.round(candidate.y1 + (candidate.y2 - candidate.y1) * i / steps);
      for (let dy = -route.radius; dy <= route.radius; dy++) for (let dx = -route.radius; dx <= route.radius; dx++) {
        if (inBounds(width, height, x + dx, y + dy) && route.pixels.has(indexOf(width, x + dx, y + dy))) return 1;
      }
    }
    return 0;
  };

  const topologyMeta = p => {
    if (!topologyContext) return { id: 0, priority: 0, target: null };
    const id = topologyContext.targetMap[p] ?? 0;
    return {
      id,
      priority: topologyContext.priorityMap[p] ?? 0,
      target: id ? topologyContext.targetById.get(id) ?? null : null,
    };
  };

  const addCandidate = candidate => {
    const sourceMeta = topologyMeta(candidate.sourceP);
    const targetMeta = topologyMeta(candidate.targetP);
    const sourceIds = topologyContext?.targetMemberships?.get(candidate.sourceP) ?? new Set(sourceMeta.id ? [sourceMeta.id] : []);
    const targetIds = topologyContext?.targetMemberships?.get(candidate.targetP) ?? new Set(targetMeta.id ? [targetMeta.id] : []);
    const commonIds = [...sourceIds].filter(id => targetIds.has(id));
    if (requireTopologyTarget && !commonIds.length) return;
    const assignments = candidate.forcedTopologyTargetId
      ? commonIds.filter(id => id === candidate.forcedTopologyTargetId)
      : commonIds.length ? commonIds : [sourceMeta.id || targetMeta.id || 0];
    for (const topologyTargetId of assignments) {
    const topologyTarget = topologyTargetId
      ? topologyContext?.targetById.get(topologyTargetId) ?? null
      : null;
    const targetKey = candidate.targetNodeId != null
      ? `n${candidate.targetNodeId}`
      : `p${candidate.targetP}`;
    const key = `${candidate.sourceNodeId}->${targetKey}@${topologyTargetId}`;
    if (dedupe.has(key)) continue;
    dedupe.add(key);
    const enriched = {
      ...candidate,
      topologyTargetId: topologyTargetId || null,
      leakRouteScore: leakScore(candidate, topologyTargetId),
      topologyPriority: topologyTarget?.priority ?? Math.max(sourceMeta.priority, targetMeta.priority),
      topologyRequiredRadiusBefore: topologyTarget?.before?.requiredRadius ?? null,
    };
    byType[candidate.type].push(enriched);
    }
  };

  for (const source of endpoints) {
    const sourceMeta = topologyMeta(source.p);
    if (requireTopologyTarget && !sourceMeta.id) continue;
    const out = source.outward ?? estimateEndpointOutward(mask, width, height, source.p);

    for (const target of endpointIndex.query(source.x, source.y)) {
      if (target.id <= source.id) continue;
      const dx = target.x - source.x;
      const dy = target.y - source.y;
      const distance = Math.hypot(dx, dy);
      if (distance <= 1.1 || distance > maxDistance) continue;
      const v = normalized(dx, dy);
      const targetOut = target.outward ?? estimateEndpointOutward(mask, width, height, target.p);
      const facingSource = out.x * v.x + out.y * v.y;
      const facingTarget = targetOut.x * -v.x + targetOut.y * -v.y;
      if (facingSource < minFacing || facingTarget < minFacing) continue;
      addCandidate({
        type: "endpoint-endpoint",
        sourceNodeId: source.id,
        targetNodeId: target.id,
        sourceP: source.p,
        targetP: target.p,
        x1: source.x,
        y1: source.y,
        x2: target.x,
        y2: target.y,
        distance,
        facing: Math.min(facingSource, facingTarget),
        sourceOutward: out,
        targetOutward: targetOut,
      });
    }

    for (const target of junctionIndex.query(source.x, source.y)) {
      const dx = target.x - source.x;
      const dy = target.y - source.y;
      const distance = Math.hypot(dx, dy);
      if (distance <= 1.1 || distance > maxDistance) continue;
      const v = normalized(dx, dy);
      const facing = out.x * v.x + out.y * v.y;
      if (facing < minFacing) continue;
      if (!junctionAcceptsDirection(target, v.x, v.y, junctionMinAngleDeg)) continue;
      addCandidate({
        type: "endpoint-junction",
        sourceNodeId: source.id,
        targetNodeId: target.id,
        sourceP: source.p,
        targetP: target.p,
        x1: source.x,
        y1: source.y,
        x2: target.x,
        y2: target.y,
        distance,
        facing,
        sourceOutward: out,
        targetOutward: null,
      });
    }

    const nearbyBoundary = [];
    const radius = Math.ceil(maxDistance);
    for (let y = Math.max(0, source.y - radius); y <= Math.min(height - 1, source.y + radius); y += 1) {
      for (let x = Math.max(0, source.x - radius); x <= Math.min(width - 1, source.x + radius); x += 1) {
        const p = indexOf(width, x, y);
        if (!mask[p] || p === source.p) continue;
        if (graph.pixelToNode[p] >= 0) continue;
        if (graph.degree[p] !== 2) continue;
        const dx = x - source.x;
        const dy = y - source.y;
        const distance = Math.hypot(dx, dy);
        if (distance <= 2.1 || distance > maxDistance) continue;
        const v = normalized(dx, dy);
        const facing = out.x * v.x + out.y * v.y;
        if (facing < minFacing) continue;
        nearbyBoundary.push({ p, x, y, distance, facing });
      }
    }
    nearbyBoundary.sort((a, b) => b.facing - a.facing || a.distance - b.distance);
    for (const target of nearbyBoundary.slice(0, maxBoundaryTargets)) {
      addCandidate({
        type: "endpoint-boundary",
        sourceNodeId: source.id,
        targetNodeId: null,
        sourceP: source.p,
        targetP: target.p,
        x1: source.x,
        y1: source.y,
        x2: target.x,
        y2: target.y,
        distance: target.distance,
        facing: target.facing,
        sourceOutward: out,
        targetOutward: null,
      });
    }
  }

  for (const target of topologyContext?.targets ?? []) {
    const route = leakRoutes.get(target.id);
    for (const candidate of escapeBoundaryCandidates(mask, width, height,
      [...(route?.pixels ?? [])], target.id, topologyContext.targetMemberships, maxDistance)) {
      const sourceNode = graph.nodes[graph.pixelToNode[candidate.sourceP]];
      const targetNode = graph.nodes[graph.pixelToNode[candidate.targetP]];
      if (sourceNode?.type === 'endpoint') candidate.sourceNodeId = sourceNode.id;
      if (targetNode?.type === 'endpoint') candidate.targetNodeId = targetNode.id;
      addCandidate(candidate);
    }
  }

  for (const items of Object.values(byType)) {
    items.sort((a, b) =>
      (b.leakRouteScore ?? 0) - (a.leakRouteScore ?? 0)
      || (b.topologyPriority ?? 0) - (a.topologyPriority ?? 0)
      || (b.facing ?? 0) - (a.facing ?? 0)
      || a.distance - b.distance);
  }

  const selected = selectBalancedCandidates(byType, maxCandidates);
  const selectedSet = new Set(selected);
  const reserveByType = Object.fromEntries(Object.entries(byType).map(([type, items]) =>
    [type, items.filter(item => !selectedSet.has(item))]));
  selected.reserveCandidates = selectBalancedCandidates(reserveByType,
    Math.max(0, Math.min(360, Math.round(options.maxAdditionalCandidates ?? maxCandidates / 2))));
  selected.leakGuidance = { targetCount: leakRoutes.size,
    targetsWithEscapePath: [...leakRoutes.values()].filter(route => route.pixels.size).length,
    selectedOnEscapePath: selected.filter(item => item.leakRouteScore > 0).length };
  selected.generatedCountsPerTarget = Object.values(byType).flat().reduce((counts, item) => {
    const id = item.topologyTargetId;
    if (id) counts[id] = (counts[id] ?? 0) + 1;
    return counts;
  }, {});
  selected.candidateCountsByType = Object.fromEntries(
    Object.entries(byType).map(([type, items]) => [type, {
      generated: items.length,
      selected: selected.reduce((sum, item) => sum + (item.type === type ? 1 : 0), 0),
    }]),
  );
  return selected;
}

class MinHeap {
  constructor() { this.items = []; }
  push(item) {
    const items = this.items;
    items.push(item);
    let i = items.length - 1;
    while (i > 0) {
      const parent = Math.floor((i - 1) / 2);
      if (items[parent].priority <= item.priority) break;
      items[i] = items[parent];
      i = parent;
    }
    items[i] = item;
  }
  pop() {
    const items = this.items;
    if (!items.length) return null;
    const root = items[0];
    const last = items.pop();
    if (!items.length) return root;
    let i = 0;
    while (true) {
      const left = i * 2 + 1;
      const right = left + 1;
      if (left >= items.length) break;
      let child = left;
      if (right < items.length && items[right].priority < items[left].priority) child = right;
      if (items[child].priority >= last.priority) break;
      items[i] = items[child];
      i = child;
    }
    items[i] = last;
    return root;
  }
  get length() { return this.items.length; }
}

function pathPixelEvidence(p, options) {
  const direct = evidenceValue(options.boundaryProbability, p);
  const ridge = evidenceValue(options.ridge, p);
  const color = evidenceValue(options.color, p);
  const boundaryProbability = direct != null
    ? direct
    : (ridge != null || color != null)
      ? (ridge ?? 0) * 0.65 + (color ?? 0) * 0.35
      : 0.5;
  return {
    boundaryProbability,
    ridge: ridge ?? 0,
    color: color ?? 0,
    dendritePenalty: evidenceValue(options.dendritePenalty, p) ?? 0,
  };
}

function reconstructPath(parent, finalKey) {
  const pixels = [];
  let key = finalKey;
  while (key != null) {
    pixels.push(Math.floor(key / 9));
    key = parent.get(key) ?? null;
  }
  pixels.reverse();
  return pixels;
}

function findEvidencePath(mask, width, height, candidate, guard, options) {
  const maxDistance = Math.max(2, Number(options.maxSearchDistance ?? 10));
  const maxStepTurnDeg = Math.max(20, Math.min(120, Number(options.maxCurvatureDeg ?? 65)));
  const maxEndpointAngleDeg = Math.max(5, Math.min(85, Number(options.maxEndpointAngleDeg ?? 50)));
  const maxPathLength = Math.max(3, Math.ceil(
    Number(options.maxPathLength ?? Math.max(candidate.distance * 1.8 + 3, maxDistance + 2)),
  ));
  const evidenceWeight = Math.max(0, Number(options.evidenceCostWeight ?? 1.6));
  const curvatureWeight = Math.max(0, Number(options.curvatureCostWeight ?? 0.6));
  const dendriteWeight = Math.max(0, Number(options.dendriteCostWeight ?? 1.0));
  const directionWeight = Math.max(0, Number(options.directionCostWeight ?? 0.7));
  const expansion = Math.ceil(maxDistance + 2);
  const minX = Math.max(0, Math.min(candidate.x1, candidate.x2) - expansion);
  const maxX = Math.min(width - 1, Math.max(candidate.x1, candidate.x2) + expansion);
  const minY = Math.max(0, Math.min(candidate.y1, candidate.y2) - expansion);
  const maxY = Math.min(height - 1, Math.max(candidate.y1, candidate.y2) + expansion);
  const sourceP = candidate.sourceP;
  const targetP = candidate.targetP;

  const heap = new MinHeap();
  const best = new Map();
  const parent = new Map();
  const pathLength = new Map();
  const startKey = sourceP * 9 + 8;
  best.set(startKey, 0);
  pathLength.set(startKey, 0);
  heap.push({ key: startKey, p: sourceP, dir: 8, cost: 0, priority: candidate.distance * 0.25 });

  while (heap.length) {
    const current = heap.pop();
    if (!current) break;
    if ((best.get(current.key) ?? Infinity) !== current.cost) continue;
    if (current.p === targetP && current.key !== startKey) {
      if (candidate.type === "endpoint-endpoint" && current.dir < 8 && candidate.targetOutward) {
        const [dx, dy] = DIRS8[current.dir];
        const mismatch = angleDeg(dx, dy, -candidate.targetOutward.x, -candidate.targetOutward.y);
        if (mismatch > maxEndpointAngleDeg) continue;
      }
      const pixels = reconstructPath(parent, current.key);
      const interior = pixels.slice(1, -1);
      let maxTurn = 0;
      let turnSum = 0;
      let turnCount = 0;
      for (let i = 2; i < pixels.length; i += 1) {
        const a = pointFromIndex(pixels[i - 2], width);
        const b = pointFromIndex(pixels[i - 1], width);
        const c = pointFromIndex(pixels[i], width);
        const turn = angleDeg(b.x - a.x, b.y - a.y, c.x - b.x, c.y - b.y);
        maxTurn = Math.max(maxTurn, turn);
        turnSum += turn;
        turnCount += 1;
      }
      const ev = meanEvidenceForPixels(interior.length ? interior : pixels, options);
      return {
        pixels,
        interiorPixels: interior,
        cost: current.cost,
        lengthPx: Math.max(0, pixels.length - 1),
        pathEvidence: ev.boundaryProbability ?? 0.5,
        meanRidge: ev.ridge,
        meanColor: ev.color,
        meanDendritePenalty: ev.dendritePenalty,
        maxCurvatureDeg: maxTurn,
        meanCurvatureDeg: turnCount ? turnSum / turnCount : 0,
      };
    }

    const currentLength = pathLength.get(current.key) ?? 0;
    if (currentLength >= maxPathLength) continue;
    const x = current.p % width;
    const y = Math.floor(current.p / width);

    for (let dir = 0; dir < DIRS8.length; dir += 1) {
      const [dx, dy] = DIRS8[dir];
      const nx = x + dx;
      const ny = y + dy;
      if (nx < minX || nx > maxX || ny < minY || ny > maxY) continue;
      if (!inBounds(width, height, nx, ny)) continue;
      const np = indexOf(width, nx, ny);
      if (np !== targetP) {
        if (guard.protectedFrameMargin && protectedByFrame(width, height, nx, ny, guard.protectedFrameMargin)) continue;
        if (guard.negative?.[np]) continue;
        if (guard.exclusion?.[np]) continue;
        if (mask[np]) continue;
      }

      const firstMove = current.dir === 8;
      if (firstMove && candidate.sourceOutward) {
        const mismatch = angleDeg(dx, dy, candidate.sourceOutward.x, candidate.sourceOutward.y);
        if (mismatch > maxEndpointAngleDeg) continue;
      }

      let turn = 0;
      if (!firstMove) {
        const [pdx, pdy] = DIRS8[current.dir];
        turn = angleDeg(pdx, pdy, dx, dy);
        if (turn > maxStepTurnDeg) continue;
      }

      const ev = pathPixelEvidence(np, options);
      const stepDistance = dx && dy ? Math.SQRT2 : 1;
      const evidenceCost = (1 - ev.boundaryProbability) * evidenceWeight;
      const curvatureCost = (turn / 180) * curvatureWeight;
      const dendriteCost = ev.dendritePenalty * dendriteWeight;
      const directionMismatch = firstMove && candidate.sourceOutward
        ? angleDeg(dx, dy, candidate.sourceOutward.x, candidate.sourceOutward.y) / 180
        : 0;
      const nextCost = current.cost + stepDistance + evidenceCost + curvatureCost
        + dendriteCost + directionMismatch * directionWeight;
      const nextKey = np * 9 + dir;
      if (nextCost >= (best.get(nextKey) ?? Infinity)) continue;
      best.set(nextKey, nextCost);
      parent.set(nextKey, current.key);
      pathLength.set(nextKey, currentLength + 1);
      const heuristic = Math.hypot(candidate.x2 - nx, candidate.y2 - ny) * 0.25;
      heap.push({ key: nextKey, p: np, dir, cost: nextCost, priority: nextCost + heuristic });
    }
  }

  return null;
}

function localBackgroundComponents(mask, width, height, pixels, padding = 2, additions = null) {
  if (!pixels?.length) return 0;
  let minX = width - 1;
  let maxX = 0;
  let minY = height - 1;
  let maxY = 0;
  for (const p of pixels) {
    const x = p % width;
    const y = Math.floor(p / width);
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  minX = Math.max(0, minX - padding);
  maxX = Math.min(width - 1, maxX + padding);
  minY = Math.max(0, minY - padding);
  maxY = Math.min(height - 1, maxY + padding);
  const boxWidth = maxX - minX + 1;
  const boxHeight = maxY - minY + 1;
  const visited = new Uint8Array(boxWidth * boxHeight);
  const queue = new Int32Array(boxWidth * boxHeight);
  let components = 0;

  for (let by = 0; by < boxHeight; by += 1) {
    for (let bx = 0; bx < boxWidth; bx += 1) {
      const local = by * boxWidth + bx;
      const gp = indexOf(width, minX + bx, minY + by);
      if (maskAt(mask, gp, additions) || visited[local]) continue;
      components += 1;
      let head = 0;
      let tail = 0;
      visited[local] = 1;
      queue[tail++] = local;
      while (head < tail) {
        const q = queue[head++];
        const qx = q % boxWidth;
        const qy = Math.floor(q / boxWidth);
        for (const [dx, dy] of DIRS4) {
          const nx = qx + dx;
          const ny = qy + dy;
          if (nx < 0 || ny < 0 || nx >= boxWidth || ny >= boxHeight) continue;
          const nl = ny * boxWidth + nx;
          if (visited[nl]) continue;
          const ngp = indexOf(width, minX + nx, minY + ny);
          if (maskAt(mask, ngp, additions)) continue;
          visited[nl] = 1;
          queue[tail++] = nl;
        }
      }
    }
  }
  return components;
}

function pathCoordinates(path, width) {
  return (path?.pixels ?? []).map(p => pointFromIndex(p, width));
}

function countByType(items) {
  const result = {
    "endpoint-endpoint": 0,
    "endpoint-boundary": 0,
    "endpoint-junction": 0,
    "boundary-boundary": 0,
  };
  for (const item of items ?? []) {
    if (item?.type in result) result[item.type] += 1;
  }
  return result;
}

function endpointIdsForCandidate(candidate) {
  const ids = [candidate.sourceNodeId];
  if (["endpoint-endpoint", "boundary-boundary"].includes(candidate.type) && candidate.targetNodeId != null) {
    ids.push(candidate.targetNodeId);
  }
  return ids;
}

function targetKeyForCandidate(candidate) {
  return candidate.targetNodeId != null
    ? `node:${candidate.targetNodeId}`
    : `pixel:${candidate.targetP}`;
}

function bundleCompatibility(candidates, baseMask) {
  const endpointIds = new Set();
  const targetKeys = new Set();
  const additions = new Set();
  const pixels = [];
  for (const candidate of candidates) {
    for (const id of endpointIdsForCandidate(candidate)) {
      if (endpointIds.has(id)) return { compatible: false, reason: "endpoint-conflict" };
      endpointIds.add(id);
    }
    const targetKey = targetKeyForCandidate(candidate);
    if (targetKeys.has(targetKey)) return { compatible: false, reason: "target-conflict" };
    targetKeys.add(targetKey);
    for (const p of candidate.interiorPixels ?? []) {
      if (baseMask[p]) return { compatible: false, reason: "boundary-crossing" };
      if (additions.has(p)) return { compatible: false, reason: "path-overlap" };
      additions.add(p);
      pixels.push(p);
    }
  }
  return { compatible: true, endpointIds, targetKeys, additions, pixels };
}

export function bundlePool(candidates, maxCandidates) {
  const sorted = [...candidates].sort((a, b) =>
    (b.topologyContribution?.progressScore ?? 0) - (a.topologyContribution?.progressScore ?? 0)
    || b.score - a.score
    || (b.pathEvidence ?? 0) - (a.pathEvidence ?? 0)
    || a.distance - b.distance);
  // Keep alternative routes for a gap after representatives for other gaps.
  const representatives = [], alternatives = [];
  for (const candidate of sorted) {
    const pixels = new Set(candidate.interiorPixels ?? []);
    const similar = representatives.some(other => {
      const otherPixels = other.interiorPixels ?? [];
      const overlap = otherPixels.filter(p => pixels.has(p)).length;
      return overlap > 0 && overlap / Math.max(1, Math.min(pixels.size, otherPixels.length)) >= 0.6;
    });
    (similar ? alternatives : representatives).push(candidate);
  }
  const ordered = [...representatives, ...alternatives];
  const selected = [];
  const used = new Set();
  for (const type of ["endpoint-endpoint", "endpoint-boundary", "endpoint-junction", "boundary-boundary"]) {
    const index = representatives.findIndex((candidate, i) => !used.has(i) && candidate.type === type);
    if (index >= 0) {
      selected.push(ordered[index]);
      used.add(index);
    }
  }
  for (let i = 0; i < ordered.length && selected.length < maxCandidates; i += 1) {
    if (used.has(i)) continue;
    selected.push(ordered[i]);
  }
  return selected.slice(0, maxCandidates);
}

function enumerateBundles(items, maxSize, callback) {
  const chosen = [];
  let stopped = false;
  const visit = (start, size) => {
    if (stopped) return;
    if (chosen.length === size) { stopped = callback([...chosen]) === false; return; }
    for (let i = start; i <= items.length - (size - chosen.length) && !stopped; i++) {
      chosen.push(items[i]); visit(i + 1, size); chosen.pop();
    }
  };
  for (let size = 1; size <= Math.min(maxSize, items.length) && !stopped; size++) visit(0, size);
}

function bundleRank(contribution, candidates, additions) {
  const exact = Math.max(0, contribution?.exactGain ?? 0);
  const open = Math.max(0, contribution?.openGain ?? 0);
  const radius = Math.max(0, contribution?.radiusGain ?? 0);
  const weighted = Math.max(0, contribution?.weightedGain ?? 0);
  const progress = Math.max(0, contribution?.progressScore ?? 0);
  const meanEvidence = candidates.reduce((sum, item) => sum + (item.pathEvidence ?? 0), 0)
    / Math.max(1, candidates.length);
  return exact * 120
    + open * 90
    + radius * 35
    + weighted * 50
    + progress * 6
    + meanEvidence
    - candidates.length * 0.12
    - additions.size * 0.004;
}

function evaluateRepairBundle(mask, width, height, target, candidates, options, maxSplitIncrease) {
  const compatibility = bundleCompatibility(candidates, mask);
  if (!compatibility.compatible) return { accepted: false, reason: compatibility.reason };

  // Each path has already passed the local split guard individually. Re-running
  // the same guard over a box spanning several distant gaps can falsely count
  // the intended grain closure itself as an excessive split. Bundle safety is
  // therefore based on the worst individual path split plus the target-level
  // closure signature, not on a synthetic multi-gap bounding box.
  const localSplitIncrease = candidates.reduce(
    (max, candidate) => Math.max(max, candidate.localSplitIncrease ?? 0),
    0,
  );
  if (localSplitIncrease > maxSplitIncrease) {
    return { accepted: false, reason: "local-split", localSplitIncrease };
  }

  const before = targetClosureSignature(mask, width, height, target, options);
  const after = targetClosureSignature(mask, width, height, target, options, compatibility.additions);
  const contribution = targetImprovement(before, after);
  contribution.before = before;
  contribution.after = after;
  if (!contribution.improved) {
    return {
      accepted: false,
      reason: "topology-no-bundle-gain",
      contribution,
      localSplitIncrease,
    };
  }

  return {
    accepted: true,
    compatibility,
    contribution,
    localSplitIncrease,
    rank: bundleRank(contribution, candidates, compatibility.additions),
  };
}

export function findBestRepairBundle(mask, width, height, target, candidates, options, maxSplitIncrease) {
  const maxPool = Math.max(2, Math.min(10, Math.round(options.maxBundleCandidatesPerTarget ?? 6)));
  const maxSize = Math.max(1, Math.min(4, Math.round(options.maxBundleSize ?? 3)));
  let pool = bundlePool(candidates, maxPool);
  const uniqueAdditionSets = new Set();
  const budget = Math.max(1, Math.min(400, Math.round(options.maxBundleEvaluationsPerTarget ?? 200)));
  let expanded = false;
  let reused = 0;
  let tested = 0;
  let compatible = 0;
  let improving = 0;
  let best = null;
  let bestAttempt = null;

  const evaluate = bundle => {
    if (tested >= budget) return false;
    const compatibility = bundleCompatibility(bundle, mask);
    if (!compatibility.compatible) return;
    const key = [...compatibility.additions].sort((a, b) => a - b).join(',');
    if (uniqueAdditionSets.has(key)) { reused++; return; }
    uniqueAdditionSets.add(key);
    tested += 1;
    const result = evaluateRepairBundle(mask, width, height, target, bundle, options, maxSplitIncrease);
    if (result.reason !== "endpoint-conflict"
        && result.reason !== "target-conflict"
        && result.reason !== "boundary-crossing"
        && result.reason !== "path-overlap") {
      compatible += 1;
    }
    if (result.contribution) {
      const attemptScore = result.contribution.progressScore ?? 0;
      if (!bestAttempt || attemptScore > bestAttempt.progressScore
          || (attemptScore === bestAttempt.progressScore && bundle.length > bestAttempt.bundleSize)) {
        bestAttempt = {
          bundleSize: bundle.length,
          progressScore: attemptScore,
          reason: result.reason ?? null,
          contribution: result.contribution,
          types: countByType(bundle),
          additions: bundle.reduce((sum, item) => sum + (item.interiorPixels?.length ?? 0), 0),
        };
      }
    }
    if (!result.accepted) return;
    improving += 1;
    const candidate = {
      targetId: target.id,
      targetPriority: target.priority,
      candidates: bundle,
      ...result,
    };
    if (!best
        || candidate.rank > best.rank + 1e-9
        || (Math.abs(candidate.rank - best.rank) <= 1e-9
          && candidate.candidates.length < best.candidates.length)) {
      best = candidate;
    }
  };
  enumerateBundles(pool, maxSize, evaluate);
  if (!best && tested < budget) {
    const expandedPool = bundlePool(candidates, Math.min(10, Math.max(maxPool, 10)));
    const expandedSize = Math.min(4, maxSize + 1);
    if (expandedPool.length > pool.length || Math.min(expandedSize, pool.length) > Math.min(maxSize, pool.length)) {
      expanded = true;
      pool = expandedPool;
      enumerateBundles(pool, expandedSize, evaluate);
    }
  }

  return {
    best,
    stats: {
      targetId: target.id,
      poolSize: pool.length,
      inputCandidateCount: candidates.length,
      expanded,
      evaluationBudget: budget,
      budgetExhausted: tested >= budget,
      reusedAdditionSets: reused,
      tested,
      compatible,
      improving,
      selectedBundleSize: best?.candidates.length ?? 0,
      selectedRank: best?.rank ?? null,
      bestAttempt,
    },
  };
}

export function proposeTopologyRepairs(prediction, width, height, options = {}) {
  if (!prediction || prediction.length !== width * height) {
    throw new Error("Topology Repair v4用の境界マスクが不正です。");
  }

  options = { ...options, targetClosureEvaluator: createTargetClosureEvaluator(width, height, options) };
  const graph = buildSkeletonGraph(prediction, width, height, options);
  const topologyContext = buildTopologyTargetContext(prediction, width, height, options);
  const negativeGuardRadius = Math.max(0, Math.min(4, Math.round(options.negativeGuardRadius ?? 1)));
  const guard = {
    negative: buildGuardMask(options.negativeMask, width, height, negativeGuardRadius),
    exclusion: options.exclusionMask?.length === prediction.length ? options.exclusionMask : null,
    protectedFrameMargin: Math.max(0, Math.min(8, Math.round(options.protectedFrameMargin ?? 1))),
  };
  const minPathEvidence = clamp01(options.minPathEvidence ?? 0.32);
  const maxAcceptedRepairs = Math.max(1, Math.min(1000, Math.round(options.maxAcceptedRepairs ?? 240)));
  const maxSplitIncrease = Math.max(0, Math.min(4, Math.round(options.maxLocalSplitIncrease ?? 1)));
  const sourceCandidates = candidateGeometry(graph, prediction, width, height, options, topologyContext);
  const candidateCountsByType = sourceCandidates.candidateCountsByType ?? {};
  const viable = [];
  const reviewCandidates = [];
  const rejected = {
    noPath: 0,
    evidence: 0,
    curvature: 0,
    negative: 0,
    exclusion: 0,
    protectedFrame: 0,
    boundaryCrossing: 0,
    localSplit: 0,
    topologyNoGain: 0,
    topologyNoIncrementalGain: 0,
    topologyNoBundleGain: 0,
    bundleConflict: 0,
    endpointConflict: 0,
    targetConflict: 0,
    overlap: 0,
    limit: 0,
  };

  const initialCandidateCount = sourceCandidates.length;
  let additionalCandidateCount = 0;
  for (let candidateIndex = 0; candidateIndex <= sourceCandidates.length; candidateIndex++) {
    if (candidateIndex === initialCandidateCount) {
      const improvingTargets = new Set(viable.filter(item => item.topologyContribution?.improved).map(item => item.topologyTargetId));
      const extra = (sourceCandidates.reserveCandidates ?? []).filter(item =>
        item.topologyTargetId && !improvingTargets.has(item.topologyTargetId));
      sourceCandidates.push(...extra);
      additionalCandidateCount = extra.length;
    }
    if (candidateIndex >= sourceCandidates.length) break;
    const candidate = sourceCandidates[candidateIndex];
    const source = pointFromIndex(candidate.sourceP, width);
    const target = pointFromIndex(candidate.targetP, width);
    if (protectedByFrame(width, height, source.x, source.y, guard.protectedFrameMargin)
        || protectedByFrame(width, height, target.x, target.y, guard.protectedFrameMargin)) {
      rejected.protectedFrame += 1;
      reviewCandidates.push({ ...candidate, disposition: "rejected-protected-frame", rejectionReason: "protected-frame" });
      continue;
    }
    if (guard.negative?.[candidate.sourceP] || guard.negative?.[candidate.targetP]) {
      rejected.negative += 1;
      reviewCandidates.push({ ...candidate, disposition: "rejected-negative", rejectionReason: "negative" });
      continue;
    }
    if (guard.exclusion?.[candidate.sourceP] || guard.exclusion?.[candidate.targetP]) {
      rejected.exclusion += 1;
      reviewCandidates.push({ ...candidate, disposition: "rejected-exclusion", rejectionReason: "exclusion" });
      continue;
    }

    const path = findEvidencePath(prediction, width, height, candidate, guard, options);
    if (!path) {
      rejected.noPath += 1;
      reviewCandidates.push({ ...candidate, disposition: "rejected-no-path", rejectionReason: "no-path" });
      continue;
    }
    if ((path.pathEvidence ?? 0) < minPathEvidence) {
      rejected.evidence += 1;
      reviewCandidates.push({
        ...candidate,
        disposition: "rejected-evidence",
        rejectionReason: "evidence",
        pathEvidence: path.pathEvidence,
        pathCoordinates: pathCoordinates(path, width),
      });
      continue;
    }
    const maxCurvature = Number(options.maxCurvatureDeg ?? 65);
    if ((path.maxCurvatureDeg ?? 0) > maxCurvature + 1e-9) {
      rejected.curvature += 1;
      reviewCandidates.push({
        ...candidate,
        disposition: "rejected-curvature",
        rejectionReason: "curvature",
        pathEvidence: path.pathEvidence,
        pathCoordinates: pathCoordinates(path, width),
      });
      continue;
    }

    const additions = new Set(path.interiorPixels);
    const localBefore = localBackgroundComponents(prediction, width, height, path.pixels, 2);
    const localAfter = localBackgroundComponents(prediction, width, height, path.pixels, 2, additions);
    const localSplitIncrease = Math.max(0, localAfter - localBefore);
    if (localSplitIncrease > maxSplitIncrease) {
      rejected.localSplit += 1;
      reviewCandidates.push({
        ...candidate,
        disposition: "rejected-local-split",
        rejectionReason: "local-split",
        localSplitIncrease,
        pathEvidence: path.pathEvidence,
        pathCoordinates: pathCoordinates(path, width),
      });
      continue;
    }

    let topologyContribution = null;
    const topologyTarget = candidate.topologyTargetId
      ? topologyContext?.targetById.get(candidate.topologyTargetId) ?? null
      : null;
    if (topologyTarget) {
      const afterTarget = targetClosureSignature(
        prediction,
        width,
        height,
        topologyTarget,
        options,
        additions,
      );
      topologyContribution = targetImprovement(topologyTarget.before, afterTarget);
      topologyContribution.before = topologyTarget.before;
      topologyContribution.after = afterTarget;
      if (!topologyContribution.improved) rejected.topologyNoGain += 1;
    }

    const distanceScore = 1 - Math.min(1, candidate.distance / Math.max(1, Number(options.maxSearchDistance ?? 10)));
    const normalizedCost = path.cost / Math.max(1, path.lengthPx);
    const topologyScore = Math.min(1, Math.max(0, topologyContribution?.progressScore ?? 0) / 4);
    const score = (path.pathEvidence ?? 0.5) * 0.42
      + clamp01(candidate.facing ?? 0) * 0.16
      + distanceScore * 0.10
      + clamp01(1 - normalizedCost / 4) * 0.07
      + topologyScore * 0.25;
    viable.push({
      ...candidate,
      ...path,
      score,
      localSplitIncrease,
      topologyContribution,
      pathCoordinates: pathCoordinates(path, width),
    });
  }

  viable.sort((a, b) =>
    (b.topologyPriority ?? 0) - (a.topologyPriority ?? 0)
    || (b.topologyContribution?.progressScore ?? 0) - (a.topologyContribution?.progressScore ?? 0)
    || b.score - a.score
    || a.distance - b.distance);

  const mask = prediction.slice();
  const repairMask = new Uint8Array(prediction.length);
  const acceptedPaths = [];
  const acceptedBundles = [];
  const usedEndpoints = new Set();
  const usedTargets = new Set();
  const bundleSearch = [];
  let addedPixels = 0;

  const acceptCandidateSet = (candidates, bundleMeta = null) => {
    const compatibility = bundleCompatibility(candidates, mask);
    if (!compatibility.compatible) {
      rejected.bundleConflict += 1;
      return false;
    }
    if ([...compatibility.endpointIds].some(id => usedEndpoints.has(id))) {
      rejected.endpointConflict += 1;
      return false;
    }
    if ([...compatibility.targetKeys].some(key => usedTargets.has(key))) {
      rejected.targetConflict += 1;
      return false;
    }
    if (acceptedPaths.length + candidates.length > maxAcceptedRepairs) {
      rejected.limit += candidates.length;
      return false;
    }

    let applied = 0;
    for (const candidate of candidates) {
      let pathAdded = 0;
      for (const p of candidate.interiorPixels ?? []) {
        if (!mask[p]) {
          mask[p] = 1;
          repairMask[p] = 1;
          pathAdded += 1;
          applied += 1;
        }
      }
      const accepted = {
        ...candidate,
        topologyContribution: bundleMeta?.contribution ?? candidate.topologyContribution ?? null,
        individualTopologyContribution: candidate.topologyContribution ?? null,
        bundleId: bundleMeta?.id ?? null,
        bundleSize: candidates.length,
        bundleRank: bundleMeta?.rank ?? null,
        addedPixels: pathAdded,
        disposition: bundleMeta ? "accepted-topology-v4-bundle" : "accepted-topology-v4",
      };
      acceptedPaths.push(accepted);
      reviewCandidates.push(accepted);
    }
    if (!applied) return false;
    for (const id of compatibility.endpointIds) usedEndpoints.add(id);
    for (const key of compatibility.targetKeys) usedTargets.add(key);
    options.targetClosureEvaluator?.invalidate(mask);
    addedPixels += applied;
    return true;
  };

  if (topologyContext?.targets?.length) {
    const byTarget = new Map();
    for (const candidate of viable) {
      if (!candidate.topologyTargetId) continue;
      const items = byTarget.get(candidate.topologyTargetId);
      if (items) items.push(candidate);
      else byTarget.set(candidate.topologyTargetId, [candidate]);
    }

    const proposedBundles = [];
    for (const [targetId, candidates] of byTarget) {
      const target = topologyContext.targetById.get(targetId);
      if (!target) continue;
      const result = findBestRepairBundle(
        prediction,
        width,
        height,
        target,
        candidates,
        options,
        maxSplitIncrease,
      );
      bundleSearch.push(result.stats);
      if (result.best) proposedBundles.push(result.best);
      else rejected.topologyNoBundleGain += 1;
    }

    proposedBundles.sort((a, b) =>
      (b.targetPriority ?? 0) - (a.targetPriority ?? 0)
      || b.rank - a.rank
      || a.candidates.length - b.candidates.length);

    let bundleSequence = 0;
    for (const proposed of proposedBundles) {
      const target = topologyContext.targetById.get(proposed.targetId);
      if (!target) continue;

      const compatibility = bundleCompatibility(proposed.candidates, mask);
      if (!compatibility.compatible) {
        rejected.bundleConflict += 1;
        continue;
      }
      if ([...compatibility.endpointIds].some(id => usedEndpoints.has(id))) {
        rejected.endpointConflict += 1;
        continue;
      }
      if ([...compatibility.targetKeys].some(key => usedTargets.has(key))) {
        rejected.targetConflict += 1;
        continue;
      }

      const reevaluated = evaluateRepairBundle(
        mask,
        width,
        height,
        target,
        proposed.candidates,
        options,
        maxSplitIncrease,
      );
      if (!reevaluated.accepted) {
        if (reevaluated.reason === "local-split") rejected.localSplit += 1;
        else if (reevaluated.reason === "topology-no-bundle-gain") rejected.topologyNoIncrementalGain += 1;
        else rejected.bundleConflict += 1;
        continue;
      }

      const bundleId = `bundle-${++bundleSequence}`;
      const beforeCount = acceptedPaths.length;
      const accepted = acceptCandidateSet(proposed.candidates, {
        id: bundleId,
        rank: reevaluated.rank,
        contribution: reevaluated.contribution,
      });
      if (!accepted) continue;

      const bundlePaths = acceptedPaths.slice(beforeCount);
      acceptedBundles.push({
        id: bundleId,
        targetId: proposed.targetId,
        size: bundlePaths.length,
        types: countByType(bundlePaths),
        addedPixels: bundlePaths.reduce((sum, item) => sum + (item.addedPixels ?? 0), 0),
        rank: reevaluated.rank,
        localSplitIncrease: reevaluated.localSplitIncrease,
        contribution: reevaluated.contribution,
      });
    }
  } else {
    for (const candidate of viable) {
      if (candidate.interiorPixels.some(p => mask[p])) {
        rejected.overlap += 1;
        continue;
      }
      acceptCandidateSet([candidate]);
    }
  }

  const baseBoundaryPixels = graph.boundaryPixels;
  const finalBoundaryPixels = mask.reduce((sum, value) => sum + (value ? 1 : 0), 0);
  let basePixelsRemovedByRepair = 0;
  for (let p = 0; p < prediction.length; p += 1) {
    if (prediction[p] && !mask[p]) basePixelsRemovedByRepair += 1;
  }

  const acceptedCountsByType = countByType(acceptedPaths);
  const topologyContributingCount = acceptedBundles.length
    ? acceptedBundles.reduce((sum, bundle) => sum + (bundle.contribution?.improved ? 1 : 0), 0)
    : acceptedPaths.reduce((sum, item) => sum + (item.topologyContribution?.improved ? 1 : 0), 0);
  const individuallyImprovingCandidateCount = viable.reduce(
    (sum, item) => sum + (item.topologyContribution?.improved ? 1 : 0),
    0,
  );

  return {
    mode: "topology-v4",
    version: 4,
    revision: "4.8-escape-boundary-generation",
    mask,
    repairMask,
    graph,
    graphSummary: compactSkeletonGraph(graph),
    repairPaths: acceptedPaths,
    acceptedPaths,
    acceptedRepairCount: acceptedPaths.length,
    acceptedBridgeCount: acceptedPaths.length,
    addedPixels,
    sourceCandidateCount: sourceCandidates.length,
    consideredCandidateCount: viable.length,
    candidateCountsByType,
    acceptedCountsByType,
    topologyContributingCount,
    individuallyImprovingCandidateCount,
    acceptedBundles,
    bundleSearch,
    leakGuidance: sourceCandidates.leakGuidance,
    adaptiveSearch: { initialCandidateCount, additionalCandidateCount },
    closureEvaluation: options.targetClosureEvaluator?.stats ?? null,
    targetDiagnostics: (topologyContext?.targets ?? []).map(target => ({
      targetId: target.id, seedP: target.seedP, coreRegionCount: target.before.coreRegionCount,
      requiredRadiusBefore: target.before.requiredRadius,
      generatedCandidates: sourceCandidates.generatedCountsPerTarget?.[target.id] ?? 0,
      selectedCandidates: sourceCandidates.filter(item => item.topologyTargetId === target.id).length,
      escapeBoundaryCandidates: sourceCandidates.filter(item => item.topologyTargetId === target.id && item.origin === 'escape-cross-section').length,
      rejectionReasons: reviewCandidates.filter(item => item.topologyTargetId === target.id && item.rejectionReason)
        .reduce((counts, item) => { counts[item.rejectionReason] = (counts[item.rejectionReason] ?? 0) + 1; return counts; }, {}),
      viableCandidates: viable.filter(item => item.topologyTargetId === target.id).length,
      individuallyImprovingCandidates: viable.filter(item => item.topologyTargetId === target.id && item.topologyContribution?.improved).length,
      bundleSearch: bundleSearch.find(item => item.targetId === target.id) ?? null,
    })),
    topologyTargets: topologyContext?.summary ?? null,
    reviewCandidates,
    rejected,
    baseBoundaryPixels,
    finalBoundaryPixels,
    basePixelsRemovedByRepair,
    preservationInvariant: basePixelsRemovedByRepair === 0,
    settings: {
      maxSearchDistance: Math.max(2, Number(options.maxSearchDistance ?? 10)),
      maxEndpointAngleDeg: Math.max(5, Math.min(85, Number(options.maxEndpointAngleDeg ?? 50))),
      junctionMinAngleDeg: Math.max(0, Math.min(90, Number(options.junctionMinAngleDeg ?? 20))),
      minPathEvidence,
      maxCurvatureDeg: Math.max(20, Math.min(120, Number(options.maxCurvatureDeg ?? 65))),
      negativeGuardRadius,
      protectedFrameMargin: guard.protectedFrameMargin,
      maxLocalSplitIncrease: maxSplitIncrease,
      maxAcceptedRepairs,
      maxCandidates: Math.max(3, Math.min(1500, Math.round(options.maxCandidates ?? 360))),
      requireTopologyTarget: Boolean(topologyContext?.targets?.length && options.requireTopologyTarget !== false),
      topologyTargetMargin: topologyContext?.summary?.targetMargin ?? null,
      topologyProbeMaxRadius: Math.max(0, Math.min(4, Math.round(options.topologyProbeMaxRadius ?? 3))),
      maxBundleCandidatesPerTarget: Math.max(2, Math.min(10, Math.round(options.maxBundleCandidatesPerTarget ?? 6))),
      maxBundleSize: Math.max(1, Math.min(4, Math.round(options.maxBundleSize ?? 3))),
    },
  };
}

export function evaluateTopologyRepairGuard(before, after, options = {}) {
  if (!before || !after) {
    return { accepted: false, stage: "input", reason: "missing-evaluation", checks: [] };
  }
  const maxRecallDrop = Math.max(0, Number(options.maxRecallDrop ?? 0.001));
  const maxLeakIncrease = Math.max(0, Number(options.maxLeakIncrease ?? 0.001));
  const maxPrecisionDrop = Math.max(0, Number(options.maxPrecisionDrop ?? 0.002));
  const checks = [];

  const beforeRecall = before.positiveRecall ?? before.metrics?.positiveRecall ?? null;
  const afterRecall = after.positiveRecall ?? after.metrics?.positiveRecall ?? null;
  if (beforeRecall != null && afterRecall != null) {
    const passed = afterRecall >= beforeRecall - maxRecallDrop;
    checks.push({ priority: 1, name: "recall", passed, before: beforeRecall, after: afterRecall });
    if (!passed) return { accepted: false, stage: "recall", reason: "recall-guard", checks };
  }

  const beforeLeak = before.macroNegativeLeakage ?? before.negativeLeakage
    ?? before.metrics?.macroNegativeLeakage ?? before.metrics?.negativeLeakage ?? null;
  const afterLeak = after.macroNegativeLeakage ?? after.negativeLeakage
    ?? after.metrics?.macroNegativeLeakage ?? after.metrics?.negativeLeakage ?? null;
  if (beforeLeak != null && afterLeak != null) {
    const passed = afterLeak <= beforeLeak + maxLeakIncrease;
    checks.push({ priority: 2, name: "negative-leakage", passed, before: beforeLeak, after: afterLeak });
    if (!passed) return { accepted: false, stage: "negative-leakage", reason: "negative-leakage-guard", checks };
  }

  const beforePrecision = before.roiPrecision ?? before.precision ?? before.roiMetrics?.precision ?? null;
  const afterPrecision = after.roiPrecision ?? after.precision ?? after.roiMetrics?.precision ?? null;
  if (beforePrecision != null && afterPrecision != null) {
    const passed = afterPrecision >= beforePrecision - maxPrecisionDrop;
    checks.push({ priority: 3, name: "verified-roi-precision", passed, before: beforePrecision, after: afterPrecision });
    if (!passed) return { accepted: false, stage: "precision", reason: "verified-roi-precision-guard", checks };
  }

  const beforeTopology = before.topology ?? before.closureProfile ?? null;
  const afterTopology = after.topology ?? after.closureProfile ?? null;
  let topologyImproved = false;
  if (beforeTopology && afterTopology) {
    const weightedGain = (afterTopology.weightedClosureScore ?? 0) - (beforeTopology.weightedClosureScore ?? 0);
    const openGain = (beforeTopology.openAfterMaxRadius ?? 0) - (afterTopology.openAfterMaxRadius ?? 0);
    const radiusGain = (beforeTopology.meanRequiredRadiusCapped ?? Infinity)
      - (afterTopology.meanRequiredRadiusCapped ?? Infinity);
    const exactGain = (afterTopology.exactClosureRate ?? afterTopology.baseClosureRate ?? 0)
      - (beforeTopology.exactClosureRate ?? beforeTopology.baseClosureRate ?? 0);
    topologyImproved = exactGain > 1e-9 || weightedGain > 0.00025 || openGain > 0 || radiusGain > 0.002;
    checks.push({
      priority: 4,
      name: "topology-improvement",
      passed: topologyImproved,
      exactGain,
      weightedGain,
      openGain,
      radiusGain,
    });
  }
  if (!topologyImproved && beforeTopology && afterTopology) {
    return { accepted: false, stage: "topology", reason: "no-topology-improvement", checks };
  }

  const beforeF1 = before.roiF1 ?? before.f1 ?? before.roiMetrics?.f1 ?? null;
  const afterF1 = after.roiF1 ?? after.f1 ?? after.roiMetrics?.f1 ?? null;
  const beforeAlignment = before.alignmentMean ?? before.metrics?.alignmentError?.mean ?? null;
  const afterAlignment = after.alignmentMean ?? after.metrics?.alignmentError?.mean ?? null;
  checks.push({
    priority: 5,
    name: "alignment-f1-tiebreak",
    passed: true,
    f1Delta: beforeF1 != null && afterF1 != null ? afterF1 - beforeF1 : null,
    alignmentDelta: beforeAlignment != null && afterAlignment != null ? afterAlignment - beforeAlignment : null,
  });

  return { accepted: true, stage: "accepted", reason: null, checks };
}
