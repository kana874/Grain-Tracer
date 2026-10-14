import test from "node:test";
import assert from "node:assert/strict";
import { selectFeedbackSegment, buildFeedbackConnection } from "../src/feedback-learning.js";
import { createProjectSnapshot, migrateProject } from "../src/project.js";

test("review select chooses nearby candidate without flooding connected image", () => {
  const w = 100, h = 100, mask = new Uint8Array(w * h);
  for (let x = 2; x < 98; x++) mask[50 * w + x] = 1;
  for (let y = 2; y < 98; y++) mask[y * w + 50] = 1;
  const picked = selectFeedbackSegment(mask, w, h, { x: 48, y: 51 });
  assert.ok(picked && picked.indices.length > 0);
  assert.ok(picked.indices.length <= 120, "review never selects entire connected grain graph");
  assert.ok(picked.indices.every(p => mask[p] === 1));
  assert.ok(picked.indices.every(p => Math.hypot(p % w - picked.anchor.x, Math.floor(p / w) - picked.anchor.y) <= 12));
});

test("review does not turn unpredicted regions or exclusion into negative data", () => {
  const w = 40, h = 30, mask = new Uint8Array(w * h), excluded = new Uint8Array(w * h);
  mask[10 * w + 10] = 1;
  assert.equal(selectFeedbackSegment(mask, w, h, { x: 25, y: 25 }), null);
  excluded[10 * w + 10] = 1;
  assert.equal(selectFeedbackSegment(mask, w, h, { x: 10, y: 10 }, { exclusionMask: excluded }), null);
  assert.equal(selectFeedbackSegment(mask, w, h, { x: -100, y: 1 }), null);
});

test("missing-boundary two-point hint is bounded and refuses crossing exclusion", () => {
  const w = 60, h = 60, from = { x: 3, y: 10 }, to = { x: 45, y: 10 };
  const route = buildFeedbackConnection(from, to, w, h);
  assert.equal(route.indices[0], 10 * w + 3);
  assert.equal(route.indices.at(-1), 10 * w + 45);
  const excluded = new Uint8Array(w * h); excluded[10 * w + 20] = 1;
  assert.equal(buildFeedbackConnection(from, to, w, h, { exclusionMask: excluded }), null);
  assert.equal(buildFeedbackConnection({ x: -1, y: 0 }, to, w, h), null);
  assert.equal(buildFeedbackConnection({ x: 3, y: 10 }, { x: 3, y: 10 }, w, h), null);
  assert.equal(buildFeedbackConnection(from, to, w, h, { maxLength: 20 }), null);
});

test("feedback review log round-trips without changing legacy project format", () => {
  const length = 16;
  const feedback = [{ id: "fb-1", kind: "positive", x: 1, y: 1, pixels: 2, createdAt: "2026-10-14T00:00:00Z" }];
  const project = createProjectSnapshot({
    source: { name: "demo.bmp", fingerprint: "demo" },
    preview: { width: 4, height: 4, scale: 1 },
    settings: {},
    referenceMask: new Uint8Array(length),
    referenceCenterline: new Uint8Array(length),
    negativeMask: new Uint8Array(length),
    negativeCenterline: new Uint8Array(length),
    imageEvaluationRole: "development",
    feedbackReviews: feedback,
  });
  assert.deepEqual(migrateProject(project).feedbackReviews, feedback);
  assert.deepEqual(migrateProject({ ...project, feedbackReviews: undefined }).feedbackReviews, []);
});
