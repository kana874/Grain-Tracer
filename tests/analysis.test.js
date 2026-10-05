import test from "node:test";
import assert from "node:assert/strict";
import { buildBoundaryMask, buildRawBoundaryMask } from "../src/analysis.js";
import {
  REQUIRED_BOUNDARY_FIXTURE_NAMES,
  createBoundaryFixtures,
} from "./synthetic/boundary-fixtures.js";

function featureSetFromFixture(fixture, channel) {
  const length = fixture.width * fixture.height;
  const features = {
    width: fixture.width,
    height: fixture.height,
    dark: new Uint8Array(length),
    ridge: new Uint8Array(length),
    color: new Uint8Array(length),
    dendrite: new Uint8Array(length),
    orientation: new Uint8Array(length),
    orientationAngle: new Float32Array(length),
    featureMargins: { dark: 0, ridge: 0, color: 0, dendrite: 0 },
  };
  for (let p = 0; p < length; p += 1) {
    if (fixture.expectedBoundary[p]) features[channel][p] = 255;
  }
  return features;
}

function count(mask) {
  return mask.reduce((sum, value) => sum + (value ? 1 : 0), 0);
}

test("required Batch1 boundary fixture catalog is present", () => {
  const fixtures = createBoundaryFixtures();
  assert.deepEqual(fixtures.map(item => item.name), [...REQUIRED_BOUNDARY_FIXTURE_NAMES]);
  assert.ok(fixtures.every(item => count(item.expectedBoundary) > 0));
});

for (const [fixtureName, channel] of [
  ["dark-only", "dark"],
  ["color-only", "color"],
  ["ridge-only", "ridge"],
]) {
  test(`${fixtureName} activates the corresponding raw feature path`, () => {
    const fixture = createBoundaryFixtures().find(item => item.name === fixtureName);
    const features = featureSetFromFixture(fixture, channel);
    const raw = buildRawBoundaryMask(features, {
      sensitivity: 62,
      darkWeight: channel === "dark" ? 100 : 0,
      ridgeWeight: channel === "ridge" ? 100 : 0,
      colorWeight: channel === "color" ? 100 : 0,
      dendriteWeight: 0,
      edgeFrameGuard: 0,
    });
    assert.equal(count(raw), count(fixture.expectedBoundary));
  });
}

test("isolated dot is removed by neighbor support", async () => {
  const width = 15;
  const height = 15;
  const length = width * height;
  const ridge = new Uint8Array(length);
  ridge[7 * width + 7] = 255;
  const features = {
    width,
    height,
    dark: new Uint8Array(length),
    ridge,
    color: new Uint8Array(length),
    dendrite: new Uint8Array(length),
    orientation: new Uint8Array(length),
    orientationAngle: new Float32Array(length),
    featureMargins: { dark: 0, ridge: 0, color: 0, dendrite: 0 },
  };
  const result = await buildBoundaryMask(features, {
    sensitivity: 62,
    darkWeight: 0,
    ridgeWeight: 100,
    colorWeight: 0,
    dendriteWeight: 0,
    edgeFrameGuard: 0,
    centerlineNms: false,
    minComponent: 1,
  });
  assert.equal(count(result), 0);
});
