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

test("v1 project migrates to v2 and keeps old ROI role unset", () => {
  const migrated = migrateProject(emptyProjectV1());
  assert.equal(migrated.formatVersion, PROJECT_VERSION);
  assert.equal(migrated.imageEvaluationRole, null);
  assert.deepEqual(migrated.baselineSnapshots, []);
  assert.equal("evaluationRole" in migrated.fullEvaluationRois[0], false);
  assert.equal(validateProject(emptyProjectV1()).formatVersion, 2);
});

test("project v2 saves/restores ROI roles, image role, and baseline snapshots", () => {
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
  });

  assert.equal(project.formatVersion, 2);
  assert.equal(project.appVersion, APP_VERSION);
  assert.equal(project.imageEvaluationRole, "test");
  assert.equal(project.fullEvaluationRois[0].evaluationRole, "test");
  assert.equal(project.baselineSnapshots.length, 1);

  const restored = restoreReferenceMasks(project);
  assert.equal(restored.fullEvaluationRois[0].evaluationRole, "test");
});
