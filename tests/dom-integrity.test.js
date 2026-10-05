import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("Batch1 controls exist exactly once in index.html", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  for (const id of [
    "roiRoleSelect",
    "roiRoleStatus",
    "imageEvaluationRoleSelect",
    "recordBaselineButton",
    "baselineStatus",
  ]) {
    const matches = html.match(new RegExp(`id=["']${id}["']`, "g")) ?? [];
    assert.equal(matches.length, 1, id);
  }
  assert.match(html, /v0\.4\.0-alpha/);
});
