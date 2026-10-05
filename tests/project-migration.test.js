import test from "node:test";
import assert from "node:assert/strict";
import {
  APP_VERSION,
  PROJECT_VERSION,
  createProjectSnapshot,
  migrateProject,
  restoreReferenceMasks,
  validateProject,
} from "../src/project.js";

globalThis.btoa ??= value => Buffer.from(value, "binary").toString("base64");
globalThis.atob ??= value => Buffer.from(value, "base64").toString("binary");

function emptyProjectV1() {
  return {
    format: "graintracer-project",
    formatVersion: 1,
    appVersion: "0.3.9.2-alpha",
    algorithmVersion: "boundary-v13-precision-guide-v2",
    preview: { width: 4, height: 4, scale: 1 },
    reference: { mask: "", centerline: "" },
    nonBoundary: { mask: "", centerline: "", closedFillSeeds: [] },
    exclusionRects: [],
    fullEvaluationRois: [
      { x0: 0, y0: 0, x1: 2, y1: 2, verified: true, source: "manual" },
    ],
    history: [],
  };
}

test("v1 project migrates to current format and keeps old ROI role unset", () => {
  const migrated = migrateProject(emptyProjectV1());
  assert.equal(migrated.formatVersion, PROJECT_VERSION);
  assert.equal(migrated.imageEvaluationRole, null);
  assert.deepEqual(migrated.baselineSnapshots, []);
  assert.equal("evaluationRole" in migrated.fullEvaluationRois[0], false);
  assert.equal(validateProject(emptyProjectV1()).formatVersion, PROJECT_VERSION);
});

test("project v3 saves/restores ROI roles, image role, baseline snapshots, and classifier", () => {
  const length = 16;
  const project = createProjectSnapshot({
    source: { name: "sample.bmp", fingerprint: "abc" },
    preview: { width: 4, height: 4, scale: 1 },
    settings: {},
    referenceMask: new Uint8Array(length),
    referenceCenterline: new Uint8Array(length),
    negativeMask: new Uint8Array(length),
    manualNegativeMask: new Uint8Array(length),
    negativeCenterline: new Uint8Array(length),
    closedNegativeSeeds: [],
    exclusionRects: [],
    fullEvaluationRois: [
      { x0: 0, y0: 0, x1: 1, y1: 1, verified: true, evaluationRole: "test", source: "manual" },
    ],
    precisionGuide: null,
    localCalibration: null,
    history: [],
    imageEvaluationRole: "test",
    baselineSnapshots: [{ schema: "graintracer-baseline-v1", boundaryPixelCount: 12 }],
    classifier: { accepted: true, model: { schema: "graintracer-boundary-logreg-v1", coefficients: [1] } },
  });

  assert.equal(project.formatVersion, PROJECT_VERSION);
  assert.equal(project.appVersion, APP_VERSION);
  assert.equal(project.imageEvaluationRole, "test");
  assert.equal(project.fullEvaluationRois[0].evaluationRole, "test");
  assert.equal(project.baselineSnapshots.length, 1);
  assert.equal(project.classifier.accepted, true);
  assert.equal(project.classifier.model.schema, "graintracer-boundary-logreg-v1");

  const restored = restoreReferenceMasks(project);
  assert.equal(restored.fullEvaluationRois[0].evaluationRole, "test");
  assert.equal(restored.classifier.accepted, true);
});


test("project restore preserves persisted manual Negative mask even when centerline is empty", () => {
  const length = 16;
  const manualNegativeMask = new Uint8Array(length);
  manualNegativeMask[5] = 1;
  manualNegativeMask[6] = 1;
  manualNegativeMask[9] = 1;

  const project = createProjectSnapshot({
    source: { name: "legacy-negative.bmp", fingerprint: "negative-restore" },
    preview: { width: 4, height: 4, scale: 1 },
    settings: {},
    referenceMask: new Uint8Array(length),
    referenceCenterline: new Uint8Array(length),
    negativeMask: new Uint8Array(length),
    manualNegativeMask,
    negativeCenterline: new Uint8Array(length),
    closedNegativeSeeds: [
      { x: 2, y: 2, borderAssisted: false },
      { x: 1, y: 1, borderAssisted: true },
    ],
    exclusionRects: [],
    fullEvaluationRois: [],
    precisionGuide: null,
    localCalibration: null,
    history: [],
    imageEvaluationRole: null,
    baselineSnapshots: [],
  });

  const restored = restoreReferenceMasks(project);
  assert.equal(restored.hasStoredManualNegativeMask, true);
  assert.deepEqual([...restored.manualNegativeMask], [...manualNegativeMask]);
  assert.deepEqual([...restored.negativeMask], [...manualNegativeMask]);
  assert.notEqual(restored.manualNegativeMask, restored.negativeMask);
  assert.equal(restored.negativeCenterline.reduce((sum, value) => sum + value, 0), 0);
  assert.deepEqual(restored.closedNegativeSeeds, [
    { x: 2, y: 2, borderAssisted: false },
    { x: 1, y: 1, borderAssisted: true },
  ]);
});

test("legacy project without a stored Negative mask requests centerline reconstruction", () => {
  const project = emptyProjectV1();
  delete project.nonBoundary.mask;
  const restored = restoreReferenceMasks(project);
  assert.equal(restored.hasStoredManualNegativeMask, false);
  assert.equal(restored.manualNegativeMask.reduce((sum, value) => sum + value, 0), 0);
});
