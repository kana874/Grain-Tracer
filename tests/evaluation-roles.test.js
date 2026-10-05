import test from "node:test";
import assert from "node:assert/strict";
import {
  canTuneImage,
  guardEvaluationRois,
  guardExcludedRois,
  maskExcludingRois,
  partitionEvaluationRois,
  summarizeEvaluationRoles,
  trainingEvaluationRois,
  tuningExcludedRois,
} from "../src/evaluation-roles.js";

const rois = [
  { x0: 0, y0: 0, x1: 1, y1: 1, verified: true, evaluationRole: "training" },
  { x0: 2, y0: 0, x1: 3, y1: 1, verified: true, evaluationRole: "validation" },
  { x0: 4, y0: 0, x1: 5, y1: 1, verified: true, evaluationRole: "test" },
  { x0: 0, y0: 2, x1: 1, y1: 3, verified: true },
  { x0: 2, y0: 2, x1: 3, y1: 3, verified: false, evaluationRole: "test" },
];

test("ROI roles are partitioned without mixing Test into tune/guard", () => {
  const parts = partitionEvaluationRois(rois);
  assert.equal(parts.training.length, 1);
  assert.equal(parts.validation.length, 1);
  assert.equal(parts.test.length, 1);
  assert.equal(parts.legacy.length, 1);
  assert.equal(parts.provisional.length, 1);

  const training = trainingEvaluationRois(rois);
  assert.equal(training.length, 2);
  assert.ok(training.every(roi => roi.evaluationRole !== "validation" && roi.evaluationRole !== "test"));

  const guard = guardEvaluationRois(rois);
  assert.equal(guard.length, 1);
  assert.equal(guard[0].evaluationRole, "validation");
  assert.ok(guard.every(roi => roi.evaluationRole !== "test"));
});

test("tuning exclusion masks remove Validation, Test, and provisional ROI pixels", () => {
  const width = 6;
  const height = 4;
  const source = new Uint8Array(width * height).fill(1);
  const excluded = tuningExcludedRois(rois);
  const result = maskExcludingRois(source, width, height, excluded);

  assert.equal(result[0], 1, "training ROI remains available");
  assert.equal(result[2], 0, "validation ROI is excluded from direct learning");
  assert.equal(result[4], 0, "test ROI is excluded from direct learning");
  assert.equal(result[2 * width + 2], 0, "provisional ROI is excluded");
});

test("guard exclusion removes Test but keeps Validation labels", () => {
  const width = 6;
  const height = 4;
  const source = new Uint8Array(width * height).fill(1);
  const result = maskExcludingRois(source, width, height, guardExcludedRois(rois));
  assert.equal(result[2], 1);
  assert.equal(result[4], 0);
});

test("Test images cannot be tuned", () => {
  assert.equal(canTuneImage("development"), true);
  assert.equal(canTuneImage("validation"), true);
  assert.equal(canTuneImage("test"), false);
  assert.equal(canTuneImage(null), true);
});

test("role summary preserves legacy-unassigned state", () => {
  assert.deepEqual(summarizeEvaluationRoles(rois), {
    training: 1,
    validation: 1,
    test: 1,
    legacyUnassigned: 1,
    provisional: 1,
    verifiedTotal: 4,
  });
});
