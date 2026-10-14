import test from "node:test";
import assert from "node:assert/strict";
import { selectFeedbackSegment, buildFeedbackConnection } from "../src/feedback-learning.js";
import { createProjectSnapshot, migrateProject } from "../src/project.js";
import { createReferenceEditTracker, paintReferenceCenterlineSegment } from "../src/reference-editor.js";

test("feedback selects at most 3 adjacent pixels by default, never floods long boundaries", () => {
  const w = 100, h = 100, mask = new Uint8Array(w * h);
  for (let x = 2; x < 98; x++) mask[50 * w + x] = 1;
  const picked = selectFeedbackSegment(mask, w, h, { x: 48, y: 50 });
  assert.deepEqual(picked.indices.length, 3);
  assert.deepEqual(new Set(picked.indices).size, 3);
  assert.ok(picked.indices.every(p => p >= 0 && p < mask.length && mask[p] === 1));
  assert.equal(selectFeedbackSegment(mask, w, h, { x: 48, y: 50 }, { maxPixels: 1 }).indices.length, 1);
  assert.equal(selectFeedbackSegment(mask, w, h, { x: 48, y: 50 }, { maxPixels: 5 }).indices.length, 5);
});

test("junction click selects only the center pixel, never labels adjacent branches", () => {
  const w = 35, h = 35, mask = new Uint8Array(w * h);
  for (let x = 3; x < 32; x++) mask[17 * w + x] = 1;
  for (let y = 3; y < 32; y++) mask[y * w + 17] = 1;
  const choice = selectFeedbackSegment(mask, w, h, { x: 17, y: 17 }, { maxPixels: 9 });
  assert.deepEqual(choice.indices, [17 * w + 17]);
});

test("thick/touching lines are not traversed when clicked", () => {
  const w = 40, h = 40, mask = new Uint8Array(w * h);
  for (let x = 4; x < 36; x++) {
    mask[17 * w + x] = 1;
    mask[18 * w + x] = 1;
  }
  const choice = selectFeedbackSegment(mask, w, h, { x: 15, y: 17 }, { maxPixels: 9 });
  assert.equal(choice.indices.length, 1);
});

test("feedback snap is limited to 2px and never enters an excluded pixel", () => {
  const w = 40, h = 30, mask = new Uint8Array(w * h), excluded = new Uint8Array(w * h);
  mask[10 * w + 10] = 1;
  assert.equal(selectFeedbackSegment(mask, w, h, { x: 25, y: 25 }), null);
  assert.equal(selectFeedbackSegment(mask, w, h, { x: 14, y: 10 }), null);
  assert.equal(selectFeedbackSegment(mask, w, h, { x: 11, y: 10 }).indices.length, 1);
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

test("changing one reviewed pixel to the opposite label never erases its neighbours", () => {
  const w = 15, h = 15, mask = new Uint8Array(w * h);
  const index = (x,y) => y*w+x;
  mask[index(6,6)] = mask[index(7,6)] = mask[index(8,6)] = 1;
  const tracker = createReferenceEditTracker();
  paintReferenceCenterlineSegment(mask,w,h,{x:7,y:6},{x:7,y:6},{erase:true,eraseRadius:0},tracker);
  assert.equal(mask[index(6,6)],1);
  assert.equal(mask[index(7,6)],0);
  assert.equal(mask[index(8,6)],1);
});
