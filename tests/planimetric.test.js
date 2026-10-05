import test from "node:test";
import assert from "node:assert/strict";
import {
  REQUIRED_MEASUREMENT_FIXTURE_NAMES,
  createMeasurementFixtures,
} from "./synthetic/measurement-fixtures.js";

test("measurement fixture catalog is complete", () => {
  const fixtures = createMeasurementFixtures();
  assert.deepEqual(fixtures.map(item => item.name), [...REQUIRED_MEASUREMENT_FIXTURE_NAMES]);
});

test("effective grain truth uses interior + 0.5 x edge", () => {
  for (const fixture of createMeasurementFixtures()) {
    assert.equal(
      fixture.expectedEffectiveGrains,
      fixture.expectedInteriorGrains + 0.5 * fixture.expectedEdgeGrains,
      fixture.name,
    );
  }
});

test("corner-touch grain is one edge grain counted once at 0.5", () => {
  const fixture = createMeasurementFixtures().find(item => item.name === "corner-touch-grain");
  assert.equal(fixture.expectedInteriorGrains, 0);
  assert.equal(fixture.expectedEdgeGrains, 1);
  assert.equal(fixture.expectedEffectiveGrains, 0.5);
});
