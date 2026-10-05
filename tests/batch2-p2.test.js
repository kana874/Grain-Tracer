import test from "node:test";
import assert from "node:assert/strict";
import { buildBoundaryMask } from "../src/analysis.js";
import { classifyStrongWeak, trackWeakBoundaries } from "../src/hysteresis.js";

function featuresForHorizontalLine(width, height) {
  const length = width * height;
  const features = {
    width,
    height,
    dark: new Uint8Array(length),
    ridge: new Uint8Array(length),
    color: new Uint8Array(length),
    dendrite: new Uint8Array(length),
    dendriteLinePenalty: new Uint8Array(length),
    orientation: new Uint8Array(length),
    orientationAngle: new Float32Array(length),
    featureMargins: {
      dark: 0,
      ridge: 0,
      color: 0,
      dendrite: 0,
      dendriteLinePenalty: 0,
    },
  };
  features.orientationAngle.fill(Math.PI / 2); // normal vertical => tangent horizontal
  return features;
}

function markEvidence(features, x, y, ridge, color = 180) {
  const p = y * features.width + x;
  features.ridge[p] = ridge;
  features.color[p] = color;
  features.orientationAngle[p] = Math.PI / 2;
  return p;
}

test("dual threshold classifies Strong and Weak separately", () => {
  const score = new Float32Array([0.1, 0.31, 0.69, 0.71, 0.95]);
  const classified = classifyStrongWeak(score, 5, 1, {
    highThreshold: 0.70,
    lowThreshold: 0.30,
  });
  assert.deepEqual([...classified.strong], [0, 0, 0, 1, 1]);
  assert.deepEqual([...classified.weak], [0, 1, 1, 0, 0]);
});

test("Strong seed recovers a continuous weak boundary but isolated weak lines stay rejected", () => {
  const width = 20;
  const height = 10;
  const features = featuresForHorizontalLine(width, height);
  const score = new Float32Array(width * height);
  const y = 4;

  score[y * width + 2] = 0.82;
  markEvidence(features, 2, y, 230, 210);
  for (let x = 3; x <= 9; x += 1) {
    score[y * width + x] = 0.42;
    markEvidence(features, x, y, 140, 160);
  }

  for (let x = 13; x <= 17; x += 1) {
    score[(y + 2) * width + x] = 0.44;
    markEvidence(features, x, y + 2, 145, 170);
  }

  const result = trackWeakBoundaries(score, features, {
    highThreshold: 0.70,
    lowThreshold: 0.30,
    maxTrackingDistance: 10,
    maxScoreDelta: 0.45,
    minColorEvidence: 0.04,
    minRidgeEvidence: 0.05,
    maxDirectionDeltaDeg: 35,
    maxTangentMismatchDeg: 40,
    maxCurvatureDeg: 50,
  });

  for (let x = 2; x <= 9; x += 1) {
    assert.equal(result.mask[y * width + x], 1, `connected x=${x}`);
  }
  for (let x = 13; x <= 17; x += 1) {
    assert.equal(result.mask[(y + 2) * width + x], 0, `isolated x=${x}`);
  }
  assert.equal(result.diagnostics.strongCount, 1);
  assert.equal(result.diagnostics.acceptedWeakCount, 7);
});

test("Negative and Exclusion masks are hard barriers for weak tracking", () => {
  const width = 22;
  const height = 10;
  const features = featuresForHorizontalLine(width, height);
  const score = new Float32Array(width * height);
  const negative = new Uint8Array(width * height);
  const exclusion = new Uint8Array(width * height);
  const y = 4;

  score[y * width + 2] = 0.85;
  markEvidence(features, 2, y, 240, 220);
  for (let x = 3; x <= 16; x += 1) {
    score[y * width + x] = 0.43;
    markEvidence(features, x, y, 145, 170);
  }
  negative[y * width + 7] = 1;
  exclusion[y * width + 12] = 1;

  const result = trackWeakBoundaries(score, features, {
    highThreshold: 0.70,
    lowThreshold: 0.30,
    negativeMask: negative,
    exclusionMask: exclusion,
    maxTrackingDistance: 20,
    maxScoreDelta: 0.5,
    minColorEvidence: 0.04,
    minRidgeEvidence: 0.05,
  });

  assert.equal(result.mask[y * width + 6], 1);
  assert.equal(result.mask[y * width + 7], 0);
  assert.equal(result.mask[y * width + 8], 0, "tracking must not jump across Negative");
  assert.equal(result.mask[y * width + 12], 0);
});

