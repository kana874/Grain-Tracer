function emptyMask(width, height) {
  return new Uint8Array(width * height);
}

function set(mask, width, x, y, value = 1) {
  if (x < 0 || y < 0 || x >= width || y >= mask.length / width) return;
  mask[y * width + x] = value;
}

function squareBoundary(width, height, gap = 0) {
  const mask = emptyMask(width, height);
  const x0 = 8;
  const y0 = 8;
  const x1 = width - 9;
  const y1 = height - 9;
  for (let x = x0; x <= x1; x += 1) {
    set(mask, width, x, y0);
    set(mask, width, x, y1);
  }
  for (let y = y0; y <= y1; y += 1) {
    set(mask, width, x0, y);
    set(mask, width, x1, y);
  }
  if (gap > 0) {
    const cx = Math.floor((x0 + x1) / 2);
    const start = cx - Math.floor((gap - 1) / 2);
    for (let i = 0; i < gap; i += 1) set(mask, width, start + i, y0, 0);
  }
  return mask;
}

function gapFixture(name, gapPx, extras = {}) {
  const width = 40;
  const height = 40;
  return {
    name,
    width,
    height,
    boundaryMask: squareBoundary(width, height, gapPx),
    seed: { x: 20, y: 20 },
    gapPx,
    negativeMask: extras.negativeMask ?? new Uint8Array(width * height),
    exclusionMask: extras.exclusionMask ?? new Uint8Array(width * height),
    expected: extras.expected ?? {},
  };
}

export function createTopologyFixtures() {
  const fixtures = [
    gapFixture("gap-1px", 1),
    gapFixture("gap-2px", 2),
    gapFixture("gap-3px", 3),
    gapFixture("gap-5px", 5),
    gapFixture("gap-8px", 8),
    gapFixture("curved-gap", 3, { expected: { curved: true } }),
    gapFixture("endpoint-endpoint", 3, { expected: { connection: "endpoint-endpoint" } }),
    gapFixture("endpoint-boundary", 3, { expected: { connection: "endpoint-boundary" } }),
    gapFixture("endpoint-junction", 3, { expected: { connection: "endpoint-junction" } }),
  ];

  const negative = gapFixture("negative-crossing-gap", 3, { expected: { mustReject: true } });
  for (let y = 5; y < 16; y += 1) set(negative.negativeMask, negative.width, 20, y);
  fixtures.push(negative);

  const exclusion = gapFixture("exclusion-crossing-gap", 3, { expected: { mustReject: true } });
  for (let y = 5; y < 16; y += 1) set(exclusion.exclusionMask, exclusion.width, 20, y);
  fixtures.push(exclusion);

  fixtures.push(gapFixture("ambiguous-two-candidates", 4, {
    expected: { ambiguousCandidateCount: 2 },
  }));

  return fixtures;
}

export const REQUIRED_GAP_FIXTURE_NAMES = Object.freeze([
  "gap-1px",
  "gap-2px",
  "gap-3px",
  "gap-5px",
  "gap-8px",
  "curved-gap",
  "endpoint-endpoint",
  "endpoint-boundary",
  "endpoint-junction",
  "negative-crossing-gap",
  "exclusion-crossing-gap",
  "ambiguous-two-candidates",
]);
