import test from "node:test";
import assert from "node:assert/strict";
import {
  REQUIRED_MEASUREMENT_FIXTURE_NAMES,
  createMeasurementFixtures,
} from "./synthetic/measurement-fixtures.js";

function countRuns(samples) {
  let runs = 0;
  let inside = false;
  for (const value of samples) {
    if (value && !inside) runs += 1;
    inside = Boolean(value);
  }
  return runs;
}

test("measurement fixture catalog contains all Batch1 future intercept cases", () => {
  const fixtures = createMeasurementFixtures();
  assert.deepEqual(fixtures.map(item => item.name), [...REQUIRED_MEASUREMENT_FIXTURE_NAMES]);
  const square = fixtures.find(item => item.name === "square-grid");
  assert.deepEqual(square.expectedIntersections, { vertical: 3, horizontal: 3 });
});

test("continuous boundary pixels count as one intersection run", () => {
  assert.equal(countRuns([0, 0, 1, 1, 1, 0, 0, 1, 1, 0]), 2);
});
