import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("Batch1-3 controls exist exactly once in index.html", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  for (const id of [
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
  assert.match(html, /v0\.6\.0-alpha/);
});
