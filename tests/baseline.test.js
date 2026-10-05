import test from "node:test";
import assert from "node:assert/strict";
import { buildBaselineSnapshot } from "../src/baseline.js";

test("baseline snapshot contains every Batch1 regression metric", () => {
  const snapshot = buildBaselineSnapshot({
    sourceFingerprint: "abc",
    appVersion: "0.4.0-alpha",
    algorithmVersion: "boundary-v13-precision-guide-v2",
    multiTolerance: [1, 2, 3, 4].map(tolerance => ({ tolerance, positiveRecall: 0.9 + tolerance / 100 })),
    metrics: {
      negativeLeakage: 0.03,
      macroNegativeLeakage: 0.04,
      unknownPrediction: 17,
      alignmentError: { mean: 1.2, median: 1, p90: 3 },
    },
    fullEvaluationRoi: { roiCount: 2, precision: 0.91, recall: 0.92, f1: 0.915 },
    topology: {
      regionClosure: {
        baseClosureRate: 0.5,
        baseClosedRegions: 5,
        baseOpenRegions: 5,
        profile: {
          maxRadius: 3,
          weightedClosureScore: 0.75,
          meanRequiredRadiusCapped: 1.4,
          openAfterMaxRadius: 2,
        },
      },
    },
    boundaryPixelCount: 1234,
  });

  assert.equal(snapshot.schema, "graintracer-baseline-v1");
  assert.deepEqual(Object.keys(snapshot.positiveRecall), ["at1px", "at2px", "at3px", "at4px"]);
  assert.equal(snapshot.negativeLeakage, 0.03);
  assert.equal(snapshot.macroNegativeLeakage, 0.04);
  assert.equal(snapshot.verifiedRoi.f1, 0.915);
  assert.equal(snapshot.alignmentError.p90, 3);
  assert.equal(snapshot.topology.weightedClosureScore, 0.75);
  assert.equal(snapshot.topology.meanRequiredRadius, 1.4);
  assert.equal(snapshot.topology.openAt3, 2);
  assert.equal(snapshot.topology.exactClosureRate, 0.5);
  assert.equal(snapshot.boundaryPixelCount, 1234);
  assert.equal(snapshot.unknownPredictionCount, 17);
});
