import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { APP_VERSION } from "../src/project.js";

test("Batch1-3 controls exist exactly once in index.html", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  for (const id of [
    "feedbackCanvas",
    "localAbButton",
    "localAbStatus",
    "feedbackPositiveButton",
    "feedbackNegativeButton",
    "feedbackMissingButton",
    "feedbackSelectionPixels",
    "feedbackTuneButton",
    "feedbackStatus",
    "roiRoleSelect",
    "roiRoleStatus",
    "imageEvaluationRoleSelect",
    "recordBaselineButton",
    "baselineStatus",
    "scoreMode",
    "negativeEvidenceWeight",
    "trainClassifierButton",
    "resetClassifierButton",
    "classifierStatus",
    "hysteresisEnabled",
    "hysteresisHighThreshold",
    "hysteresisLowThreshold",
    "hysteresisMaxDistance",
    "hysteresisMaxDirection",
    "hysteresisNmsOrder",
    "hysteresisStatus",
    "topologyRepairEnabled",
    "topologyRepairPreviewButton",
    "topologyRepairMaxDistance",
    "topologyRepairMinEvidence",
    "topologyRepairMaxCurvature",
    "topologyRepairStatus",
  ]) {
    const matches = html.match(new RegExp(`id=["']${id}["']`, "g")) ?? [];
    assert.equal(matches.length, 1, id);
  }
  assert.ok(html.includes(`v${APP_VERSION}`), "HTML version matches app version");
});
