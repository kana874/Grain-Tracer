function make(name, values) {
  const expectedInteriorGrains = values.expectedInteriorGrains ?? 0;
  const expectedEdgeGrains = values.expectedEdgeGrains ?? 0;
  return {
    name,
    ...values,
    expectedInteriorGrains,
    expectedEdgeGrains,
    expectedEffectiveGrains: expectedInteriorGrains + 0.5 * expectedEdgeGrains,
  };
}

export function createMeasurementFixtures() {
  return [
    make("square-grid", {
      width: 120,
      height: 120,
      geometry: { type: "grid", cols: 4, rows: 4 },
      expectedInteriorGrains: 4,
      expectedEdgeGrains: 12,
      expectedIntersections: { vertical: 3, horizontal: 3 },
    }),
    make("rectangular-grid", {
      width: 160,
      height: 100,
      geometry: { type: "grid", cols: 5, rows: 3 },
      expectedInteriorGrains: 3,
      expectedEdgeGrains: 12,
      expectedIntersections: { vertical: 2, horizontal: 4 },
    }),
    make("hexagonal-grid", {
      width: 144,
      height: 120,
      geometry: { type: "hex-grid", columns: 4, rows: 4 },
      expectedInteriorGrains: 6,
      expectedEdgeGrains: 10,
      expectedIntersections: null,
    }),
    make("voronoi-like-cells", {
      width: 128,
      height: 128,
      geometry: { type: "voronoi-like", seedCount: 12, seed: 42 },
      expectedInteriorGrains: 6,
      expectedEdgeGrains: 6,
      expectedIntersections: null,
    }),
    make("edge-cut-grain", {
      width: 96,
      height: 96,
      geometry: { type: "edge-cut" },
      expectedInteriorGrains: 1,
      expectedEdgeGrains: 1,
      expectedIntersections: null,
    }),
    make("corner-touch-grain", {
      width: 96,
      height: 96,
      geometry: { type: "corner-touch" },
      expectedInteriorGrains: 0,
      expectedEdgeGrains: 1,
      expectedIntersections: null,
    }),
  ];
}

export const REQUIRED_MEASUREMENT_FIXTURE_NAMES = Object.freeze([
  "square-grid",
  "rectangular-grid",
  "hexagonal-grid",
  "voronoi-like-cells",
  "edge-cut-grain",
  "corner-touch-grain",
]);