test("direction and tangent guards reject geometrically implausible weak continuation", () => {
  const width = 14;
  const height = 10;
  const features = featuresForHorizontalLine(width, height);
  const score = new Float32Array(width * height);
  const y = 4;
  score[y * width + 2] = 0.86;
  markEvidence(features, 2, y, 245, 210);

  const next = y * width + 3;
  score[next] = 0.45;
  features.ridge[next] = 150;
  features.color[next] = 180;
  features.orientationAngle[next] = 0; // normal horizontal => tangent vertical, mismatch

  const result = trackWeakBoundaries(score, features, {
    highThreshold: 0.70,
    lowThreshold: 0.30,
    maxDirectionDeltaDeg: 25,
    maxTangentMismatchDeg: 25,
    maxScoreDelta: 0.5,
  });

  assert.equal(result.mask[next], 0);
  assert.ok(result.diagnostics.rejected.direction + result.diagnostics.rejected.tangent > 0);
});

test("tracking distance limits weak continuation length", () => {
  const width = 20;
  const height = 10;
  const features = featuresForHorizontalLine(width, height);
  const score = new Float32Array(width * height);
  const y = 4;
  score[y * width + 2] = 0.9;
  markEvidence(features, 2, y, 250, 220);
  for (let x = 3; x <= 12; x += 1) {
    score[y * width + x] = 0.45;
    markEvidence(features, x, y, 150, 180);
  }

  const result = trackWeakBoundaries(score, features, {
    highThreshold: 0.70,
    lowThreshold: 0.30,
    maxTrackingDistance: 4,
    maxScoreDelta: 0.5,
  });
  assert.equal(result.mask[y * width + 6], 1);
  assert.equal(result.mask[y * width + 7], 0);
});

test("NMS-before and NMS-after tracking paths both preserve the seeded weak line", async () => {
  const width = 28;
  const height = 14;
  const features = featuresForHorizontalLine(width, height);
  const y = 6;
  for (let x = 3; x <= 22; x += 1) {
    const value = x <= 5 ? 240 : 105;
    markEvidence(features, x, y, value, 170);
    // second row makes the fixture deliberately thick so NMS order is exercised
    markEvidence(features, x, y + 1, Math.max(0, value - 5), 165);
  }

  const common = {
    sensitivity: 62,
    darkWeight: 0,
    ridgeWeight: 100,
    colorWeight: 0,
    dendriteWeight: 0,
    scoreMode: "legacy",
    centerlineNms: true,
    minComponent: 1,
    hysteresis: {
      enabled: true,
      highThreshold: 0.70,
      lowThreshold: 0.30,
      maxTrackingDistance: 30,
      maxScoreDelta: 0.55,
      minColorEvidence: 0.04,
      minRidgeEvidence: 0.05,
      maxDirectionDeltaDeg: 35,
      maxTangentMismatchDeg: 50,
      maxCurvatureDeg: 55,
    },
  };

  const before = await buildBoundaryMask(features, {
    ...common,
    hysteresis: { ...common.hysteresis, nmsOrder: "before-tracking" },
  });
  const after = await buildBoundaryMask(features, {
    ...common,
    hysteresis: { ...common.hysteresis, nmsOrder: "after-tracking" },
  });

  const beforeCount = before.reduce((sum, value) => sum + value, 0);
  const afterCount = after.reduce((sum, value) => sum + value, 0);
  assert.ok(beforeCount > 8, `before count=${beforeCount}`);
  assert.ok(afterCount > 8, `after count=${afterCount}`);
  assert.equal(before[y * width + 10] || before[(y + 1) * width + 10], 1);
  assert.equal(after[y * width + 10] || after[(y + 1) * width + 10], 1);
});

test("a false weak line without any Strong seed is not promoted", async () => {
  const width = 26;
  const height = 12;
  const features = featuresForHorizontalLine(width, height);
  const y = 6;
  for (let x = 4; x <= 20; x += 1) markEvidence(features, x, y, 100, 180);

  const mask = await buildBoundaryMask(features, {
    sensitivity: 62,
    darkWeight: 0,
    ridgeWeight: 100,
    colorWeight: 0,
    dendriteWeight: 0,
    scoreMode: "legacy",
    centerlineNms: false,
    minComponent: 1,
    hysteresis: {
      enabled: true,
      highThreshold: 0.70,
      lowThreshold: 0.30,
      maxTrackingDistance: 30,
      maxScoreDelta: 0.5,
    },
  });

  assert.equal(mask.reduce((sum, value) => sum + value, 0), 0);
});


