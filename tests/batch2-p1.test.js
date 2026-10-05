import test from "node:test";
import assert from "node:assert/strict";
import {
  autoTuneBoundary,
  buildBoundaryCandidates,
} from "../src/analysis.js";
import {
  evaluateClassifierGuard,
  predictBoundaryProbability,
  trainLogisticBoundaryClassifier,
} from "../src/boundary-classifier.js";

function emptyFeatures(width, height) {
  const length = width * height;
  return {
    width,
    height,
    dark: new Uint8Array(length),
    ridge: new Uint8Array(length),
    color: new Uint8Array(length),
    dendrite: new Uint8Array(length),
    dendriteLinePenalty: new Uint8Array(length),
    dendriteCoherence: new Uint8Array(length),
    ridgeScale: new Uint8Array(length),
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
}

function line(mask, width, x0, y, x1, value = 1) {
  for (let x = x0; x <= x1; x += 1) mask[y * width + x] = value;
}

test("negative evidence suppresses an intragranular false line without removing a supported boundary", () => {
  const width = 24;
  const height = 16;
  const features = emptyFeatures(width, height);
  const trueY = 5;
  const falseY = 10;

  for (let x = 3; x <= 20; x += 1) {
    const tp = trueY * width + x;
    features.ridge[tp] = 255;
    features.color[tp] = 255;

    const fp = falseY * width + x;
    features.ridge[fp] = 255;
    features.color[fp] = 12;
    features.dendriteLinePenalty[fp] = 255;
  }

  const legacy = buildBoundaryCandidates(features, {
    sensitivity: 62,
    darkWeight: 0,
    ridgeWeight: 100,
    colorWeight: 0,
    dendriteWeight: 0,
    scoreMode: "legacy",
    edgeFrameGuard: 0,
  });
  const evidence = buildBoundaryCandidates(features, {
    sensitivity: 62,
    darkWeight: 0,
    ridgeWeight: 100,
    colorWeight: 0,
    dendriteWeight: 0,
    scoreMode: "evidence",
    negativeEvidenceWeight: 80,
    edgeFrameGuard: 0,
  });

  assert.equal(legacy.mask[trueY * width + 10], 1);
  assert.equal(legacy.mask[falseY * width + 10], 1);
  assert.equal(evidence.mask[trueY * width + 10], 1);
  assert.equal(evidence.mask[falseY * width + 10], 0);
  assert.ok(evidence.negativeEvidence[falseY * width + 10] > 0.75);
});

test("browser logistic classifier learns only supplied Positive/Negative labels", () => {
  const width = 30;
  const height = 20;
  const features = emptyFeatures(width, height);
  const positive = new Uint8Array(width * height);
  const negative = new Uint8Array(width * height);

  for (let y = 2; y < 18; y += 1) {
    for (let x = 2; x < 12; x += 1) {
      const p = y * width + x;
      positive[p] = 1;
      features.ridge[p] = 230;
      features.color[p] = 240;
      features.dendrite[p] = 210;
      features.dendriteCoherence[p] = 120;
    }
    for (let x = 18; x < 28; x += 1) {
      const p = y * width + x;
      negative[p] = 1;
      features.ridge[p] = 235;
      features.color[p] = 15;
      features.dendrite[p] = 20;
      features.dendriteLinePenalty[p] = 245;
      features.dendriteCoherence[p] = 235;
    }
  }

  const model = trainLogisticBoundaryClassifier(features, positive, negative, {
    iterations: 180,
    learningRate: 0.15,
  });
  const pBoundary = 8 * width + 6;
  const pDendrite = 8 * width + 22;

  assert.equal(model.training.unknownUsed, false);
  assert.equal(model.sampleCounts.positiveUsed, 160);
  assert.equal(model.sampleCounts.negativeUsed, 160);
  assert.ok(predictBoundaryProbability(features, pBoundary, model) > 0.8);
  assert.ok(predictBoundaryProbability(features, pDendrite, model) < 0.2);
});

test("classifier guard requires recall/F1 preservation, leakage improvement, and topology non-regression", () => {
  const baseline = {
    recall: 0.90,
    f1: 0.70,
    negativeLeakage: 0.08,
    topology: { weightedClosureScore: 0.50, openAfterMaxRadius: 4 },
  };
  const good = evaluateClassifierGuard(baseline, {
    recall: 0.895,
    f1: 0.72,
    negativeLeakage: 0.05,
    topology: { weightedClosureScore: 0.51, openAfterMaxRadius: 4 },
  });
  assert.equal(good.accepted, true);

  const bad = evaluateClassifierGuard(baseline, {
    recall: 0.84,
    f1: 0.71,
    negativeLeakage: 0.04,
    topology: { weightedClosureScore: 0.51, openAfterMaxRadius: 4 },
  });
  assert.equal(bad.accepted, false);
  assert.ok(bad.reasons.includes("validation-recall-drop"));
});

test("Auto Tune cannot trade away more than two recall points for a better F1", async () => {
  const width = 60;
  const height = 44;
  const features = emptyFeatures(width, height);
  const reference = new Uint8Array(width * height);
  const fullRoi = [{ x0: 0, y0: 0, x1: width - 1, y1: height - 1, verified: true }];

  for (const y of [8, 16, 24]) {
    line(reference, width, 5, y, 24);
    for (let x = 5; x <= 24; x += 1) features.ridge[y * width + x] = 255;
  }
  line(reference, width, 42, 34, 46);
  for (let x = 42; x <= 46; x += 1) features.ridge[34 * width + x] = 255;

  for (const y of [5, 12, 19, 27, 32, 39]) {
    for (let x = 34; x <= 38; x += 1) features.ridge[y * width + x] = 255;
  }

  const result = await autoTuneBoundary(features, reference, {
    tolerance: 0,
    fullEvaluationRois: fullRoi,
    current: {
      sensitivity: 62,
      darkWeight: 0,
      ridgeWeight: 100,
      colorWeight: 0,
      dendriteWeight: 0,
      minComponent: 1,
      centerlineNms: false,
      scoreMode: "legacy",
      negativeEvidenceWeight: 35,
    },
    maxRounds: 1,
    maxRecallDrop: 0.02,
  });

  assert.equal(result.search.recallGuard.metric, "roiRecall");
  assert.ok(result.roiMetrics.recall + 1e-9 >= result.search.recallGuard.recallFloor);
  assert.ok(
    result.roiMetrics.recall + 1e-9
      >= result.search.recallGuard.baselineRecall - 0.02,
  );
});
