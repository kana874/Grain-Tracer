import test from "node:test";
import assert from "node:assert/strict";
import { computeBoundaryTopology, computeClosureProfile } from "../src/topology.js";
import {
  REQUIRED_GAP_FIXTURE_NAMES,
  createTopologyFixtures,
} from "./synthetic/topology-fixtures.js";

test("required Batch1 gap fixture catalog is present", () => {
  const fixtures = createTopologyFixtures();
  assert.deepEqual(fixtures.map(item => item.name), [...REQUIRED_GAP_FIXTURE_NAMES]);
});

test("closure profile exposes deterministic 0/1/2/3 px regression metrics", () => {
  const fixture = createTopologyFixtures().find(item => item.name === "gap-1px");
  const profile = computeClosureProfile(
    fixture.boundaryMask,
    fixture.width,
    fixture.height,
    [fixture.seed],
    { bridgeRadii: [0, 1, 2, 3] },
  );
  assert.deepEqual(profile.closureByBridgeRadius.map(item => item.bridgeRadius), [0, 1, 2, 3]);
  assert.ok("weightedClosureScore" in profile);
  assert.ok("meanRequiredRadiusCapped" in profile);
  assert.ok("openAfterMaxRadius" in profile);
});

test("Topology v3 diagnostics keep profile fields needed by Baseline", () => {
  const fixture = createTopologyFixtures().find(item => item.name === "gap-3px");
  const topology = computeBoundaryTopology(
    fixture.boundaryMask,
    fixture.width,
    fixture.height,
    [fixture.seed],
    {
      bridgeRadii: [0, 1, 2, 3],
      negativeMask: fixture.negativeMask,
      exclusionMask: fixture.exclusionMask,
    },
  );
  assert.equal(topology.version, 3);
  assert.equal(topology.regionClosure.profile.maxRadius, 3);
  assert.ok("baseClosureRate" in topology.regionClosure);
  assert.ok("openAfterMaxRadius" in topology.regionClosure.profile);
});