test("additive P2 preserves every P1 base pixel and only adds guarded weak pixels", async () => {
  const width = 24;
  const height = 12;
  const features = featuresForHorizontalLine(width, height);

  // 2x2 Strong block survives P1 neighbor-support and becomes the only seed source.
  for (const y of [5, 6]) {
    for (const x of [3, 4]) markEvidence(features, x, y, 235, 210);
  }
  // Weak continuation is below the P1 threshold (Sensitivity 62 -> 0.45)
  // but above the Hysteresis low threshold.
  for (let x = 5; x <= 11; x += 1) markEvidence(features, x, 5, 105, 175);

  const common = {
    sensitivity: 62,
    darkWeight: 0,
    ridgeWeight: 100,
    colorWeight: 0,
    dendriteWeight: 0,
    scoreMode: "legacy",
    centerlineNms: false,
    minComponent: 1,
  };

  const base = await buildBoundaryMask(features, {
    ...common,
    hysteresis: { enabled: false },
  });

  let diagnostics = null;
  const recovered = await buildBoundaryMask(features, {
    ...common,
    hysteresis: {
      enabled: true,
      highThreshold: 0.70,
      lowThreshold: 0.30,
      maxTrackingDistance: 12,
      maxScoreDelta: 0.55,
      minColorEvidence: 0.04,
      minRidgeEvidence: 0.05,
      maxDirectionDeltaDeg: 35,
      maxTangentMismatchDeg: 50,
      maxCurvatureDeg: 55,
      nmsOrder: "before-tracking",
    },
    onHysteresisDiagnostics: value => { diagnostics = value; },
  });

  let baseCount = 0;
  let recoveredCount = 0;
  for (let p = 0; p < base.length; p += 1) {
    if (base[p]) {
      baseCount += 1;
      assert.equal(recovered[p], 1, `P1 base pixel ${p} must be preserved`);
    }
    if (recovered[p]) recoveredCount += 1;
  }

  assert.ok(baseCount > 0);
  assert.ok(recoveredCount > baseCount, `base=${baseCount} final=${recoveredCount}`);
  assert.equal(diagnostics.mode, "additive-recovery");
  assert.equal(diagnostics.basePixelsRemovedByP2, 0);
  assert.equal(diagnostics.preservationInvariant, true);
  assert.equal(diagnostics.baseBoundaryPixels, baseCount);
  assert.equal(diagnostics.finalBoundaryPixels, recoveredCount);
  assert.ok(diagnostics.acceptedWeakPixels > 0);
});

test("P2 hard barriers apply only to additions and never erase an existing P1 base pixel", async () => {
  const width = 18;
  const height = 10;
  const features = featuresForHorizontalLine(width, height);
  const negative = new Uint8Array(width * height);

  for (const y of [4, 5]) {
    for (const x of [2, 3]) markEvidence(features, x, y, 235, 210);
  }
  for (let x = 4; x <= 10; x += 1) markEvidence(features, x, 4, 105, 175);
  negative[4 * width + 7] = 1;

  const common = {
    sensitivity: 62,
    darkWeight: 0,
    ridgeWeight: 100,
    colorWeight: 0,
    dendriteWeight: 0,
    scoreMode: "legacy",
    centerlineNms: false,
    minComponent: 1,
  };
  const base = await buildBoundaryMask(features, {
    ...common,
    negativeMask: negative,
    hysteresis: { enabled: false },
  });
  const finalMask = await buildBoundaryMask(features, {
    ...common,
    negativeMask: negative,
    hysteresis: {
      enabled: true,
      highThreshold: 0.70,
      lowThreshold: 0.30,
      maxTrackingDistance: 20,
      maxScoreDelta: 0.55,
      nmsOrder: "before-tracking",
    },
  });

  for (let p = 0; p < base.length; p += 1) {
    if (base[p]) assert.equal(finalMask[p], 1);
  }
  assert.equal(finalMask[4 * width + 7], 0, "new weak recovery must not enter Negative");
  assert.equal(finalMask[4 * width + 8], 0, "new weak recovery must not cross Negative");
});
