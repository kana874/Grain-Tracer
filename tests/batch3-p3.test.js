import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSkeletonGraph,
  compactSkeletonGraph,
  evaluateTopologyRepairGuard,
  proposeTopologyRepairs,
} from "../src/topology-repair.js";
import { computeClosureProfile } from "../src/topology.js";

function mask(width, height) {
  return new Uint8Array(width * height);
}

function set(target, width, x, y, value = 1) {
  target[y * width + x] = value;
}

function drawLine(target, width, x1, y1, x2, y2, value = 1) {
  const steps = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1));
  for (let i = 0; i <= steps; i += 1) {
    const t = steps ? i / steps : 0;
    set(target, width, Math.round(x1 + (x2 - x1) * t), Math.round(y1 + (y2 - y1) * t), value);
  }
}

function squareGapFixture(gapPx, barrier = null) {
  const width = 40;
  const height = 40;
  const boundary = mask(width, height);
  const truth = mask(width, height);
  const probability = new Float32Array(width * height);
  probability.fill(0.02);
  const x0 = 8;
  const y0 = 8;
  const x1 = 31;
  const y1 = 31;
  drawLine(truth, width, x0, y0, x1, y0);
  drawLine(truth, width, x0, y1, x1, y1);
  drawLine(truth, width, x0, y0, x0, y1);
  drawLine(truth, width, x1, y0, x1, y1);
  boundary.set(truth);
  const cx = 20;
  const start = cx - Math.floor((gapPx - 1) / 2);
  const missing = [];
  for (let i = 0; i < gapPx; i += 1) {
    const x = start + i;
    set(boundary, width, x, y0, 0);
    missing.push(y0 * width + x);
  }
  for (let p = 0; p < truth.length; p += 1) {
    if (truth[p]) probability[p] = 0.98;
  }
  const negativeMask = mask(width, height);
  const exclusionMask = mask(width, height);
  if (barrier === "negative") missing.forEach(p => { negativeMask[p] = 1; });
  if (barrier === "exclusion") missing.forEach(p => { exclusionMask[p] = 1; });
  return { width, height, boundary, truth, probability, negativeMask, exclusionMask, missing };
}

function baseOptions(fixture) {
  return {
    boundaryProbability: fixture.probability,
    negativeMask: fixture.negativeMask,
    exclusionMask: fixture.exclusionMask,
    maxSearchDistance: 8,
    minPathEvidence: 0.75,
    maxEndpointAngleDeg: 55,
    maxCurvatureDeg: 70,
    protectedFrameMargin: 1,
    negativeGuardRadius: 0,
    maxAcceptedRepairs: 20,
  };
}

function topologyTargetOptions(fixture) {
  const closedNegativeMask = mask(fixture.width, fixture.height);
  for (let y = 11; y <= 28; y += 1) {
    for (let x = 11; x <= 28; x += 1) set(closedNegativeMask, fixture.width, x, y);
  }
  return {
    ...baseOptions(fixture),
    closedNegativeMask,
    closedNegativeSeeds: [{ x: 20, y: 20, borderAssisted: false }],
    requireTopologyTarget: true,
    topologyTargetMargin: 10,
    topologyProbeMaxRadius: 3,
    maxCandidates: 12,
  };
}

test("Skeleton Graph exposes endpoint/junction nodes and edge diagnostics", () => {
  const width = 30;
  const height = 30;
  const boundary = mask(width, height);
  drawLine(boundary, width, 15, 5, 15, 15);
  drawLine(boundary, width, 8, 15, 22, 15);
  drawLine(boundary, width, 15, 15, 15, 24);
  const graph = buildSkeletonGraph(boundary, width, height);
  assert.ok(graph.endpointCount >= 3);
  assert.ok(graph.junctionCount >= 1);
  assert.ok(graph.edgeCount >= 3);
  for (const edge of graph.edges) {
    assert.ok("startNodeId" in edge);
    assert.ok("endNodeId" in edge);
    assert.ok(Array.isArray(edge.pixels));
    assert.ok("lengthPx" in edge);
    assert.ok("meanBoundaryScore" in edge);
    assert.ok("meanRidge" in edge);
    assert.ok("meanColor" in edge);
    assert.ok("curvature" in edge);
  }
  const compact = compactSkeletonGraph(graph);
  assert.equal(compact.version, 4);
  assert.equal(compact.endpointCount, graph.endpointCount);
});

