import test from "node:test";
import assert from "node:assert/strict";
import {
  compareBoundaryMasks,
  computeFullEvaluationRoiMetrics,
  computeMultiToleranceMetrics,
} from "../src/evaluation.js";

function lineMask(width, height, y, x0 = 1, x1 = width - 2) {
  const mask = new Uint8Array(width * height);
  for (let x = x0; x <= x1; x += 1) mask[y * width + x] = 1;
  return mask;
}

test("exact boundary has Recall 1.0 at 1/2/3/4 px", () => {
  const width = 20;
  const height = 12;
  const reference = lineMask(width, height, 6);
  const prediction = reference.slice();
  const values = computeMultiToleranceMetrics(prediction, reference, width, height, {
    tolerances: [1, 2, 3, 4],
  });
  assert.deepEqual(values.map(item => item.positiveRecall), [1, 1, 1, 1]);
});

test("Unknown prediction is not counted as explicit false positive", () => {
  const width = 20;
  const height = 12;
  const reference = lineMask(width, height, 6);
  const prediction = reference.slice();
  prediction[1 * width + 1] = 1;
  const negative = new Uint8Array(width * height);

  const metrics = compareBoundaryMasks(prediction, reference, width, height, {
    tolerance: 1,
    reviewRadius: 3,
    negativeMask: negative,
  });
  assert.equal(metrics.negativePrediction, 0);
  assert.equal(metrics.negativeLeakage, 0);
  assert.equal(metrics.unknownPrediction, 1);
});

test("complete evaluation ROI reports true Precision/Recall/F1", () => {
  const width = 20;
  const height = 12;
  const reference = lineMask(width, height, 6, 4, 15);
  const prediction = reference.slice();
  const roi = computeFullEvaluationRoiMetrics(
    prediction,
    reference,
    width,
    height,
    [{ x0: 2, y0: 3, x1: 17, y1: 9 }],
    { tolerance: 1 },
  );
  assert.equal(roi.roiCount, 1);
  assert.equal(roi.precision, 1);
  assert.equal(roi.recall, 1);
  assert.equal(roi.f1, 1);
});