for (const gapPx of [1, 2, 3]) {
  test(`Topology Repair v4 repairs synthetic ${gapPx}px endpoint gap`, () => {
    const fixture = squareGapFixture(gapPx);
    const proposal = proposeTopologyRepairs(
      fixture.boundary,
      fixture.width,
      fixture.height,
      baseOptions(fixture),
    );
    assert.ok(proposal.acceptedRepairCount >= 1);
    assert.equal(proposal.basePixelsRemovedByRepair, 0);
    assert.equal(proposal.preservationInvariant, true);
    for (const p of fixture.missing) assert.equal(proposal.mask[p], 1);
    assert.ok(proposal.acceptedPaths.some(item => item.type === "endpoint-endpoint"));
  });
}

test("Topology-first mode targets labelled closure regions and keeps only contributing repairs", () => {
  const fixture = squareGapFixture(3);
  const proposal = proposeTopologyRepairs(
    fixture.boundary,
    fixture.width,
    fixture.height,
    topologyTargetOptions(fixture),
  );
  assert.match(proposal.revision, /^4\.3-/);
  assert.equal(proposal.topologyTargets.activeTargetCount, 1);
  assert.ok(proposal.acceptedRepairCount >= 1);
  assert.equal(proposal.topologyContributingCount, proposal.acceptedRepairCount);
  assert.ok(proposal.acceptedPaths.every(item => item.topologyTargetId != null));
  assert.ok(proposal.acceptedPaths.every(item => item.topologyContribution?.improved === true));
  for (const p of fixture.missing) assert.equal(proposal.mask[p], 1);
});

test("Bundle repair can close a target when no single candidate improves topology", () => {
  const width = 44;
  const height = 44;
  const boundary = mask(width, height);
  const truth = mask(width, height);
  const probability = new Float32Array(width * height);
  probability.fill(0.01);

  const x0 = 8;
  const y0 = 8;
  const x1 = 35;
  const y1 = 35;
  drawLine(truth, width, x0, y0, x1, y0);
  drawLine(truth, width, x0, y1, x1, y1);
  drawLine(truth, width, x0, y0, x0, y1);
  drawLine(truth, width, x1, y0, x1, y1);
  boundary.set(truth);

  const missing = [
    y0 * width + 18,
    y1 * width + 26,
  ];
  for (const p of missing) {
    boundary[p] = 0;
    probability[p] = 0.99;
  }
  for (let p = 0; p < truth.length; p += 1) {
    if (truth[p]) probability[p] = 0.99;
  }

  const closedNegativeMask = mask(width, height);
  for (let y = 11; y <= 32; y += 1) {
    for (let x = 11; x <= 32; x += 1) set(closedNegativeMask, width, x, y);
  }

  const proposal = proposeTopologyRepairs(boundary, width, height, {
    boundaryProbability: probability,
    closedNegativeMask,
    closedNegativeSeeds: [{ x: 22, y: 22, borderAssisted: false }],
    maxSearchDistance: 7,
    minPathEvidence: 0.7,
    maxEndpointAngleDeg: 60,
    maxCurvatureDeg: 75,
    negativeGuardRadius: 0,
    protectedFrameMargin: 1,
    requireTopologyTarget: true,
    topologyTargetMargin: 9,
    topologyProbeMaxRadius: 3,
    maxCandidates: 60,
    maxBundleCandidatesPerTarget: 6,
    maxBundleSize: 3,
  });

  assert.equal(proposal.topologyTargets.activeTargetCount, 1);
  assert.equal(proposal.individuallyImprovingCandidateCount, 0);
  assert.ok(proposal.acceptedBundles.length >= 1);
  assert.ok(proposal.acceptedBundles.some(bundle => bundle.size >= 2));
  assert.ok(proposal.acceptedRepairCount >= 2);
  assert.ok(proposal.acceptedPaths.every(item => item.bundleId));
  assert.ok(proposal.acceptedBundles.some(bundle => bundle.contribution?.exactGain > 0));
  for (const p of missing) assert.equal(proposal.mask[p], 1);
});

test("Repair improves exact closure and mean required radius without worsening Open@3", () => {
  const fixture = squareGapFixture(3);
  const before = computeClosureProfile(
    fixture.boundary,
    fixture.width,
    fixture.height,
    [{ x: 20, y: 20 }],
    { bridgeRadii: [0, 1, 2, 3] },
  );
  const proposal = proposeTopologyRepairs(
    fixture.boundary,
    fixture.width,
    fixture.height,
    baseOptions(fixture),
  );
  const after = computeClosureProfile(
    proposal.mask,
    fixture.width,
    fixture.height,
    [{ x: 20, y: 20 }],
    { bridgeRadii: [0, 1, 2, 3] },
  );
  const exactBefore = before.closureByBridgeRadius.find(item => item.bridgeRadius === 0);
  const exactAfter = after.closureByBridgeRadius.find(item => item.bridgeRadius === 0);
  assert.ok((exactAfter?.closureRate ?? 0) > (exactBefore?.closureRate ?? 0));
  assert.ok(after.openAfterMaxRadius <= before.openAfterMaxRadius);
  assert.ok(after.meanRequiredRadiusCapped < before.meanRequiredRadiusCapped);
});

test("A* evidence path can follow a curved high-evidence route instead of a straight low-evidence gap", () => {
  const fixture = squareGapFixture(5);
  const y = 8;
  const xStart = fixture.missing[0] % fixture.width;
  const xEnd = fixture.missing.at(-1) % fixture.width;
  for (const p of fixture.missing) fixture.probability[p] = 0.01;
  for (let x = xStart; x <= xEnd; x += 1) {
    fixture.probability[(y + 1) * fixture.width + x] = 0.99;
  }
  const proposal = proposeTopologyRepairs(
    fixture.boundary,
    fixture.width,
    fixture.height,
    {
      ...baseOptions(fixture),
      minPathEvidence: 0.70,
      maxCurvatureDeg: 90,
      evidenceCostWeight: 6,
    },
  );
  assert.ok(proposal.acceptedRepairCount >= 1);
  const path = proposal.acceptedPaths.find(item => item.type === "endpoint-endpoint");
  assert.ok(path);
  assert.ok(path.pathCoordinates.some(point => point.y > y));
});

test("Negative crossing is a hard reject", () => {
  const fixture = squareGapFixture(3, "negative");
  const proposal = proposeTopologyRepairs(
    fixture.boundary,
    fixture.width,
    fixture.height,
    baseOptions(fixture),
  );
  assert.equal(proposal.acceptedRepairCount, 0);
  for (const p of fixture.missing) assert.equal(proposal.mask[p], 0);
});

test("Exclusion crossing is a hard reject", () => {
  const fixture = squareGapFixture(3, "exclusion");
  const proposal = proposeTopologyRepairs(
    fixture.boundary,
    fixture.width,
    fixture.height,
    baseOptions(fixture),
  );
  assert.equal(proposal.acceptedRepairCount, 0);
  for (const p of fixture.missing) assert.equal(proposal.mask[p], 0);
});

test("Endpoint can repair to an existing ordinary boundary", () => {
  const width = 40;
  const height = 40;
  const boundary = mask(width, height);
  const probability = new Float32Array(width * height);
  probability.fill(0.01);
  drawLine(boundary, width, 20, 8, 20, 15);
  drawLine(boundary, width, 10, 20, 30, 20);
  for (let y = 16; y <= 19; y += 1) probability[y * width + 20] = 0.99;
  const proposal = proposeTopologyRepairs(boundary, width, height, {
    boundaryProbability: probability,
    maxSearchDistance: 8,
    minPathEvidence: 0.8,
    negativeGuardRadius: 0,
    protectedFrameMargin: 1,
  });
  assert.ok((proposal.candidateCountsByType["endpoint-boundary"]?.generated ?? 0) >= 1);
  assert.ok((proposal.candidateCountsByType["endpoint-boundary"]?.selected ?? 0) >= 1);
  assert.ok(proposal.acceptedPaths.some(item => item.type === "endpoint-boundary"));
  for (let y = 16; y <= 19; y += 1) assert.equal(proposal.mask[y * width + 20], 1);
});

test("Endpoint can repair to a junction", () => {
  const width = 40;
  const height = 40;
  const boundary = mask(width, height);
  const probability = new Float32Array(width * height);
  probability.fill(0.01);
  drawLine(boundary, width, 20, 8, 20, 15);
  drawLine(boundary, width, 11, 20, 29, 20);
  drawLine(boundary, width, 20, 20, 20, 30);
  for (let y = 16; y <= 19; y += 1) probability[y * width + 20] = 0.99;
  const proposal = proposeTopologyRepairs(boundary, width, height, {
    boundaryProbability: probability,
    maxSearchDistance: 8,
    minPathEvidence: 0.8,
    maxEndpointAngleDeg: 55,
    junctionMinAngleDeg: 15,
    negativeGuardRadius: 0,
    protectedFrameMargin: 1,
  });
  assert.ok(proposal.graph.junctionCount >= 1);
  assert.ok((proposal.candidateCountsByType["endpoint-junction"]?.generated ?? 0) >= 1);
  assert.ok((proposal.candidateCountsByType["endpoint-junction"]?.selected ?? 0) >= 1);
  assert.ok(proposal.acceptedPaths.some(item => item.type === "endpoint-junction"));
});

test("Complete T/Y-style junctions do not create unsupported repair paths", () => {
  const width = 40;
  const height = 40;
  const boundary = mask(width, height);
  const probability = new Float32Array(width * height);
  probability.fill(0.01);
  drawLine(boundary, width, 20, 7, 20, 30);
  drawLine(boundary, width, 9, 20, 31, 20);
  for (let p = 0; p < boundary.length; p += 1) {
    if (boundary[p]) probability[p] = 0.98;
  }
  const proposal = proposeTopologyRepairs(boundary, width, height, {
    boundaryProbability: probability,
    maxSearchDistance: 10,
    minPathEvidence: 0.85,
    negativeGuardRadius: 0,
    protectedFrameMargin: 1,
  });
  assert.equal(proposal.acceptedRepairCount, 0);
});

test("One endpoint is not used by multiple accepted repairs", () => {
  const width = 40;
  const height = 40;
  const boundary = mask(width, height);
  const probability = new Float32Array(width * height);
  probability.fill(0.02);
  drawLine(boundary, width, 20, 7, 20, 15);
  drawLine(boundary, width, 14, 21, 14, 31);
  drawLine(boundary, width, 26, 21, 26, 31);
  for (let y = 16; y <= 21; y += 1) {
    probability[y * width + 18] = 0.95;
    probability[y * width + 19] = 0.95;
    probability[y * width + 20] = 0.95;
    probability[y * width + 21] = 0.95;
    probability[y * width + 22] = 0.95;
  }
  const proposal = proposeTopologyRepairs(boundary, width, height, {
    boundaryProbability: probability,
    maxSearchDistance: 12,
    minPathEvidence: 0.5,
    maxEndpointAngleDeg: 70,
    maxCurvatureDeg: 90,
    negativeGuardRadius: 0,
    protectedFrameMargin: 1,
  });
  const seen = new Set();
  for (const path of proposal.acceptedPaths) {
    assert.equal(seen.has(path.sourceNodeId), false);
    seen.add(path.sourceNodeId);
    if (path.type === "endpoint-endpoint") {
      assert.equal(seen.has(path.targetNodeId), false);
      seen.add(path.targetNodeId);
    }
  }
});

test("Topology guard applies prioritized Recall/Leakage/Precision before topology gain", () => {
  const before = {
    positiveRecall: 0.82,
    macroNegativeLeakage: 0.04,
    roiPrecision: 0.37,
    roiF1: 0.50,
    topology: {
      weightedClosureScore: 0.45,
      meanRequiredRadiusCapped: 2.2,
      openAfterMaxRadius: 6,
      baseClosureRate: 0,
    },
  };
  const improved = {
    positiveRecall: 0.821,
    macroNegativeLeakage: 0.0405,
    roiPrecision: 0.369,
    roiF1: 0.501,
    topology: {
      weightedClosureScore: 0.49,
      meanRequiredRadiusCapped: 2.0,
      openAfterMaxRadius: 4,
      baseClosureRate: 0.05,
    },
  };
  assert.equal(evaluateTopologyRepairGuard(before, improved).accepted, true);

  const recallRegression = structuredClone(improved);
  recallRegression.positiveRecall = 0.80;
  const result = evaluateTopologyRepairGuard(before, recallRegression);
  assert.equal(result.accepted, false);
  assert.equal(result.stage, "recall");
});
